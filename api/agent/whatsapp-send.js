// 360 Booth Ireland — Dashboard WhatsApp send proxy
// POST /api/agent/whatsapp-send { message: "..." }
// Sends message to TWILIO_WHATSAPP_TO via Twilio sandbox.
// Keys live in Vercel env vars — never exposed to the browser.
//
// Required env vars:
//   TWILIO_ACCOUNT_SID   — from console.twilio.com → Account Info
//   TWILIO_AUTH_TOKEN    — from console.twilio.com → Account Info
//   TWILIO_WHATSAPP_FROM — your Twilio WhatsApp sender, e.g. whatsapp:+14155238886
//   TWILIO_WHATSAPP_TO   — your personal number,     e.g. whatsapp:+353852545229

const TWILIO_BASE = 'https://api.twilio.com/2010-04-01';

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

  const { message } = req.body || {};
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  try{
    const url = `${TWILIO_BASE}/Accounts/${SID}/Messages.json`;
    const params = new URLSearchParams({ To: TO, From: FROM, Body: message.slice(0, 1600) });
    const credentials = Buffer.from(`${SID}:${TOKEN}`).toString('base64');

    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const data = await r.json();
    return res.status(r.ok ? 200 : 502).json({
      ok: r.ok, sid: data.sid || null, error: data.message || null,
    });
  }catch(err){
    return res.status(500).json({ error: err.message });
  }
};
