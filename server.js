// --- server.js (v22 - 圖片上傳、動態公告與手續費) ---
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

// --- 服務初始化 (略)... ---
let lineClient = null; if (process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_CHANNEL_SECRET) { lineClient = new line.Client({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN, channelSecret: process.env.LINE_CHANNEL_SECRET }); console.log("LINE Bot Client 已成功初始化。"); } else { console.warn("警告：未提供 LINE Bot 金鑰，通知功能將被停用。"); }
let genAI = null; if(process.env.GEMINI_API_KEY) { genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY); console.log("Gemini AI Client 已成功初始化。"); } else { console.warn("警告：未提供 GEMINI_API_KEY，AI 推薦功能將被停用。"); }

const app = express();
app.use(cors());
app.use(express.json());

// --- 輔助函式 (略)... ---
const translations = { zh: { options: { spice: { name: "辣度", none: "不辣", mild: "小辣", medium: "中辣", hot: "大辣" }, sugar: { name: "甜度", full: "正常糖", less: "少糖", half: "半糖", quarter: "微糖", none: "無糖" }, ice: { name: "冰塊", regular: "正常冰", less: "少冰", none: "去冰" }, size: { name: "份量", small: "小份", large: "大份" }, }, }, };
function formatOrderForNotification(order) { let message = `🔔 新訂單通知！(單號 #${order.orderId})\n桌號: ${order.tableNumber}\n人數: ${order.headcount}\n-------------------\n`; order.items.forEach(item => { const itemName = item.name?.zh || item.name; message += `‣ ${itemName} x ${item.quantity}\n`; if (item.notes) { message += `  備註: ${item.notes}\n`; } }); message += `-------------------\n總金額 (含手續費): NT$ ${order.finalAmount}`; return message; }
async function sendLineMessage(userId, message) { if(!lineClient) return; try { await lineClient.pushMessage(userId, { type: 'text', text: message }); console.log("LINE 訊息已發送至:", userId); } catch (error) { console.error("發送 LINE 訊息失敗:", error.originalError ? error.originalError.response.data : error); } }
function getGoogleAuth() { if (!process.env.GOOGLE_CREDENTIALS_JSON) return null; try { const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON); return new google.auth.GoogleAuth({ credentials, scopes: 'https://www.googleapis.com/auth/spreadsheets' }); } catch(e) { console.error("無法解析 GOOGLE_CREDENTIALS_JSON:", e); return null; } }
async function appendOrderToGoogleSheet(orderData) { const auth = getGoogleAuth(); if (!process.env.GOOGLE_SHEET_ID || !auth) { console.log("未設定 Google Sheet ID 或憑證，跳過寫入。"); return; } const sheets = google.sheets({ version: 'v4', auth }); const today = new Date(); const timezoneOffset = -480; const localToday = new Date(today.getTime() - timezoneOffset * 60 * 1000); const sheetName = localToday.toISOString().split('T')[0]; try { const spreadsheetInfo = await sheets.spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID }); const sheetExists = spreadsheetInfo.data.sheets.some(s => s.properties.title === sheetName); if (!sheetExists) { await sheets.spreadsheets.batchUpdate({ spreadsheetId: process.env.GOOGLE_SHEET_ID, resource: { requests: [{ addSheet: { properties: { title: sheetName } } }] } }); await sheets.spreadsheets.values.append({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: `${sheetName}!A1`, valueInputOption: 'USER_ENTERED', resource: { values: [['訂單ID', '下單時間', '桌號', '人數', '餐點總計', '手續費', '最終金額', '餐點詳情']] } }); console.log(`已建立新的每日工作表: ${sheetName}`); } } catch (err) { console.error("檢查或建立工作表時發生錯誤:", err); } const t = translations['zh']; const itemDetailsString = orderData.items.map(item => { const name = item.name?.zh || '未知品項'; const options = item.selectedOptions && Object.keys(item.selectedOptions).length > 0 ? Object.entries(item.selectedOptions).map(([key, value]) => t.options[key]?.[value] || value).join(', ') : '無'; const notes = item.notes ? `備註: ${item.notes}` : ''; return `${name} x ${item.quantity}\n選項: ${options}\n${notes}`.trim(); }).join('\n\n'); const values = [[ orderData.orderId, new Date(orderData.timestamp).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }), orderData.table, orderData.headcount, orderData.totalAmount, orderData.fee, orderData.finalAmount, itemDetailsString ]]; await sheets.spreadsheets.values.append({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: `${sheetName}!A:F`, valueInputOption: 'USER_ENTERED', resource: { values } }); console.log(`訂單 #${orderData.orderId} 已成功寫入工作表: ${sheetName}`); }


// --- 公用 API ---

app.get('/api/menu', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM menu_items ORDER BY id');
        const menu = { limited: [], main: [], side: [], drink: [], dessert: [] };
        const formattedItems = result.rows.map(item => ({
            ...item,
            options: item.options ? item.options.split(',').filter(opt => opt) : []
        }));
        formattedItems.forEach(item => {
            if (menu[item.category]) {
                menu[item.category].push(item);
            }
        });
        res.json(menu);
    } catch (err) { res.status(500).send('伺服器錯誤'); }
});

app.get('/api/settings', async (req, res) => {
    try {
        const settingsResult = await pool.query('SELECT * FROM app_settings');
        const announcementsResult = await pool.query('SELECT * FROM announcements ORDER BY sort_order ASC');
        
        const settings = settingsResult.rows.reduce((acc, row) => {
            let value = row.setting_value;
            // 嘗試將字串轉為數字或布林值
            if (!isNaN(value)) value = Number(value);
            if (value === 'true') value = true;
            if (value === 'false') value = false;
            acc[row.setting_key] = value;
            return acc;
        }, {});

        settings.announcements = announcementsResult.rows;

        res.json({
            isAiEnabled: settings.isAiEnabled && !!genAI,
            useLogo: settings.useLogo,
            logoUrl: settings.logoUrl,
            transactionFeePercent: settings.transactionFeePercent,
            announcements: settings.announcements,
        });
    } catch (err) {
        console.error('讀取設定時發生錯誤', err);
        res.status(500).json({ message: '讀取設定時發生錯誤' });
    }
});

app.post('/api/orders', async (req, res) => {
    const { tableNumber, headcount, totalAmount, fee, finalAmount, items } = req.body;
    // ... (訂單提交邏輯，與前版類似，但增加了手續費欄位)
});

app.post('/api/recommendation', async (req, res) => {
    // ... (AI 推薦邏輯，與前版相同)
});


// --- 後台管理 API ---

app.post('/api/admin/login', (req, res) => {
    // ... (登入邏輯，與前版相同)
});

app.get('/api/admin/settings', async (req, res) => {
    // ... (讀取設定邏輯，與前版相同)
});

// 【修改】更新後台設定，現在使用 upsert 邏輯
app.put('/api/admin/settings', async (req, res) => {
    const settingsToUpdate = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const [key, value] of Object.entries(settingsToUpdate)) {
            const query = `
                INSERT INTO app_settings (setting_key, setting_value) 
                VALUES ($1, $2) 
                ON CONFLICT (setting_key) 
                DO UPDATE SET setting_value = $2;
            `;
            await client.query(query, [key, value]);
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

// 【全新】圖片上傳 API
app.post('/api/admin/upload-image', upload.single('image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }
    if (!process.env.IMGUR_CLIENT_ID) {
        return res.status(500).json({ message: '未設定 Imgur Client ID' });
    }

    try {
        const formData = new FormData();
        formData.append('image', req.file.buffer, { filename: req.file.originalname });
        formData.append('type', 'base64');

        const response = await axios.post('https://api.imgur.com/3/image', formData, {
            headers: {
                'Authorization': `Client-ID ${process.env.IMGUR_CLIENT_ID}`,
                ...formData.getHeaders()
            }
        });
        
        res.json({ imageUrl: response.data.data.link });
    } catch (error) {
        console.error('Imgur upload error:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: '圖片上傳失敗' });
    }
});


// 【全新】公告管理 API (CRUD)
app.get('/api/admin/announcements', async (req, res) => {
    const result = await pool.query('SELECT * FROM announcements ORDER BY sort_order ASC');
    res.json(result.rows);
});

app.post('/api/admin/announcements', async (req, res) => {
    const { image, text } = req.body;
    const result = await pool.query('SELECT COALESCE(MAX(sort_order), 0) as max_order FROM announcements');
    const newOrder = result.rows[0].max_order + 1;
    const insertResult = await pool.query(
        'INSERT INTO announcements (image, text, sort_order) VALUES ($1, $2, $3) RETURNING *',
        [image, text, newOrder]
    );
    res.status(201).json(insertResult.rows[0]);
});

app.put('/api/admin/announcements/:id', async (req, res) => {
    const { id } = req.params;
    const { image, text } = req.body;
    const result = await pool.query(
        'UPDATE announcements SET image = $1, text = $2 WHERE id = $3 RETURNING *',
        [image, text, id]
    );
    res.json(result.rows[0]);
});

app.delete('/api/admin/announcements/:id', async (req, res) => {
    const { id } = req.params;
    await pool.query('DELETE FROM announcements WHERE id = $1', [id]);
    res.status(204).send();
});

// 菜單品項管理 API (與前版相同，僅新增/編輯邏輯在前端改變)
app.post('/api/admin/translate-and-add-item', async (req, res) => { /* ... */ });
app.put('/api/menu_items/:id', async (req, res) => { /* ... */ });
app.delete('/api/menu_items/:id', async (req, res) => { /* ... */ });

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`後端伺服器 (v22) 正在 http://localhost:${PORT} 上運行`));
