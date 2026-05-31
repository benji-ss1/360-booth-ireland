// 360 Booth Ireland — Data endpoint
// GET /api/get-leads?since=<ISO>     → leads from Supabase
// GET /api/get-leads?mode=keys       → Groq key (auth required, used by hub.html)

const SUPABASE_URL = 'https://kcjmmiifemdarknrvpas.supabase.co';

async function verifySession(authHeader) {
  const token = (authHeader || '').replace('Bearer ', '').trim();
  if (!token) return false;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return false;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: serviceKey },
    });
    return r.ok;
  } catch { return false; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SERVICE_KEY) return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_ROLE_KEY' });

  // ── keys mode (hub.html) ─────────────────────────────────────────────
  if (req.query.mode === 'keys') {
    const authed = await verifySession(req.headers.authorization);
    if (!authed) return res.status(401).json({ error: 'Not authenticated' });
    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) return res.status(500).json({ error: 'GROQ_API_KEY not configured' });
    return res.status(200).json({ groqKey });
  }

  // ── leads mode (default) ─────────────────────────────────────────────
  const since = req.query.since || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const url = `${SUPABASE_URL}/rest/v1/event_leads?scan_run_at=gte.${encodeURIComponent(since)}&order=scan_run_at.desc&limit=200&select=*`;
    const r = await fetch(url, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    });
    if (!r.ok) {
      const err = await r.text();
      return res.status(502).json({ error: `Supabase error: ${err.slice(0, 200)}` });
    }
    const rows = await r.json();

    function stableKey(row) {
      const s = (row.email || row.event_name || row.id || Math.random().toString()).slice(0, 80);
      let h = 0;
      for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
      return 'srv' + Math.abs(h).toString(36);
    }

    const leads = (rows || []).map(row => ({
      _key:        stableKey(row),
      title:       row.event_name || row.name || 'Event Lead',
      domain:      row.source || '',
      organizer:   row.name || '',
      email:       row.email || '',
      phone:       row.phone || '',
      lead_score:  row.lead_score || 50,
      urgency:     (row.lead_score || 0) >= 80 ? 'Hot' : (row.lead_score || 0) >= 55 ? 'Warm' : 'Cool',
      event_type:  row.event_type || row.service || '',
      event_name:  row.event_name || '',
      event_date:  row.event_date || '',
      venue:       row.venue || '',
      status:      row.status || 'New',
      notes:       row.notes || '',
      firstSeen:   row.scan_run_at || row.date || new Date().toISOString(),
      scan_run_id: row.scan_run_id || null,
      scan_run_at: row.scan_run_at || null,
      url:         (() => { const m=(row.notes||'').match(/Source:\s*(https?:\/\/\S+)/); return m?m[1]:'' })(),
      source:      'auto-scan',
      _fromServer: true,
    }));

    return res.status(200).json({ leads, total: leads.length, since });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
