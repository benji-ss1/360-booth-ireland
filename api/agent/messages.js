// 360 Booth Ireland — WhatsApp message history proxy
// GET /api/agent/messages?limit=120&after=<id>
// Returns { messages: [...] } from Supabase whatsapp_messages table.
// Service key stays server-side — never exposed to browser.
//
// Required env vars:
//   SUPABASE_SERVICE_ROLE_KEY

const SUPABASE_URL = 'https://kcjmmiifemdarknrvpas.supabase.co';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SERVICE_KEY) return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_ROLE_KEY' });

  const limit = Math.min(parseInt(req.query?.limit || '120', 10), 200);
  const after = req.query?.after ? parseInt(req.query.after, 10) : null;

  let url = `${SUPABASE_URL}/rest/v1/whatsapp_messages?select=*&order=created_at.asc&limit=${limit}`;
  if (after) url += `&id=gt.${after}`;

  try {
    const r = await fetch(url, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ error: `Supabase ${r.status}: ${t.slice(0, 200)}` });
    }
    const messages = await r.json();
    return res.status(200).json({ messages: messages || [] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
