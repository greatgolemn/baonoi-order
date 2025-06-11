
// 📁 index.js – บ่าวน้อยไส้อั่ว (ฉบับสมบูรณ์)
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');
const OpenAI = require('openai');
const { saveOrderToSheet } = require('./sheets');
const { replyMessage } = require('./messenger');
const { notifyLine } = require('./line');
const { loadOptions } = require('./optionLoader');
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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function askChatGPT(userMessage, userId) {
  const options = await loadOptions();
  const recipes = options['recipe_preset'] || [];

  const prompt = \`
คุณคือบ่าวน้อยไส้อั่ว พูดจาน่ารักและสุภาพแบบเด็กผู้ชาย

ตอนนี้บ่าวน้อยมีสูตรไส้อั่วให้เลือก 4 แบบ:
- \${recipes.join('\n- ')}

ลูกค้าสามารถเลือกประเภทสินค้าได้ 2 แบบ:
- พร้อมทาน
- ซีลสุญญากาศ

หากลูกค้าพิมพ์ว่าอยากสั่ง ให้แนะนำให้เลือกจากรายการนี้เท่านั้น
ห้ามพูดว่าสามารถปรับสูตรเองได้ และอย่าตอบสูตรอื่นนอกจากนี้
แต่ถ้าลูกค้ามีความต้องการเพิ่มเติมหรือต่างจากเมนูที่กำหนด สามารถแจ้งรายละเอียดได้เลยครับ บ่าวน้อยจะสรุปเป็นหมายเหตุ (Note) แนบไปให้แอดมินตรวจสอบครับ

หากลูกค้าเลือกสูตรเรียบร้อยแล้ว ให้ถามต่อว่า "อยากได้แบบพร้อมทานหรือซีลสุญญากาศดีครับ?"

ลูกค้าพิมพ์ว่า: "\${userMessage}"
  \`;

  if (!recipes.some(r => userMessage.includes(r)) &&
      !['พร้อมทาน', 'ซีลสุญญากาศ'].some(t => userMessage.includes(t))) {
    appendNote(userId, userMessage);
  }

  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'system', content: prompt }]
  });

  return res.choices[0].message.content;
}

// ✅ Facebook Webhook Verification
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ✅ Facebook Webhook Listener
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'page') {
    for (const entry of body.entry) {
      const webhookEvent = entry.messaging[0];
      const senderId = webhookEvent.sender.id;

      if (webhookEvent.message && webhookEvent.message.text) {
        const userMessage = webhookEvent.message.text;

        try {
          const reply = await askChatGPT(userMessage, senderId);
          await replyMessage(senderId, reply);
        } catch (err) {
          console.error('❌ GPT Error:', err);
          await replyMessage(senderId, "ขออภัยครับ เกิดข้อผิดพลาด ลองใหม่อีกครั้งนะครับ");
        }
      }
    }

    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});

// ✅ รับออเดอร์จาก Webview
app.post('/api/order', async (req, res) => {
  const order = req.body;
  const note = getNote(order.psid);

  try {
    await saveOrderToSheet({ ...order, note });

    const msg = \`บ่าวน้อยได้รับออเดอร์แล้วครับ ขอบคุณมาก ๆ เลยครับพี่ 🙏\n\n\` +
      \`🥓 สูตร: \${order.recipe}\n\` +
      \`📦 จำนวน: \${order.amount} โล\n\` +
      \`🧊 ประเภทสินค้า: \${order.product_type}\n\` +
      \`📍 รับที่: \${order.pickup_place}\n\` +
      \`🕒 วันที่-เวลา: \${new Date(order.pickup_time).toLocaleString()}\n\` +
      \`🚚 จัดส่งไปที่: \${order.address}\` +
      (note ? \`\n📝 หมายเหตุ: \${note}\` : '');

    await replyMessage(order.psid, msg);
    await notifyLine({ ...order, note });

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('❌ บันทึกออเดอร์ผิดพลาด:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ✅ Start server on Render port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('✅ Baonoi Chatbot server running on port ' + PORT);
});
