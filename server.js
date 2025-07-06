// --- server.js (v19 - 後台系統與每日工作表) ---
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { google } = require('googleapis');
const line = require('@line/bot-sdk');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- 資料庫連線設定 ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
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
const translations = {
  zh: {
    options: {
        spice: { name: "辣度", none: "不辣", mild: "小辣", medium: "中辣", hot: "大辣" },
        sugar: { name: "甜度", full: "正常糖", less: "少糖", half: "半糖", quarter: "微糖", none: "無糖" },
        ice: { name: "冰塊", regular: "正常冰", less: "少冰", none: "去冰" },
        size: { name: "份量", small: "小份", large: "大份" },
    },
  },
};
function formatOrderForNotification(order) {
    let message = `🔔 新訂單通知！(單號 #${order.orderId})\n`;
    message += `桌號: ${order.tableNumber}\n`;
    message += `人數: ${order.headcount}\n`;
    message += `-------------------\n`;
    order.items.forEach(item => {
        const itemName = item.name?.zh || item.name;
        message += `‣ ${itemName} x ${item.quantity}\n`;
        if (item.notes) {
            message += `  備註: ${item.notes}\n`;
        }
    });
    message += `-------------------\n`;
    message += `總金額: NT$ ${order.totalAmount}`;
    return message;
}
async function sendLineMessage(userId, message) {
    if(!lineClient) return;
    try {
        await lineClient.pushMessage(userId, { type: 'text', text: message });
        console.log("LINE 訊息已發送至:", userId);
    } catch (error) {
        console.error("發送 LINE 訊息失敗:", error.originalError ? error.originalError.response.data : error);
    }
}
function getGoogleAuth() {
    if (!process.env.GOOGLE_CREDENTIALS_JSON) return null;
    try {
        const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
        return new google.auth.GoogleAuth({ credentials, scopes: 'https://www.googleapis.com/auth/spreadsheets' });
    } catch(e) {
        console.error("無法解析 GOOGLE_CREDENTIALS_JSON:", e);
        return null;
    }
}
async function appendOrderToGoogleSheet(orderData) {
    const auth = getGoogleAuth();
    if (!process.env.GOOGLE_SHEET_ID || !auth) {
        console.log("未設定 Google Sheet ID 或憑證，跳過寫入。");
        return;
    }
    const sheets = google.sheets({ version: 'v4', auth });
    
    // --- 【修改】建立每日工作表 ---
    const today = new Date();
    const timezoneOffset = -480; // Taiwan is UTC+8, but JS getTimezoneOffset is inverted and in minutes
    const localToday = new Date(today.getTime() - timezoneOffset * 60 * 1000);
    const sheetName = localToday.toISOString().split('T')[0]; // Format: YYYY-MM-DD

    try {
        // 檢查工作表是否存在
        const spreadsheetInfo = await sheets.spreadsheets.get({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
        });
        const sheetExists = spreadsheetInfo.data.sheets.some(s => s.properties.title === sheetName);

        // 如果工作表不存在，就建立一個新的
        if (!sheetExists) {
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId: process.env.GOOGLE_SHEET_ID,
                resource: {
                    requests: [{
                        addSheet: {
                            properties: { title: sheetName }
                        }
                    }]
                }
            });
            // 在新工作表加入標頭
            await sheets.spreadsheets.values.append({
                spreadsheetId: process.env.GOOGLE_SHEET_ID,
                range: `${sheetName}!A1`,
                valueInputOption: 'USER_ENTERED',
                resource: {
                    values: [['訂單ID', '下單時間', '桌號', '人數', '總金額', '餐點詳情']],
                },
            });
             console.log(`已建立新的每日工作表: ${sheetName}`);
        }
    } catch (err) {
        console.error("檢查或建立工作表時發生錯誤:", err);
        // 如果發生錯誤，就退回寫入預設工作表
        const fallbackSheetName = '訂單紀錄';
        console.log(`將嘗試寫入預設工作表: ${fallbackSheetName}`);
    }
    // --- 修改結束 ---
    
    const t = translations['zh']; 
    const itemDetailsString = orderData.items.map(item => {
        const name = item.name?.zh || '未知品項';
        const options = item.selectedOptions && Object.keys(item.selectedOptions).length > 0
            ? Object.entries(item.selectedOptions).map(([key, value]) => t.options[key]?.[value] || value).join(', ') 
            : '無';
        const notes = item.notes ? `備註: ${item.notes}` : '';
        return `${name} x ${item.quantity}\n選項: ${options}\n${notes}`.trim();
    }).join('\n\n');

    const values = [[
        orderData.orderId, new Date(orderData.timestamp).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
        orderData.table, orderData.headcount, orderData.total, itemDetailsString
    ]];

    await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: `${sheetName}!A:F`, // 使用動態工作表名稱
        valueInputOption: 'USER_ENTERED',
        resource: { values },
    });
    console.log(`訂單 #${orderData.orderId} 已成功寫入工作表: ${sheetName}`);
}

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
    } catch (err) {
        console.error('查詢菜單時發生錯誤', err);
        res.status(500).send('伺服器錯誤');
    }
});

app.get('/api/settings', async (req, res) => {
    try {
        const settingsResult = await pool.query('SELECT * FROM app_settings');
        const settings = settingsResult.rows.reduce((acc, row) => {
            acc[row.setting_key] = row.setting_value;
            return acc;
        }, {});
        res.json({
            isAiEnabled: settings.isAiEnabled && !!genAI,
            saveToGoogleSheet: settings.saveToGoogleSheet
        });
    } catch (err) {
        console.error('讀取設定時發生錯誤', err);
        res.status(500).json({ message: '讀取設定時發生錯誤' });
    }
});

app.post('/api/orders', async (req, res) => {
    const { tableNumber, headcount, totalAmount, items } = req.body;
    if (!tableNumber || !headcount || totalAmount === undefined || !items || !Array.isArray(items)) {
        return res.status(400).json({ message: '訂單資料不完整或格式錯誤。' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const settingsResult = await client.query("SELECT setting_value FROM app_settings WHERE setting_key = 'saveToGoogleSheet'");
        const shouldSaveToSheet = settingsResult.rows[0]?.setting_value === true;

        const orderInsertQuery = 'INSERT INTO orders (table_number, headcount, total_amount, status) VALUES ($1, $2, $3, $4) RETURNING id, created_at';
        const orderResult = await client.query(orderInsertQuery, [tableNumber, headcount, totalAmount, 'received']);
        const newOrderId = orderResult.rows[0].id;
        const orderTimestamp = orderResult.rows[0].created_at;

        for (const item of items) {
            const orderItemInsertQuery = `INSERT INTO order_items (order_id, menu_item_id, quantity, notes) VALUES ($1, $2, $3, $4)`;
            await client.query(orderItemInsertQuery, [newOrderId, item.id, item.quantity, item.notes]);
        }
        
        await client.query('COMMIT');
        
        console.log(`訂單 #${newOrderId} 已成功儲存至資料庫。`);
        
        const notificationMessage = formatOrderForNotification({ ...req.body, orderId: newOrderId });
        if (lineClient && process.env.LINE_USER_ID) {
            sendLineMessage(process.env.LINE_USER_ID, notificationMessage);
        }
        
        if (shouldSaveToSheet) {
            await appendOrderToGoogleSheet({
              orderId: newOrderId, timestamp: orderTimestamp, table: tableNumber, headcount,
              total: totalAmount, items: items 
            });
        }
        
        res.status(201).json({ message: '訂單已成功接收！', orderId: newOrderId });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('建立訂單時發生錯誤', err);
        res.status(500).json({ message: '建立訂單時伺服器發生錯誤。' });
    } finally {
        client.release();
    }
});

app.post('/api/recommendation', async (req, res) => {
    const { language, cartItems, availableItems } = req.body;
    if (!genAI) return res.status(503).json({ error: "AI 功能未啟用或設定錯誤。" });
    if (!cartItems || !availableItems) return res.status(400).json({ error: "缺少推薦所需的欄位" });
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = `You are a friendly restaurant AI assistant. The user's current language is ${language}. Please respond ONLY in ${language}. The user has these items in their cart: ${cartItems}. Based on their cart, suggest one or two additional items from the available menu. Explain briefly and enticingly why they would be a good choice. Do not suggest items already in the cart. Here is the list of available menu items to choose from: ${availableItems}. Keep the response concise, friendly, and formatted as a simple paragraph.`;
    try {
        const result = await model.generateContent(prompt);
        res.json({ recommendation: result.response.text() });
    } catch (error) {
        console.error("呼叫 Gemini API 時發生錯誤:", error);
        res.status(500).json({ error: "無法獲取 AI 推薦" });
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
            acc[row.setting_key] = row.setting_value;
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
            await client.query(
                'UPDATE app_settings SET setting_value = $1 WHERE setting_key = $2',
                [value, key]
            );
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

app.post('/api/menu_items', async (req, res) => {
    const { name, price, image, description, category, options } = req.body;
    const query = 'INSERT INTO menu_items (name, price, image, description, category, options) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *';
    const values = [name, price, image, description, category, options];
    try {
        const result = await pool.query(query, values);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('新增品項時發生錯誤:', err);
        res.status(500).json({ message: '新增品項失敗' });
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


const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`後端伺服器 (v19 - 後台系統與每日工作表) 正在 http://localhost:${PORT} 上運行`));
