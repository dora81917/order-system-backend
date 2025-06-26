// --- server.js (v18 - 最終修復版) ---
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { google } = require('googleapis');
const line = require('@line/bot-sdk');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- 資料庫連線設定 ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// --- LINE Bot Client 初始化 (健壯性修正) ---
let lineClient = null;
// 檢查金鑰是否存在，這段邏輯是正確的，問題通常出在 Render 的環境變數設定
if (process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_CHANNEL_SECRET) {
    const lineConfig = {
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
      channelSecret: process.env.LINE_CHANNEL_SECRET,
    };
    lineClient = new line.Client(lineConfig);
    console.log("LINE Bot Client 已成功初始化。");
} else {
    console.warn("警告：未提供 LINE_CHANNEL_ACCESS_TOKEN 或 LINE_CHANNEL_SECRET，LINE 通知功能將被停用。請檢查您在部署平台(如 Render)上的環境變數名稱是否正確 (大小寫、底線)。");
}

// --- Gemini AI 初始化 (健壯性修正) ---
let genAI = null;
if(process.env.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    console.log("Gemini AI Client 已成功初始化。");
} else {
    console.warn("警告：未提供 GEMINI_API_KEY，AI 推薦功能將被停用。");
}


const app = express();
const PORT = process.env.PORT || 8080;
app.use(cors());
app.use(express.json());


// --- 模擬多國語言翻譯 (用於後端格式化訊息) ---
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
app.get('/', (req, res) => res.send('後端伺服器 (v18 - 最終修復版) 已成功啟動！'));

app.get('/api/settings', async (req, res) => {
    res.json({ 
        isAiEnabled: !!genAI, // 如果 genAI 初始化成功，則啟用 AI 功能
        saveToGoogleSheet: true 
    });
});

app.get('/api/menu', async (req, res) => {
    try {
        console.log("正在嘗試從資料庫獲取菜單...");
        const result = await pool.query('SELECT * FROM menu_items ORDER BY category, id');
        console.log(`成功獲取 ${result.rows.length} 筆菜單項目。`);
        
        const formattedItems = result.rows.map(item => ({
            ...item,
            options: item.options ? item.options.split(',').filter(opt => opt) : []
        }));

        // 【修改後的邏輯】動態建立菜單分類，以恢復「主廚推薦」並提高擴充性
        const menu = {};
        formattedItems.forEach(item => {
            if (!menu[item.category]) {
                menu[item.category] = [];
            }
            menu[item.category].push(item);
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
            await client.query(orderItemInsertQuery, [newOrderId, item.id, item.quantity, item.notes]);
        }
        await client.query('COMMIT');
        
        console.log(`訂單 #${newOrderId} 已成功儲存至資料庫。`);
        
        const notificationMessage = formatOrderForNotification({ ...req.body, orderId: newOrderId });
        if (lineClient && process.env.LINE_USER_ID) {
            sendLineMessage(process.env.LINE_USER_ID, notificationMessage);
        }
        
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
    if (!genAI) return res.status(503).json({ error: "AI 功能未啟用或設定錯誤。" });
    
    const { language, cartItems, availableItems } = req.body;
    if (!cartItems || !availableItems) return res.status(400).json({ error: "缺少推薦所需的欄位" });
    
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); // 使用更新的 Flash 模型
    const prompt = `You are a friendly restaurant AI assistant. The user's current language is ${language}. Please respond ONLY in ${language}. The user has these items in their cart: ${cartItems}. Based on their cart, suggest one or two additional items from the available menu. Explain briefly and enticingly why they would be a good choice. Do not suggest items already in the cart. Here is the list of available menu items to choose from: ${availableItems}. Keep the response concise, friendly, and formatted as a simple paragraph.`;
    
    try {
        const result = await model.generateContent(prompt);
        res.json({ recommendation: result.response.text() });
    } catch (error) {
        console.error("呼叫 Gemini API 時發生錯誤:", error);
        res.status(500).json({ error: "無法獲取 AI 推薦" });
    }
});


// --- 輔助函式 ---
function formatOrderForNotification(order) {
    let message = `🔔 新訂單通知！(單號 #${order.orderId})\n`;
    message += `桌號: ${order.tableNumber}\n`;
    message += `人數: ${order.headcount}\n`;
    message += `-------------------\n`;
    order.items.forEach(item => {
        const itemName = item.name?.zh || '未知品項';
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
    if(!lineClient) {
        console.log("LINE Client 未初始化，跳過發送訊息。");
        return;
    }
    try {
        await lineClient.pushMessage(userId, { type: 'text', text: message });
        console.log("LINE 訊息已發送至:", userId);
    } catch (error) {
        console.error("發送 LINE 訊息失敗:", error.originalError ? error.originalError.response.data : error);
    }
}

function getGoogleAuth() {
    if (!process.env.GOOGLE_CREDENTIALS_JSON) { return null; }
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

app.listen(PORT, () => console.log(`後端伺服器 (v18 - 最終修復版) 正在 http://localhost:${PORT} 上運行`));