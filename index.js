
// 📁 index.js (เฉพาะส่วน /api/order + GPT Prompt + Quick Reply จาก recipe_preset)
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');
const { saveOrderToSheet } = require('./sheets');
const { replyMessage } = require('./messenger');
const { notifyLine } = require('./line');
const { loadOptions } = require('./optionLoader');
const { Configuration, OpenAIApi } = require('openai');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessions = {};

function initSession(userId) {
  sessions[userId] = { step: 0, data: { note: '' } };
}

function appendNote(userId, text) {
  if (!sessions[userId]) initSession(userId);
  sessions[userId].data.note += (sessions[userId].data.note ? '\n' : '') + text;
}

function getNote(userId) {
  return sessions[userId]?.data?.note || '';
}

const openai = new OpenAIApi(new Configuration({ apiKey: process.env.OPENAI_API_KEY }));

async function askChatGPT(userMessage, userId) {
  const options = await loadOptions();
  const recipes = options['recipe_preset'] || [];

  const prompt = `
คุณคือบ่าวน้อยไส้อั่ว พูดจาน่ารักและสุภาพแบบเด็กผู้ชาย

ตอนนี้บ่าวน้อยมีสูตรไส้อั่วให้เลือก 4 แบบ:
- ${recipes.join('\n- ')}

ลูกค้าสามารถเลือกประเภทสินค้าได้ 2 แบบ:
- พร้อมทาน
- ซีลสุญญากาศ

หากลูกค้าพิมพ์ว่าอยากสั่ง ให้แนะนำให้เลือกจากรายการนี้เท่านั้น
ห้ามพูดว่าสามารถปรับสูตรเองได้ และอย่าตอบสูตรอื่นนอกจากนี้
แต่ถ้าลูกค้ามีความต้องการเพิ่มเติมหรือต่างจากเมนูที่กำหนด สามารถแจ้งรายละเอียดได้เลยครับ บ่าวน้อยจะสรุปเป็นหมายเหตุ (Note) แนบไปให้แอดมินตรวจสอบครับ

หากลูกค้าเลือกสูตรเรียบร้อยแล้ว ให้ถามต่อว่า "อยากได้แบบพร้อมทานหรือซีลสุญญากาศดีครับ?"

ลูกค้าพิมพ์ว่า: "${userMessage}"
  `;

  if (!recipes.some(r => userMessage.includes(r)) &&
      !['พร้อมทาน', 'ซีลสุญญากาศ'].some(t => userMessage.includes(t))) {
    appendNote(userId, userMessage);
  }

  const res = await openai.createChatCompletion({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: prompt }
    ]
  });

  return res.data.choices[0].message.content;
}

// ✅ สร้าง Quick Reply จากสูตรใน Sheet
app.get('/api/quick-reply', async (req, res) => {
  try {
    const options = await loadOptions();
    const recipes = options['recipe_preset'] || [];

    const quickReplies = recipes.map((recipe) => ({
      content_type: 'text',
      title: recipe.substring(0, 20), // Messenger จำกัด 20 ตัวอักษร
      payload: `RECIPE_${recipe}`
    }));

    res.json({
      text: "เลือกสูตรไส้อั่วที่ต้องการเลยครับผม 👇",
      quick_replies: quickReplies
    });
  } catch (err) {
    console.error('❌ โหลด quick reply ไม่สำเร็จ:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ✅ สร้าง Quick Reply สำหรับประเภทสินค้า
app.get('/api/quick-reply/product-type', (req, res) => {
  const quickReplies = [
    {
      content_type: 'text',
      title: 'พร้อมทาน',
      payload: 'PRODUCT_READY'
    },
    {
      content_type: 'text',
      title: 'ซีลสุญญากาศ',
      payload: 'PRODUCT_SEALED'
    }
  ];

  res.json({
    text: "เลือกประเภทสินค้าที่ต้องการเลยครับผม 👇",
    quick_replies: quickReplies
  });
});

app.post('/api/order', async (req, res) => {
  const order = req.body;
  const note = getNote(order.psid);

  try {
    await saveOrderToSheet({ ...order, note });

    const msg = `บ่าวน้อยได้รับออเดอร์แล้วครับ ขอบคุณมาก ๆ เลยครับพี่ 🙏\n\n` +
      `🥓 สูตร: ${order.recipe}\n` +
      `📦 จำนวน: ${order.amount} โล\n` +
      `🧊 ประเภทสินค้า: ${order.product_type}\n` +
      `📍 รับที่: ${order.pickup_place}\n` +
      `🕒 วันที่-เวลา: ${new Date(order.pickup_time).toLocaleString()}\n` +
      `🚚 จัดส่งไปที่: ${order.address}` +
      (note ? `\n📝 หมายเหตุ: ${note}` : '');

    await replyMessage(order.psid, msg);
    await notifyLine({ ...order, note });

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('❌ บันทึกออเดอร์ผิดพลาด:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});
