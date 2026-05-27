// 360 Booth Ireland — Twilio WhatsApp inbound webhook
// Twilio calls this URL when a WhatsApp message is received.
//
// Setup: Twilio Console → Messaging → Try it out → WhatsApp sandbox →
//   "WHEN A MESSAGE COMES IN" → set to:
//   https://360-booth-ireland.vercel.app/api/whatsapp-webhook
//   Method: HTTP POST
//
// Required env vars:
//   SUPABASE_SERVICE_ROLE_KEY — stores inbound messages to whatsapp_messages table

const SUPABASE_URL = 'https://kcjmmiifemdarknrvpas.supabase.co';

// Twilio sends application/x-www-form-urlencoded — Vercel parses it automatically
module.exports = async function handler(req, res) {
  // Twilio sends POST for inbound messages
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).end('<?xml version="1.0"?><Response/>');
  }

  const from = req.body?.From || req.body?.from || '';
  const body = req.body?.Body || req.body?.body || '';
  const sid  = req.body?.MessageSid || req.body?.messageSid || '';
  const to   = req.body?.To || req.body?.to || '';

  // Always respond to Twilio with empty TwiML — no auto-reply
  const twiml = '<?xml version="1.0"?><Response/>';

  if (!body.trim() || !from) {
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).end(twiml);
  }

  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (SERVICE_KEY) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_messages`, {
        method: 'POST',
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          direction: 'inbound',
          body: body.trim(),
          from_number: from,
          to_number: to,
          twilio_sid: sid || null,
          label: 'Inbound',
        }),
      });
    } catch (err) {
      console.error('[whatsapp-webhook] Supabase write failed:', err.message);
    }
  }

  res.setHeader('Content-Type', 'text/xml');
  res.status(200).end(twiml);
};
