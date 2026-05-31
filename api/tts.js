// 360 Booth Ireland — Google Cloud Text-to-Speech proxy
// Keeps GOOGLE_TTS_API_KEY hidden from the frontend.
// POST /api/tts  { text: string }
// Returns audio/mpeg stream
//
// Env vars needed:
//   GOOGLE_TTS_API_KEY — from console.cloud.google.com → Credentials → API Keys
//                        (enable "Cloud Text-to-Speech API" in the project)

const GOOGLE_TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const API_KEY = process.env.GOOGLE_TTS_API_KEY;
  if (!API_KEY) return res.status(503).json({ error: 'GOOGLE_TTS_API_KEY not set' });

  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });

  // Clean text — strip markdown, keep it speakable
  const clean = text
    .replace(/\*\*/g, '').replace(/\*/g, '').replace(/#+\s/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[_~`]/g, '').replace(/\n+/g, '. ')
    .replace(/\.{2,}/g, '.').trim()
    .slice(0, 800);

  try {
    const r = await fetch(`${GOOGLE_TTS_URL}?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text: clean },
        voice: {
          languageCode: 'en-GB',
          name: 'en-GB-Neural2-D',  // Deep British male — closest to Jarvis
        },
        audioConfig: {
          audioEncoding: 'MP3',
          speakingRate: 1.08,
          pitch: -2.0,
          volumeGainDb: 1.5,
        },
      }),
    });

    if (!r.ok) {
      const err = await r.text();
      return res.status(502).json({ error: `Google TTS error: ${err.slice(0, 300)}` });
    }

    const data = await r.json();
    if (!data.audioContent) {
      return res.status(502).json({ error: 'No audioContent in Google TTS response' });
    }

    const audioBuffer = Buffer.from(data.audioContent, 'base64');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).end(audioBuffer);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
