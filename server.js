// --- server.js (v12 - 整合 LINE Messaging API) ---
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { google } = require('googleapis');
const line = require('@line/bot-sdk'); // 引入 LINE Bot SDK

// --- 資料庫連線設定 ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// --- LINE Bot Client 初始化 ---
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET, // 雖然只發送訊息用不到，但建議保留
};
const lineClient = new line.Client(lineConfig);


const app = express();
const PORT = process.env.PORT || 8080;
app.use(cors());
app.use(express.json());

// --- API 端點 ---
app.get('/', (req, res) => res.send('點餐系統後端 (v12 - LINE API) 已成功啟動！'));

app.post('/api/orders', async (req, res) => {
    const { tableNumber, headcount, totalAmount, items } = req.body;
    // ... 資料庫寫入邏輯 ...
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const orderInsertQuery = 'INSERT INTO orders (table_number, headcount, total_amount, status) VALUES ($1, $2, $3, $4) RETURNING id, created_at';
        const orderResult = await client.query(orderInsertQuery, [tableNumber, headcount, totalAmount, 'received']);
        const newOrderId = orderResult.rows[0].id;
        // ... 其他資料庫操作 ...
        await client.query('COMMIT');
        console.log(`訂單 #${newOrderId} 已成功儲存至資料庫。`);
        
        // --- 發送 LINE Messaging API 通知 ---
        const notificationMessage = formatOrderForNotification({ ...req.body, orderId: newOrderId });
        if (process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_USER_ID) {
            sendLineMessage(process.env.LINE_USER_ID, notificationMessage);
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

// --- 通知函式 ---
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
    try {
        await lineClient.pushMessage(userId, {
            type: 'text',
            text: message,
        });
        console.log("LINE 訊息已發送至:", userId);
    } catch (error) {
        console.error("發送 LINE 訊息失敗:", error.originalError ? error.originalError.response.data : error);
    }
}


// ... 其他 API 端點與函式保持不變 ...

app.listen(PORT, () => console.log(`後端伺服器 (v12) 正在 http://localhost:${PORT} 上運行`));
