// --- server.js (最終穩定版) ---
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

// --- API 端點 ---
app.get('/', (req, res) => res.send('點餐系統後端 (最終穩定版) 已成功啟動！'));

app.get('/api/settings', async (req, res) => {
    res.json({ isAiEnabled: true, saveToGoogleSheet: true });
});

app.get('/api/menu', async (req, res) => {
    try {
        console.log("正在嘗試從資料庫獲取菜單...");
        const result = await pool.query('SELECT * FROM menu_items ORDER BY category, id');
        console.log(`成功獲取 ${result.rows.length} 筆菜單項目。`);
        
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

app.post('/api/orders', async (req, res) => {
    // ... 此處省略與前一版完全相同的訂單處理邏輯 ...
});

app.post('/api/recommendation', async (req, res) => {
    // ... 此處省略與前一版完全相同的 AI 推薦邏輯 ...
});

async function appendOrderToGoogleSheet(orderData) {
    // ... 此處省略與前一版完全相同的 Google Sheet 寫入邏輯 ...
}

app.listen(PORT, () => console.log(`後端伺服器 (最終穩定版) 正在 http://localhost:${PORT} 上運行`));
