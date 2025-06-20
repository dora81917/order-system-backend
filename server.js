// --- server.js (v5 - Sheets 格式優化) ---
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// ... 省略與 v4 相同的初始化程式碼 ...

// *** 修改：接收訂單的端點 ***
app.post('/api/orders', async (req, res) => {
    const { tableNumber, headcount, totalAmount, items } = req.body;
    // ... 省略驗證與資料庫寫入邏輯 ...
    
    // *** 修改：傳入更詳細的 items 資訊以便格式化 ***
    const shouldSaveToSheet = true;
    if (shouldSaveToSheet) {
      try {
        await appendOrderToGoogleSheet({
          orderId: newOrderId,
          timestamp: orderTimestamp,
          table: tableNumber,
          headcount,
          total: totalAmount,
          items: items // 直接傳遞完整的 items 陣列
        });
      } catch (sheetError) { /* ... */ }
    }
    // ...
});

// ... 省略其他 API 端點 ...

// *** 修改：Google Sheets 輔助函式 ***
async function appendOrderToGoogleSheet(orderData) {
  const auth = getGoogleAuth();
  if (!process.env.GOOGLE_SHEET_ID || !auth) {
    console.log("未正確設定 Google Sheet ID 或憑證，跳過寫入。");
    return;
  }
  
  // *** 新增：格式化品項詳情的邏輯 ***
  const itemDetailsString = orderData.items.map(item => {
    const name = item.name?.zh || '未知品項';
    const options = item.selectedOptions ? Object.values(item.selectedOptions).join(', ') : '無';
    const notes = item.notes ? `備註: ${item.notes}` : '';
    return `${name} x ${item.quantity}\n選項: ${options}\n${notes}`.trim();
  }).join('\n\n'); // 使用兩個換行符分隔不同品項

  const sheets = google.sheets({ version: 'v4', auth });
  const values = [[
      orderData.orderId,
      new Date(orderData.timestamp).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
      orderData.table,
      orderData.headcount,
      orderData.total,
      itemDetailsString // 使用格式化後的字串
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: '訂單紀錄!A:F',
    valueInputOption: 'USER_ENTERED',
    resource: { values },
  });
  console.log(`訂單 #${orderData.orderId} 已成功寫入 Google Sheet。`);
}

// ... 省略 app.listen ...
