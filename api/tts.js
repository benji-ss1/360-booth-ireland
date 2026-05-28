// 360 Booth Ireland — ElevenLabs TTS proxy
// Keeps ELEVENLABS_API_KEY hidden from the frontend.
// POST /api/tts  { text: string }
// Returns audio/mpeg stream
//
// Env vars needed:
//   ELEVENLABS_API_KEY  — from elevenlabs.io → Profile → API Keys
//   ELEVENLABS_VOICE_ID — from elevenlabs.io → Voices → copy Voice ID
//                         Recommended: "Adam" (pNInz6obpgDQGcFmaJgB) or clone your own

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';
const DEFAULT_VOICE   = 'pNInz6obpgDQGcFmaJgB'; // Adam — deep, professional, AI-like

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const API_KEY  = process.env.ELEVENLABS_API_KEY;
  const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE;

  if (!API_KEY) return res.status(503).json({ error: 'ELEVENLABS_API_KEY not set' });

  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });

  // Clean text — strip markdown, keep it speakable
  const clean = text
    .replace(/\*\*/g, '').replace(/\*/g, '').replace(/#+\s/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[_~`]/g, '').replace(/\n+/g, '. ')
    .replace(/\.{2,}/g, '.').trim()
    .slice(0, 500);

  try {
    const r = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${VOICE_ID}/stream`, {
      method: 'POST',
      headers: {
        'xi-api-key': API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: clean,
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
          stability: 0.55,
          similarity_boost: 0.82,
          style: 0.18,
          use_speaker_boost: true,
        },
      }),
    });

    if (!r.ok) {
      const err = await r.text();
      return res.status(502).json({ error: `ElevenLabs error: ${err.slice(0, 200)}` });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    const buf = await r.arrayBuffer();
    res.status(200).end(Buffer.from(buf));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
