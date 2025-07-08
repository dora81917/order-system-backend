// --- server.js (v26 - 加入 AI 請求重試機制) ---
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { google } = require('googleapis');
const line = require('@line/bot-sdk');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');
const FormData = require('form-data');
const multer = require('multer');

// --- Multer (檔案上傳中介軟體) 設定 ---
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB 檔案大小限制
});

// --- 資料庫連線設定 ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- 服務初始化 ---
let lineClient = null;
if (process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_CHANNEL_SECRET) {
    lineClient = new line.Client({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
      channelSecret: process.env.LINE_CHANNEL_SECRET,
    });
    console.log("LINE Bot Client 已成功初始化。");
} else {
    console.warn("警告：未提供 LINE Bot 金鑰，通知功能將被停用。");
}

let genAI = null;
if(process.env.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    console.log("Gemini AI Client 已成功初始化。");
} else {
    console.warn("警告：未提供 GEMINI_API_KEY，AI 推薦功能將被停用。");
}

const app = express();
app.use(cors());
app.use(express.json());

// --- 輔助函式 ---

/**
 * 【全新】帶有重試機制的 AI 內容生成函式
 * @param {GenerativeModel} model - Gemini 模型實例
 * @param {string} prompt - 要傳送給 AI 的提示
 * @param {number} retries - 最大重試次數
 * @param {number} delay - 初始延遲時間 (毫秒)
 * @returns {Promise<string>} - AI 生成的文字內容
 */
async function generateContentWithRetry(model, prompt, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            const result = await model.generateContent(prompt);
            return result.response.text();
        } catch (error) {
            // 只在收到 503 錯誤時重試
            if (error.message && error.message.includes('503')) {
                console.warn(`AI 請求失敗 (第 ${i + 1} 次)，原因：伺服器超載。將在 ${delay / 1000} 秒後重試...`);
                await new Promise(res => setTimeout(res, delay));
                delay *= 2; // 下次重試的延遲時間加倍
            } else {
                // 如果是其他錯誤，直接拋出
                throw error;
            }
        }
    }
    // 如果重試全部失敗，拋出最終錯誤
    throw new Error('AI 服務持續超載，請稍後再試。');
}

const translations = { zh: { options: { spice: { name: "辣度", none: "不辣", mild: "小辣", medium: "中辣", hot: "大辣" }, sugar: { name: "甜度", full: "正常糖", less: "少糖", half: "半糖", quarter: "微糖", none: "無糖" }, ice: { name: "冰塊", regular: "正常冰", less: "少冰", none: "去冰" }, size: { name: "份量", small: "小份", large: "大份" }, }, }, };
function formatOrderForNotification(order) { let message = `🔔 新訂單通知！(單號 #${order.orderId})\n桌號: ${order.tableNumber}\n人數: ${order.headcount}\n-------------------\n`; order.items.forEach(item => { const itemName = item.name?.zh || item.name; message += `‣ ${itemName} x ${item.quantity}\n`; if (item.notes) { message += `  備註: ${item.notes}\n`; } }); message += `-------------------\n總金額 (含手續費): NT$ ${order.finalAmount}`; return message; }
async function sendLineMessage(userId, message) { if(!lineClient) return; try { await lineClient.pushMessage(userId, { type: 'text', text: message }); console.log("LINE 訊息已發送至:", userId); } catch (error) { console.error("發送 LINE 訊息失敗:", error.originalError ? error.originalError.response.data : error); } }
function getGoogleAuth() { if (!process.env.GOOGLE_CREDENTIALS_JSON) return null; try { const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON); return new google.auth.GoogleAuth({ credentials, scopes: 'https://www.googleapis.com/auth/spreadsheets' }); } catch(e) { console.error("無法解析 GOOGLE_CREDENTIALS_JSON:", e); return null; } }
async function appendOrderToGoogleSheet(orderData) { const auth = getGoogleAuth(); if (!process.env.GOOGLE_SHEET_ID || !auth) { console.log("未設定 Google Sheet ID 或憑證，跳過寫入。"); return; } const sheets = google.sheets({ version: 'v4', auth }); const today = new Date(); const timezoneOffset = -480; const localToday = new Date(today.getTime() - timezoneOffset * 60 * 1000); const sheetName = localToday.toISOString().split('T')[0]; try { const spreadsheetInfo = await sheets.spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID }); const sheetExists = spreadsheetInfo.data.sheets.some(s => s.properties.title === sheetName); if (!sheetExists) { await sheets.spreadsheets.batchUpdate({ spreadsheetId: process.env.GOOGLE_SHEET_ID, resource: { requests: [{ addSheet: { properties: { title: sheetName } } }] } }); await sheets.spreadsheets.values.append({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: `${sheetName}!A1`, valueInputOption: 'USER_ENTERED', resource: { values: [['訂單ID', '下單時間', '桌號', '人數', '餐點總計', '手續費', '最終金額', '餐點詳情']] } }); console.log(`已建立新的每日工作表: ${sheetName}`); } } catch (err) { console.error("檢查或建立工作表時發生錯誤:", err); } const t = translations['zh']; const itemDetailsString = orderData.items.map(item => { const name = item.name?.zh || '未知品項'; const options = item.selectedOptions && Object.keys(item.selectedOptions).length > 0 ? Object.entries(item.selectedOptions).map(([key, value]) => t.options[key]?.[value] || value).join(', ') : '無'; const notes = item.notes ? `備註: ${item.notes}` : ''; return `${name} x ${item.quantity}\n選項: ${options}\n${notes}`.trim(); }).join('\n\n'); const values = [[ orderData.orderId, new Date(orderData.timestamp).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }), orderData.table, orderData.headcount, orderData.totalAmount, orderData.fee, orderData.finalAmount, itemDetailsString ]]; await sheets.spreadsheets.values.append({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: `${sheetName}!A:H`, valueInputOption: 'USER_ENTERED', resource: { values } }); console.log(`訂單 #${orderData.orderId} 已成功寫入工作表: ${sheetName}`); }

// --- API 端點 ---

app.get('/', (req, res) => {
    res.status(200).send('Backend is alive and running!');
});

app.get('/api/menu', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM menu_items ORDER BY id');
        const menu = { limited: [], main: [], side: [], drink: [], dessert: [] };
        const formattedItems = result.rows.map(item => ({ ...item, options: item.options ? item.options.split(',').filter(opt => opt) : [] }));
        formattedItems.forEach(item => {
            if (menu[item.category]) {
                menu[item.category].push(item);
            }
        });
        res.json(menu);
    } catch (err) {
        console.error('查詢菜單時發生錯誤:', err);
        res.status(500).send('伺服器錯誤');
    }
});

app.get('/api/settings', async (req, res) => {
    try {
        const settingsResult = await pool.query('SELECT * FROM app_settings');
        const announcementsResult = await pool.query('SELECT * FROM announcements ORDER BY sort_order ASC');
        const settings = settingsResult.rows.reduce((acc, row) => {
            let value = row.setting_value;
            if (row.setting_key === 'transactionFeePercent') value = Number(value);
            if (['useLogo', 'isAiEnabled', 'saveToGoogleSheet', 'saveToDatabase'].includes(row.setting_key)) value = (value === 'true');
            acc[row.setting_key] = value;
            return acc;
        }, {});
        settings.announcements = announcementsResult.rows;
        res.json(settings);
    } catch (err) {
        console.error('讀取設定時發生錯誤', err);
        res.status(500).json({ message: '讀取設定時發生錯誤' });
    }
});

app.post('/api/orders', async (req, res) => {
    const { tableNumber, headcount, totalAmount, fee, finalAmount, items } = req.body;
    if (!tableNumber || !headcount || totalAmount === undefined || !items || !Array.isArray(items)) {
        return res.status(400).json({ message: '訂單資料不完整或格式錯誤。' });
    }
    const client = await pool.connect();
    try {
        const settingsResult = await client.query("SELECT * FROM app_settings");
        const settings = settingsResult.rows.reduce((acc, row) => {
            acc[row.setting_key] = row.setting_value === 'true';
            return acc;
        }, {});
        const shouldSaveToSheet = settings.saveToGoogleSheet === true;
        const shouldSaveToDatabase = settings.saveToDatabase === true;
        if (!shouldSaveToDatabase && !shouldSaveToSheet) {
            return res.status(400).json({ message: '沒有設定任何訂單儲存方式，無法處理訂單。' });
        }
        let newOrderId = 'N/A';
        let orderTimestamp = new Date();
        if (shouldSaveToDatabase) {
            await client.query('BEGIN');
            const orderInsertQuery = 'INSERT INTO orders (table_number, headcount, total_amount, fee, final_amount, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at';
            const orderResult = await client.query(orderInsertQuery, [tableNumber, headcount, totalAmount, fee, finalAmount, 'received']);
            newOrderId = orderResult.rows[0].id;
            orderTimestamp = orderResult.rows[0].created_at;
            for (const item of items) {
                const orderItemInsertQuery = `INSERT INTO order_items (order_id, menu_item_id, quantity, notes) VALUES ($1, $2, $3, $4)`;
                await client.query(orderItemInsertQuery, [newOrderId, item.id, item.quantity, item.notes]);
            }
            await client.query('COMMIT');
            console.log(`訂單 #${newOrderId} 已成功儲存至資料庫。`);
        } else {
            newOrderId = `GS-${Date.now()}`;
        }
        const notificationMessage = formatOrderForNotification({ ...req.body, orderId: newOrderId, finalAmount });
        if (lineClient && process.env.LINE_USER_ID) {
            sendLineMessage(process.env.LINE_USER_ID, notificationMessage);
        }
        if (shouldSaveToSheet) {
            await appendOrderToGoogleSheet({ orderId: newOrderId, timestamp: orderTimestamp, table: tableNumber, headcount, totalAmount, fee, finalAmount, items });
        }
        res.status(201).json({ message: '訂單已成功接收！', orderId: newOrderId });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('建立訂單時發生錯誤', err);
        res.status(500).json({ message: '建立訂單時伺服器發生錯誤。' });
    } finally {
        if (client) client.release();
    }
});

app.post('/api/recommendation', async (req, res) => {
    const { language, cartItems, availableItems } = req.body;
    if (!genAI) return res.status(503).json({ error: "AI 功能未啟用或設定錯誤。" });
    
    let prompt;
    if (!cartItems || cartItems.length === 0) {
        prompt = `You are a friendly restaurant AI assistant. The user's current language is ${language}. Please respond ONLY in ${language}. The user's cart is empty. Please recommend 2-3 popular starting items or appetizers from the menu to get them started. Be enticing and friendly. Here is the list of available menu items to choose from: ${availableItems}.`;
    } else {
        prompt = `You are a friendly restaurant AI assistant. The user's current language is ${language}. Please respond ONLY in ${language}. The user has these items in their cart: ${cartItems}. Based on their cart, suggest one or two additional items from the available menu. Explain briefly and enticingly why they would be a good choice. Do not suggest items already in the cart. Here is the list of available menu items to choose from: ${availableItems}. Keep the response concise, friendly, and formatted as a simple paragraph.`;
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const recommendationText = await generateContentWithRetry(model, prompt);
        res.json({ recommendation: recommendationText });
    } catch (error) {
        console.error("呼叫 Gemini API 時發生錯誤:", error);
        res.status(500).json({ error: "無法獲取 AI 推薦，請稍後再試。" });
    }
});

// --- 後台管理 API ---

app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password && password === process.env.ADMIN_PASSWORD) {
        res.status(200).json({ message: '登入成功' });
    } else {
        res.status(401).json({ message: '密碼錯誤' });
    }
});

app.get('/api/admin/settings', async (req, res) => {
    try {
        const settingsResult = await pool.query('SELECT * FROM app_settings');
        const settings = settingsResult.rows.reduce((acc, row) => {
            let value = row.setting_value;
            if (row.setting_key === 'transactionFeePercent') value = Number(value);
            if (['useLogo', 'isAiEnabled', 'saveToGoogleSheet', 'saveToDatabase'].includes(row.setting_key)) value = (value === 'true');
            acc[row.setting_key] = value;
            return acc;
        }, {});
        res.json(settings);
    } catch (err) {
        res.status(500).json({ message: '讀取設定錯誤' });
    }
});

app.put('/api/admin/settings', async (req, res) => {
    const settingsToUpdate = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const [key, value] of Object.entries(settingsToUpdate)) {
            const query = `INSERT INTO app_settings (setting_key, setting_value) VALUES ($1, $2) ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2;`;
            await client.query(query, [key, String(value)]);
        }
        await client.query('COMMIT');
        res.status(200).json({ message: '設定已更新' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('更新設定時發生錯誤', err);
        res.status(500).json({ message: '更新設定時發生錯誤' });
    } finally {
        client.release();
    }
});

app.post('/api/admin/upload-image', upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');
    if (!process.env.IMGBB_API_KEY) {
        return res.status(500).json({ message: '未設定 ImgBB API 金鑰' });
    }
    try {
        const formData = new FormData();
        formData.append('image', req.file.buffer.toString('base64'));
        const response = await axios.post(`https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`, formData);
        res.json({ imageUrl: response.data.data.url });
    } catch (error) {
        console.error('ImgBB upload error:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: '圖片上傳失敗' });
    }
});

app.get('/api/admin/announcements', async (req, res) => {
    const result = await pool.query('SELECT * FROM announcements ORDER BY sort_order ASC');
    res.json(result.rows);
});
app.post('/api/admin/announcements', async (req, res) => {
    const { image, text } = req.body;
    const result = await pool.query('SELECT COALESCE(MAX(sort_order), 0) as max_order FROM announcements');
    const newOrder = result.rows[0].max_order + 1;
    const insertResult = await pool.query('INSERT INTO announcements (image, text, sort_order) VALUES ($1, $2, $3) RETURNING *', [image, text, newOrder]);
    res.status(201).json(insertResult.rows[0]);
});
app.put('/api/admin/announcements/:id', async (req, res) => {
    const { id } = req.params;
    const { image, text } = req.body;
    const result = await pool.query('UPDATE announcements SET image = $1, text = $2 WHERE id = $3 RETURNING *', [image, text, id]);
    res.json(result.rows[0]);
});
app.delete('/api/admin/announcements/:id', async (req, res) => {
    const { id } = req.params;
    await pool.query('DELETE FROM announcements WHERE id = $1', [id]);
    res.status(204).send();
});

app.post('/api/admin/translate-and-add-item', async (req, res) => {
    if (!genAI) return res.status(503).json({ message: "AI 翻譯功能未啟用。" });
    const { name_zh, description_zh, price, category, image, options } = req.body;
    if (!name_zh || !price || !category) return res.status(400).json({ message: "缺少必要欄位：中文名稱、價格、分類。" });

    let aiResponseText = "N/A";
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `Translate the following JSON object values from Traditional Chinese to English, Japanese, and Korean. Respond with ONLY a valid JSON object with keys "en", "ja", "ko".
Input: 
{
  "name": "${name_zh}",
  "description": "${description_zh || ' '}"
}
Output:`;
        
        aiResponseText = await generateContentWithRetry(model, prompt);

        const jsonMatch = aiResponseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("AI did not return a valid JSON object.");
        const jsonString = jsonMatch[0];
        const translated = JSON.parse(jsonString);

        const name = { zh: name_zh, en: translated.en?.name || name_zh, ja: translated.ja?.name || name_zh, ko: translated.ko?.name || name_zh };
        const description = { zh: description_zh, en: translated.en?.description || description_zh, ja: translated.ja?.description || description_zh, ko: translated.ko?.description || description_zh };

        const query = 'INSERT INTO menu_items (name, price, image, description, category, options) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *';
        const values = [name, price, image, description, category, options];
        
        const dbResult = await pool.query(query, values);
        res.status(201).json(dbResult.rows[0]);

    } catch (error) {
        console.error("新增餐點並翻譯時發生錯誤:", { errorMessage: error.message, originalRequestBody: req.body, aiRawResponse: aiResponseText, errorStack: error.stack });
        res.status(500).json({ message: "新增餐點失敗，請檢查後端日誌。" });
    }
});

app.put('/api/menu_items/:id', async (req, res) => {
    const { id } = req.params;
    const { name, price, image, description, category, options } = req.body;
    const query = 'UPDATE menu_items SET name=$1, price=$2, image=$3, description=$4, category=$5, options=$6 WHERE id=$7 RETURNING *';
    const values = [name, price, image, description, category, options, id];
    try {
        const result = await pool.query(query, values);
        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error('更新品項時發生錯誤:', err);
        res.status(500).json({ message: '更新品項失敗' });
    }
});

app.delete('/api/menu_items/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM order_items WHERE menu_item_id=$1', [id]);
        await pool.query('DELETE FROM menu_items WHERE id=$1', [id]);
        res.status(204).send();
    } catch (err) {
        console.error('刪除品項時發生錯誤:', err);
        res.status(500).json({ message: '刪除品項失敗' });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`後端伺服器 (v26) 正在 http://localhost:${PORT} 上運行`));
