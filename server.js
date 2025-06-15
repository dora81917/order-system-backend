require('dotenv').config(); // 這行要加在所有程式碼的最前面

// --- server.js (整合資料庫版本) ---
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg'); // 引入 node-postgres 套件

// --- 資料庫連線設定 ---
// Node.js 會自動讀取我們在環境變數中設定的資訊
const pool = new Pool({
  user: process.env.DB_USER || 'myuser',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'ordering_system',
  password: process.env.DB_PASSWORD || 'mypassword',
  port: process.env.DB_PORT || 5432,
});

const app = express();
const PORT = process.env.PORT || 8080; // Render.com 會自動設定 PORT 環境變數

app.use(cors());
app.use(express.json());

// --- API 端點 (Endpoints) ---

// 測試端點
app.get('/', (req, res) => {
  res.send('後端伺服器已成功啟動！(資料庫連接版)');
});

// 獲取菜單資料的端點 (現在從資料庫讀取)
app.get('/api/menu', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT * FROM menu_items ORDER BY category, id');
    
    // 將扁平的資料庫查詢結果，重組成前端需要的分類格式
    const menu = {
      main: [],
      side: [],
      drink: [],
      dessert: [],
    };

    result.rows.forEach(item => {
        // 將資料庫中的 item.options (字串) 轉為陣列
        const formattedItem = {
            ...item,
            options: item.options ? item.options.split(',') : [] 
        };

      if (menu[item.category]) {
        menu[item.category].push(formattedItem);
      }
    });

    client.release();
    res.json(menu);
  } catch (err) {
    console.error('查詢菜單時發生錯誤', err);
    res.status(500).send('伺服器錯誤');
  }
});

// 接收訂單的端點
app.post('/api/orders', async (req, res) => {
    const { tableNumber, totalAmount, items } = req.body;
    
    // 基本驗證
    if (!tableNumber || !totalAmount || !items || !Array.isArray(items)) {
        return res.status(400).json({ message: '訂單資料不完整或格式錯誤。' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN'); // 開始交易

        // 1. 在 orders 資料表中插入一筆主訂單紀錄
        const orderInsertQuery = 'INSERT INTO orders (table_number, total_amount, status) VALUES ($1, $2, $3) RETURNING id';
        const orderResult = await client.query(orderInsertQuery, [tableNumber, totalAmount, 'received']);
        const newOrderId = orderResult.rows[0].id;

        // 2. 將購物車中的每個品項插入 order_items 資料表
        for (const item of items) {
            const orderItemInsertQuery = `
                INSERT INTO order_items (order_id, menu_item_id, quantity, notes) 
                VALUES ($1, $2, $3, $4)
            `;
            await client.query(orderItemInsertQuery, [newOrderId, item.id, item.quantity, item.notes]);
        }

        await client.query('COMMIT'); // 完成交易

        res.status(201).json({ message: '訂單已成功接收！', orderId: newOrderId });

    } catch (err) {
        await client.query('ROLLBACK'); // 如果有任何錯誤，則復原所有操作
        console.error('建立訂單時發生錯誤', err);
        res.status(500).json({ message: '建立訂單時伺服器發生錯誤。' });
    } finally {
        client.release();
    }
});


// 啟動伺服器
app.listen(PORT, () => {
  console.log(`後端伺服器正在 http://localhost:${PORT} 上運行`);
});
