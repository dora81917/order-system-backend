// --- server.js (v3 - 整合 Gemini API 與 Google Sheets) ---

// --- 設定步驟 ---
// 1. 在 backend 終端機中執行: npm install @google/generative-ai
// 2. 在 .env 檔案中新增您的 Gemini API 金鑰: GEMINI_API_KEY=您的金鑰
// ---

require('dotenv').config(); // 讀取 .env 檔案，必須放在最前面
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require("@google/generative-ai"); // 引入 Gemini 套件

// --- 資料庫連線設定 ---
// DATABASE_URL 會由 Render.com 自動設定。本地開發時，請確保 .env 中有完整的連線資訊。
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// --- Gemini AI 初始化 ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());


// --- API 端點 (Endpoints) ---

app.get('/', (req, res) => {
  res.send('後端伺服器 v3 已成功啟動！');
});

app.get('/api/settings', (req, res) => {
  // 這裡未來會從資料庫讀取該餐廳的設定
  res.json({
    isAiEnabled: true, 
    saveToGoogleSheet: true,
  });
});

app.get('/api/menu', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM menu_items ORDER BY category, id');
    const menu = { main: [], side: [], drink: [], dessert: [] };
    result.rows.forEach(item => {
      const formattedItem = { ...item, options: item.options ? item.options.split(',') : [] };
      if (menu[item.category]) { menu[item.category].push(formattedItem); }
    });
    res.json(menu);
  } catch (err) {
    console.error('查詢菜單時發生錯誤', err);
    res.status(500).send('伺服器錯誤');
  }
});

app.post('/api/orders', async (req, res) => {
    const { tableNumber, totalAmount, items } = req.body;
    if (!tableNumber || totalAmount === undefined || !items || !Array.isArray(items)) {
        return res.status(400).json({ message: '訂單資料不完整或格式錯誤。' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const orderInsertQuery = 'INSERT INTO orders (table_number, total_amount, status) VALUES ($1, $2, $3) RETURNING id, created_at';
        const orderResult = await client.query(orderInsertQuery, [tableNumber, totalAmount, 'received']);
        const newOrderId = orderResult.rows[0].id;
        const orderTimestamp = orderResult.rows[0].created_at;

        for (const item of items) {
            const orderItemInsertQuery = `INSERT INTO order_items (order_id, menu_item_id, quantity, notes) VALUES ($1, $2, $3, $4)`;
            await client.query(orderItemInsertQuery, [newOrderId, item.id, item.quantity, item.notes]);
        }
        await client.query('COMMIT');
        
        const shouldSaveToSheet = true; 
        if (shouldSaveToSheet) {
          try {
            await appendOrderToGoogleSheet({
              orderId: newOrderId,
              timestamp: orderTimestamp,
              table: tableNumber,
              total: totalAmount,
              itemDetails: items.map(i => `ID:${i.id} x${i.quantity}`).join('; ')
            });
            console.log(`訂單 #${newOrderId} 已成功寫入 Google Sheet。`);
          } catch (sheetError) {
            console.error(`訂單 #${newOrderId} 寫入 Google Sheet 失敗:`, sheetError);
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

// *** 新增：AI 推薦 API 端點 ***
app.post('/api/recommendation', async (req, res) => {
    const { language, cartItems, availableItems } = req.body;

    if (!cartItems || !availableItems) {
        return res.status(400).json({ error: "缺少推薦所需的欄位" });
    }

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const prompt = `You are a friendly restaurant AI assistant. The user's current language is ${language}. Please respond ONLY in ${language}. The user has these items in their cart: ${cartItems}. Based on their cart, suggest one or two additional items from the available menu. Explain briefly and enticingly why they would be a good choice. Do not suggest items already in the cart. Here is the list of available menu items to choose from: ${availableItems}. Keep the response concise, friendly, and formatted as a simple paragraph.`;

    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        res.json({ recommendation: text });
    } catch (error) {
        console.error("呼叫 Gemini API 時發生錯誤:", error);
        res.status(500).json({ error: "無法獲取 AI 推薦" });
    }
});


// --- Google Sheets 輔助函式 ---
async function appendOrderToGoogleSheet(orderData) {
  // 檢查是否有設定 GOOGLE_SHEET_ID 和憑證檔案
  if (!process.env.GOOGLE_SHEET_ID || !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.log("未設定 Google Sheet ID 或憑證，跳過寫入。");
    return;
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: 'https://www.googleapis.com/auth/spreadsheets',
  });

  const sheets = google.sheets({ version: 'v4', auth });
  
  const values = [[
      orderData.orderId,
      new Date(orderData.timestamp).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
      orderData.table,
      orderData.total,
      orderData.itemDetails
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: '訂單紀錄!A:E', // 確保您的工作表名稱正確
    valueInputOption: 'USER_ENTERED',
    resource: { values },
  });
}


// 啟動伺服器
app.listen(PORT, () => {
  console.log(`後端伺服器 v3 正在 http://localhost:${PORT} 上運行`);
});
