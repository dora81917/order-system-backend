// --- server.js (v4 - 商業化功能版) ---
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- 資料庫連線設定 ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// --- AI & Google Sheets 初始化 ---
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

function getGoogleAuth() {
  if (!process.env.GOOGLE_CREDENTIALS_JSON) return null;
  return new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON),
    scopes: 'https://www.googleapis.com/auth/spreadsheets',
  });
}

const app = express();
const PORT = process.env.PORT || 8080;
app.use(cors());
app.use(express.json());

// --- API 端點 ---
app.get('/', (req, res) => res.send('後端伺服器 v4 已成功啟動！'));

// 假設 restaurantId=1
app.get('/api/settings', async (req, res) => {
    // 未來應從資料庫讀取，例如：
    // const { restaurantId } = req.query;
    // const result = await pool.query('SELECT * FROM restaurants WHERE id = $1', [restaurantId]);
    // res.json(result.rows[0].settings);
    res.json({ isAiEnabled: true, saveToGoogleSheet: true });
});

app.get('/api/menu', async (req, res) => {
    // const { restaurantId } = req.query;
    try {
        const result = await pool.query('SELECT * FROM menu_items ORDER BY category, id'); // WHERE restaurant_id = $1
        const menu = { main: [], side: [], drink: [], dessert: [] };
        result.rows.forEach(item => {
            const formattedItem = { ...item, options: item.options ? item.options.split(',') : [] };
            if (menu[item.category]) menu[item.category].push(formattedItem);
        });
        res.json(menu);
    } catch (err) {
        console.error('查詢菜單時發生錯誤', err);
        res.status(500).send('伺服器錯誤');
    }
});

app.post('/api/orders', async (req, res) => {
    const { tableNumber, headcount, totalAmount, items } = req.body; // 新增 headcount
    if (!tableNumber || !headcount || totalAmount === undefined || !items || !Array.isArray(items)) {
        return res.status(400).json({ message: '訂單資料不完整或格式錯誤。' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const orderInsertQuery = 'INSERT INTO orders (table_number, headcount, total_amount, status) VALUES ($1, $2, $3, $4) RETURNING id, created_at';
        const orderResult = await client.query(orderInsertQuery, [tableNumber, headcount, totalAmount, 'received']);
        const newOrderId = orderResult.rows[0].id;
        const orderTimestamp = orderResult.rows[0].created_at;

        for (const item of items) {
            const orderItemInsertQuery = `INSERT INTO order_items (order_id, menu_item_id, quantity, notes) VALUES ($1, $2, $3, $4)`;
            await client.query(orderItemInsertQuery, [newOrderId, item.id, item.quantity, item.notes]);
        }
        await client.query('COMMIT');
        
        // 模擬從設定決定是否寫入
        const shouldSaveToSheet = true; 
        if (shouldSaveToSheet) {
          try {
            await appendOrderToGoogleSheet({
              orderId: newOrderId, timestamp: orderTimestamp, table: tableNumber, headcount,
              total: totalAmount, itemDetails: items.map(i => `ID:${i.id}x${i.quantity}`).join('; ')
            });
          } catch (sheetError) {
            console.error(`訂單 #${newOrderId} 寫入 Google Sheet 失敗:`, sheetError.message);
          }
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
    if (!genAI) return res.status(503).json({ error: "AI 功能未啟用" });
    const { language, cartItems, availableItems } = req.body;
    if (!cartItems || !availableItems) return res.status(400).json({ error: "缺少推薦所需的欄位" });
    
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const prompt = `You are a friendly restaurant AI assistant. The user's current language is ${language}. Please respond ONLY in ${language}. The user has these items in their cart: ${cartItems}. Based on their cart, suggest one or two additional items from the available menu. Explain briefly and enticingly why they would be a good choice. Do not suggest items already in the cart. Here is the list of available menu items to choose from: ${availableItems}. Keep the response concise, friendly, and formatted as a simple paragraph.`;
    
    try {
        const result = await model.generateContent(prompt);
        res.json({ recommendation: result.response.text() });
    } catch (error) {
        console.error("呼叫 Gemini API 時發生錯誤:", error);
        res.status(500).json({ error: "無法獲取 AI 推薦" });
    }
});

async function appendOrderToGoogleSheet(orderData) {
  const auth = getGoogleAuth();
  if (!process.env.GOOGLE_SHEET_ID || !auth) {
    // *** 修改：修正 Log 邏輯 ***
    console.log("未正確設定 Google Sheet ID 或憑證，跳過寫入。");
    return;
  }
  
  const sheets = google.sheets({ version: 'v4', auth });
  const values = [[
      orderData.orderId, new Date(orderData.timestamp).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
      orderData.table, orderData.headcount, orderData.total, orderData.itemDetails
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: '訂單紀錄!A:F', // *** 修改：範圍擴大到 F 欄 ***
    valueInputOption: 'USER_ENTERED',
    resource: { values },
  });
  console.log(`訂單 #${orderData.orderId} 已成功寫入 Google Sheet。`);
}

app.listen(PORT, () => console.log(`後端伺服器 v4 正在 http://localhost:${PORT} 上運行`));
