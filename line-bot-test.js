
require('dotenv').config();

const express = require('express');
const crypto = require('crypto');

const app = express();

const PORT = process.env.PORT || 3001;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// ตรวจสอบว่ากรอกข้อมูล LINE ครบหรือไม่
if (!CHANNEL_SECRET || !ACCESS_TOKEN) {
  throw new Error('กรุณาตรวจสอบ LINE credentials ในไฟล์ .env');
}

// รับ Webhook แบบ raw เพื่อใช้ตรวจสอบ Signature
app.post(
  '/api/line/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const signature = req.get('x-line-signature');

      // ตรวจสอบความถูกต้องของ Webhook
      const hash = crypto
        .createHmac('sha256', CHANNEL_SECRET)
        .update(req.body)
        .digest('base64');

      const expected = Buffer.from(hash);
      const received = Buffer.from(signature || '');

      if (
        expected.length !== received.length ||
        !crypto.timingSafeEqual(expected, received)
      ) {
        return res.status(401).send('Invalid signature');
      }

      const body = JSON.parse(req.body.toString());

      // ประมวลผล Event ที่ LINE ส่งมา
      for (const event of body.events || []) {
        if (
          event.type === 'message' &&
          event.message.type === 'text'
        ) {
          const userMessage = event.message.text;

          console.log('ข้อความจาก LINE:', userMessage);

          await replyMessage(
            event.replyToken,
            `PLM Assistant ได้รับข้อความแล้ว:\n${userMessage}`
          );
        }
      }

      res.sendStatus(200);

    } catch (error) {
      console.error('Webhook error:', error);
      res.sendStatus(500);
    }
  }
);

// ส่งข้อความกลับไปยัง LINE
async function replyMessage(replyToken, message) {
  const response = await fetch(
    'https://api.line.me/v2/bot/message/reply',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        replyToken,
        messages: [
          {
            type: 'text',
            text: message
          }
        ]
      })
    }
  );

  const result = await response.text();

  if (!response.ok) {
    console.error('LINE API error:', result);
  } else {
    console.log('ส่งข้อความสำเร็จ');
  }
}

// ตรวจสอบว่าเซิร์ฟเวอร์ทำงาน
app.get('/', (req, res) => {
  res.send('PLM LINE Bot is running!');
});

app.listen(PORT, () => {
  console.log(`LINE Bot running on http://localhost:${PORT}`);
});
