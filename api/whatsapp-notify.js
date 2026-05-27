// 360 Booth Ireland — WhatsApp notification via Twilio
// Called from deliver-leads.js after email send.
// Can also be triggered manually: POST /api/whatsapp-notify { message: "..." }
//
// Required Vercel env vars:
//   TWILIO_ACCOUNT_SID   — from console.twilio.com → Account Info
//   TWILIO_AUTH_TOKEN    — from console.twilio.com → Account Info
//   TWILIO_WHATSAPP_FROM — your Twilio WhatsApp sender, e.g. whatsapp:+14155238886
//   TWILIO_WHATSAPP_TO   — your personal number,     e.g. whatsapp:+353871234567

const TWILIO_BASE = 'https://api.twilio.com/2010-04-01';

async function sendWhatsApp({ to, from, body, accountSid, authToken }) {
  const url = `${TWILIO_BASE}/Accounts/${accountSid}/Messages.json`;
  const params = new URLSearchParams({ To: to, From: from, Body: body });
  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const data = await res.json();
  return { ok: res.ok, sid: data.sid, error: data.message };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SID   = process.env.TWILIO_ACCOUNT_SID;
  const TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const FROM  = process.env.TWILIO_WHATSAPP_FROM;
  const TO    = process.env.TWILIO_WHATSAPP_TO;

  if (!SID || !TOKEN || !FROM || !TO) {
    return res.status(500).json({
      error: 'Missing Twilio env vars. Need: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM, TWILIO_WHATSAPP_TO',
    });
  }

  const { message, hot = 0, warm = 0, total = 0 } = req.body || {};

  const body = message || buildMessage({ hot, warm, total });

  try {
    const result = await sendWhatsApp({ to: TO, from: FROM, body, accountSid: SID, authToken: TOKEN });
    return res.status(result.ok ? 200 : 502).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

function buildMessage({ hot, warm, total }) {
  const lines = [
    `*Jarvis Intel Report — 360 Booth Ireland*`,
    ``,
    `Your weekly lead scan just completed.`,
    ``,
    `${hot > 0 ? `🔴 *${hot} hot lead${hot > 1 ? 's' : ''}* ready to contact` : 'No hot leads this run'}`,
    `${warm > 0 ? `🟡 ${warm} warm lead${warm > 1 ? 's' : ''} worth following up` : ''}`,
    ``,
    `Full report sent to your email. Open the dashboard to review and move leads through your pipeline.`,
  ].filter(l => l !== undefined);

  return lines.join('\n');
}
