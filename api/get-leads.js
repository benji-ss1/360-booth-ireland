// 360 Booth Ireland — Sync server-side leads to frontend
// GET /api/get-leads?since=<ISO date>
// Returns leads from Supabase event_leads saved after `since` (defaults to 30 days ago).
// The frontend calls this on page load to pull in leads from auto-scan cron runs.

const SUPABASE_URL = 'https://kcjmmiifemdarknrvpas.supabase.co';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SERVICE_KEY) return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_ROLE_KEY' });

  // Default: fetch last 90 days of leads
  const since = req.query.since || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const url = `${SUPABASE_URL}/rest/v1/event_leads?scan_run_at=gte.${encodeURIComponent(since)}&order=scan_run_at.desc&limit=200&select=*`;
    const r = await fetch(url, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    if (!r.ok) {
      const err = await r.text();
      return res.status(502).json({ error: `Supabase error: ${err.slice(0, 200)}` });
    }

    const rows = await r.json();

    // Normalise to the shape the frontend expects (same as what scan-leads.js produces)
    const leads = (rows || []).map(row => ({
      _key:          row.id || ('srv_' + Math.random().toString(36).slice(2)),
      title:         row.name || 'Event Lead',
      domain:        row.source || '',
      organizer:     row.name || '',
      email:         row.email || '',
      phone:         row.phone || '',
      lead_score:    row.lead_score || 50,
      urgency:       (row.lead_score || 0) >= 80 ? 'Hot' : (row.lead_score || 0) >= 55 ? 'Warm' : 'Cool',
      event_type:    row.service || '',
      status:        row.status || 'New',
      notes:         row.notes || '',
      firstSeen:     row.scan_run_at || row.date || new Date().toISOString(),
      source:        'auto-scan',
      _fromServer:   true,
    }));

    return res.status(200).json({ leads, total: leads.length, since });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
