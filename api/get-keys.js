// 360 Booth Ireland — Serves pre-configured API keys to authenticated users.
// Dashboard calls this on boot so the owner never needs to enter keys manually.

const SUPABASE_URL = 'https://kcjmmiifemdarknrvpas.supabase.co';

async function verifySession(authHeader) {
  const token = (authHeader || '').replace('Bearer ', '').trim();
  if (!token) return false;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: serviceKey,
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const authed = await verifySession(req.headers.authorization);
  if (!authed) return res.status(401).json({ error: 'Not authenticated' });

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return res.status(500).json({ error: 'GROQ_API_KEY not configured' });

  return res.status(200).json({ groqKey });
};
