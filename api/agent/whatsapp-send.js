// 360 Booth Ireland — Dashboard WhatsApp send proxy
// POST /api/agent/whatsapp-send { message: "...", label?: "..." }
// Sends message to TWILIO_WHATSAPP_TO via Twilio sandbox.
// Also persists to Supabase whatsapp_messages (direction: outbound).
// Keys live in Vercel env vars — never exposed to the browser.
//
// Required env vars:
//   TWILIO_ACCOUNT_SID        — from console.twilio.com → Account Info
//   TWILIO_AUTH_TOKEN         — from console.twilio.com → Account Info
//   TWILIO_WHATSAPP_FROM      — e.g. whatsapp:+14155238886
//   TWILIO_WHATSAPP_TO        — e.g. whatsapp:+353852545229
//   SUPABASE_SERVICE_ROLE_KEY — for persisting outbound messages

const TWILIO_BASE   = 'https://api.twilio.com/2010-04-01';
const SUPABASE_URL  = 'https://kcjmmiifemdarknrvpas.supabase.co';

async function persistToSupabase(body, label, sid, from, to, serviceKey) {
  if (!serviceKey) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_messages`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        direction: 'outbound',
        body,
        from_number: from,
        to_number: to,
        twilio_sid: sid || null,
        label: label || 'Manual',
      }),
    });
  } catch (err) {
    console.warn('[whatsapp-send] Supabase persist failed (non-fatal):', err.message);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SID         = process.env.TWILIO_ACCOUNT_SID;
  const TOKEN       = process.env.TWILIO_AUTH_TOKEN;
  const FROM        = process.env.TWILIO_WHATSAPP_FROM;
  const TO          = process.env.TWILIO_WHATSAPP_TO;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SID || !TOKEN || !FROM || !TO) {
    return res.status(500).json({
      error: 'Missing Twilio env vars. Need: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM, TWILIO_WHATSAPP_TO',
    });
  }

  const { message, label = 'Manual' } = req.body || {};
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  try {
    const url         = `${TWILIO_BASE}/Accounts/${SID}/Messages.json`;
    const params      = new URLSearchParams({ To: TO, From: FROM, Body: message.slice(0, 1600) });
    const credentials = Buffer.from(`${SID}:${TOKEN}`).toString('base64');

    const r    = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const data = await r.json();

    if (r.ok) {
      // Persist outbound to Supabase — non-blocking
      persistToSupabase(message.trim(), label, data.sid, FROM, TO, SERVICE_KEY);
    }

    return res.status(r.ok ? 200 : 502).json({
      ok: r.ok, sid: data.sid || null, error: data.message || null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
