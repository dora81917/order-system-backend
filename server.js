// --- server.js (v16 - 視覺資料更新版) ---
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { google } = require('googleapis');
const line = require('@line/bot-sdk');

// --- 資料庫連線設定 ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// --- LINE Bot Client 初始化 ---
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || '', // 雖然只發送訊息用不到，但建議保留
};
const lineClient = new line.Client(lineConfig);


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
app.get('/', (req, res) => res.send('後端伺服器 (v16) 已成功啟動！'));

app.get('/api/settings', async (req, res) => {
    res.json({ isAiEnabled: true, saveToGoogleSheet: true });
});

app.get('/api/menu', async (req, res) => {
    try {
        console.log("正在嘗試從資料庫獲取菜單...");
        const result = await pool.query('SELECT * FROM menu_items ORDER BY category, id');
        console.log(`成功獲取 ${result.rows.length} 筆菜單項目。`);
        
        const menu = { limited: [], main: [], side: [], drink: [], dessert: [] };
        
        // 新增期間限定範例
        menu.limited.push({
            id: 99,
            name: { zh: "夏日芒果冰", en: "Summer Mango Shaved Ice", ja: "サマーマンゴーかき氷", ko: "여름 망고 빙수" },
            price: 150,
            image: "https://images.pexels.com/photos/1092730/pexels-photo-1092730.jpeg?auto=compress&cs=tinysrgb&w=1260&h=750&dpr=1",
            description: { zh: "炎炎夏日，來一碗清涼消暑的芒果冰吧！", en: "Enjoy a bowl of refreshing mango shaved ice in the hot summer!"},
            category: 'limited',
            options: ['size'] 
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
        
        const notificationMessage = formatOrderForNotification({ ...req.body, orderId: newOrderId });
        if (process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_USER_ID) {
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

// ... 此處省略其他與前一版相同的程式碼 ...

app.listen(PORT, () => console.log(`後端伺服器 (v16) 正在 http://localhost:${PORT} 上運行`));
