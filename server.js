// --- server.js (v7 - 新增預覽品項) ---
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
function getGoogleAuth() { /* ... 保持不變 ... */ }

const app = express();
const PORT = process.env.PORT || 8080;
app.use(cors());
app.use(express.json());

// --- API 端點 ---
app.get('/', (req, res) => res.send('後端伺服器 v7 已成功啟動！'));
app.get('/api/settings', async (req, res) => { /* ... 保持不變 ... */ });

app.get('/api/menu', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM menu_items ORDER BY category, id');
        
        // *** 修改：初始化所有分類，並新增更多範例資料 ***
        const menu = { limited: [], main: [], side: [], drink: [], dessert: [] };
        
        // 新增期間限定範例
        menu.limited.push({
            id: 99,
            name: { zh: "夏日芒果冰", en: "Summer Mango Shaved Ice", ja: "サマーマンゴーかき氷", ko: "여름 망고 빙수" },
            price: 150,
            image: "https://placehold.co/600x400/FFE4B5/E67E22?text=芒果冰",
            description: { zh: "炎炎夏日，來一碗清涼消暑的芒果冰吧！", en: "Enjoy a bowl of refreshing mango shaved ice in the hot summer!"},
            category: 'limited',
            options: 'size'
        });

        result.rows.forEach(item => {
            const formattedItem = { ...item, options: item.options ? item.options.split(',') : [] };
            if (menu[item.category]) {
                menu[item.category].push(formattedItem);
            }
        });

        // 額外新增範例資料 (若資料庫為空)
        if(result.rows.length === 0) {
            menu.main.push({id: 101, name: {zh: "紅燒排骨飯"}, price: 160, image: "https://placehold.co/600x400/D2B48C/8B4513?text=排骨飯", description: {zh: "經典台式風味，滷汁入味。"}, category: 'main', options: ''});
            menu.side.push({id: 102, name: {zh: "涼拌小黃瓜"}, price: 40, image: "https://placehold.co/600x400/90EE90/2E8B57?text=小黃瓜", description: {zh: "清爽開胃。"}, category: 'side', options: ''});
            menu.drink.push({id: 103, name: {zh: "冬瓜檸檬"}, price: 50, image: "https://placehold.co/600x400/F0E68C/DAA520?text=冬瓜檸檬", description: {zh: "酸甜解渴。"}, category: 'drink', options: 'sugar,ice'});
        }

        res.json(menu);
    } catch (err) {
        console.error('查詢菜單時發生錯誤', err);
        res.status(500).send('伺服器錯誤');
    }
});


app.post('/api/orders', async (req, res) => { /* ... 保持不變 ... */ });
app.post('/api/recommendation', async (req, res) => { /* ... 保持不變 ... */ });
async function appendOrderToGoogleSheet(orderData) { /* ... 保持不變 ... */ }

app.listen(PORT, () => console.log(`後端伺服器 v7 正在 http://localhost:${PORT} 上運行`));
