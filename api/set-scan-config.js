// 360 Booth Ireland — Write scan/delivery config to Supabase
// POST /api/set-scan-config { next_run_at?, schedule_type?, is_active?, custom_terms? }
// Called from the Settings page when user sets the next scan date or changes frequency.

const SUPABASE_URL = 'https://kcjmmiifemdarknrvpas.supabase.co';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SERVICE_KEY) return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_ROLE_KEY' });

  const { next_run_at, schedule_type, is_active, custom_terms } = req.body || {};

  // Only update fields that were passed
  const patch = {};
  if (next_run_at   !== undefined) patch.next_run_at   = next_run_at;
  if (schedule_type !== undefined) patch.schedule_type = schedule_type;
  if (is_active     !== undefined) patch.is_active     = is_active;
  if (custom_terms  !== undefined) patch.custom_terms  = custom_terms;

  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  try {
    // Upsert — creates the row if it doesn't exist yet
    const upsertBody = { id: 'main', ...patch };
    const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/scan_config`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(upsertBody),
    });

    if (!upsertRes.ok) {
      const err = await upsertRes.text();
      return res.status(502).json({ error: `Supabase error: ${err.slice(0, 200)}` });
    }

    return res.status(200).json({ ok: true, updated: patch });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
