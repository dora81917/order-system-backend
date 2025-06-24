// --- server.js (最終修復版) ---
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- 資料庫連線設定 ---
// DATABASE_URL 會由 Render.com 自動設定。本地開發時，則會使用 .env 中的資訊。
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// --- AI & Google Sheets 初始化 ---
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

function getGoogleAuth() {
  if (!process.env.GOOGLE_CREDENTIALS_JSON) {
    console.log("環境變數 GOOGLE_CREDENTIALS_JSON 未設定，跳過 Google Sheet 操作。");
    return null;
  }
  try {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    return new google.auth.GoogleAuth({
        credentials,
        scopes: 'https://www.googleapis.com/auth/spreadsheets',
    });
  } catch(e) {
      console.error("無法解析 GOOGLE_CREDENTIALS_JSON:", e);
      return null;
  }
}

const app = express();
const PORT = process.env.PORT || 8080;
app.use(cors());
app.use(express.json());

// --- 模擬多國語言翻譯 (用於 Google Sheets) ---
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

// --- API 端點 ---
app.get('/', (req, res) => res.send('後端伺服器 (最終穩定版) 已成功啟動！'));

// 假設 restaurantId=1
app.get('/api/settings', async (req, res) => {
    res.json({ isAiEnabled: true, saveToGoogleSheet: true });
});

app.get('/api/menu', async (req, res) => {
    try {
        console.log("正在嘗試從資料庫獲取菜單...");
        const result = await pool.query('SELECT * FROM menu_items ORDER BY category, id');
        console.log(`成功獲取 ${result.rows.length} 筆菜單項目。`);
        
        const menu = { limited: [], main: [], side: [], drink: [], dessert: [] };
        
        // *** 修正：將寫死的範例資料格式統一 ***
        menu.limited.push({
            id: 99,
            name: { zh: "夏日芒果冰", en: "Summer Mango Shaved Ice", ja: "サマーマンゴーかき氷", ko: "여름 망고 빙수" },
            price: 150,
            image: "https://images.pexels.com/photos/5938363/pexels-photo-5938363.jpeg?auto=compress&cs=tinysrgb&w=1260&h=750&dpr=1",
            description: { zh: "炎炎夏日，來一碗清涼消暑的芒果冰吧！", en: "Enjoy a bowl of refreshing mango shaved ice in the hot summer!"},
            category: 'limited',
            options: ['size'] // 確保 options 是陣列格式
        });
        
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

app.post('/api/orders', async (req, res) => {
    const { tableNumber, headcount, totalAmount, items } = req.body;
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
            await client.query(orderItemInsertQuery, [newOrderId, item.id === 99 ? null : item.id, item.quantity, item.notes]);
        }
        await client.query('COMMIT');
        
        console.log(`訂單 #${newOrderId} 已成功儲存至資料庫。`);
        
        const shouldSaveToSheet = true; 
        if (shouldSaveToSheet) {
          try {
            await appendOrderToGoogleSheet({
              orderId: newOrderId, timestamp: orderTimestamp, table: tableNumber, headcount,
              total: totalAmount, items: items 
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
    console.log("未正確設定 Google Sheet ID 或憑證，跳過寫入。");
    return;
  }
  
  const t = translations['zh']; 
  const itemDetailsString = orderData.items.map(item => {
    const name = item.name?.zh || '未知品項';
    const options = item.selectedOptions && Object.keys(item.selectedOptions).length > 0
        ? Object.entries(item.selectedOptions).map(([key, value]) => {
            return t.options[key]?.[value] || value;
        }).join(', ') 
        : '無';
    const notes = item.notes ? `備註: ${item.notes}` : '';
    return `${name} x ${item.quantity}\n選項: ${options}\n${notes}`.trim();
  }).join('\n\n');

  const sheets = google.sheets({ version: 'v4', auth });
  const values = [[
      orderData.orderId, new Date(orderData.timestamp).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
      orderData.table, orderData.headcount, orderData.total, itemDetailsString
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: '訂單紀錄!A:F',
    valueInputOption: 'USER_ENTERED',
    resource: { values },
  });
  console.log(`訂單 #${orderData.orderId} 已成功寫入 Google Sheet。`);
}

app.listen(PORT, () => console.log(`後端伺服器 (最終穩定版) 正在 http://localhost:${PORT} 上運行`));
