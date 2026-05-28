// 360 Booth Ireland — Jarvis AI Chat proxy
// POST /api/agent/chat { message, context?, searchWeb? }
// Returns { reply, sources? }
// Keys live in Vercel env vars — never exposed to browser.
//
// Required env vars:
//   GROQ_API_KEY  — for Jarvis brain (LLaMA 3.3 70B)
//   EXA_API_KEY   — for live web search (optional; degrades gracefully)

const EXA_BASE  = 'https://api.exa.ai';
const GROQ_BASE = 'https://api.groq.com/openai/v1/chat/completions';

const WEB_SEARCH_RX = /price|cost|€|euro|buy|find|supplier|vendor|shop|product|where|how much|deal|hire|link|website|quote|recommend/i;

async function exaWebSearch(query, exaKey) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(`${EXA_BASE}/search`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'x-api-key': exaKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: query + ' Ireland',
        numResults: 4, type: 'auto', useAutoprompt: true,
        contents: { text: { maxCharacters: 700 } },
      }),
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const d = await res.json();
    return (d.results || []).map(r => ({ title: r.title || '', url: r.url || '', snippet: (r.text || '').slice(0, 500) }));
  } catch { return []; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const EXA_KEY  = process.env.EXA_API_KEY;
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return res.status(500).json({ error: 'Missing GROQ_API_KEY' });

  const { message = '', context = {}, searchWeb = false } = req.body || {};
  if (!message.trim()) return res.status(400).json({ error: 'message is required' });

  const shouldSearch = EXA_KEY && (searchWeb || WEB_SEARCH_RX.test(message));
  const webResults = shouldSearch ? await exaWebSearch(message, EXA_KEY) : [];

  // Build live dashboard context for system prompt
  const { leads = [], scans = [], pipeline = {} } = context;
  const totalLeads = leads.length;
  const hotLeads   = leads.filter(l => l.lead_score >= 80);
  const warmLeads  = leads.filter(l => l.lead_score >= 55 && l.lead_score < 80).length;
  const lastScan   = scans[0];

  const topHot = hotLeads
    .sort((a, b) => b.lead_score - a.lead_score)
    .slice(0, 4)
    .map(l => `  • ${l.title || l.domain} — ${l.lead_score}/100${l.organizer ? ', ' + l.organizer : ''}${l.email ? ', ' + l.email : l.email_inferred ? ', ' + l.email_inferred + ' (est.)' : ''}`)
    .join('\n');

  const pipelineSummary = Object.entries(pipeline)
    .map(([stage, count]) => `${stage}: ${count}`)
    .join(', ');

  const systemPrompt = [
    'You are Jarvis, the AI intelligence officer for 360 Booth Ireland — a premium 360° photo/video booth hire company.',
    'Services: 360 Booth (€800–€2,000/event) and Selfie Mirror (€500–€1,200/event).',
    'Target clients: corporate events, galas, awards nights, product launches, weddings, charity balls across Ireland.',
    '',
    '=== LIVE DASHBOARD DATA ===',
    `Total leads: ${totalLeads}`,
    `Hot leads (≥80): ${hotLeads.length}`,
    `Warm leads (55–79): ${warmLeads}`,
    `Pipeline: ${pipelineSummary || 'empty'}`,
    lastScan
      ? `Last scan: ${new Date(lastScan.ts).toLocaleDateString('en-IE')} — ${lastScan.total || 0} events, ${lastScan.hot || 0} hot`
      : 'Last scan: none',
    topHot ? `\nTop hot leads:\n${topHot}` : '',
    webResults.length
      ? `\n=== WEB SEARCH RESULTS ===\n${webResults.map((r, i) => `[${i+1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n')}`
      : '',
    '',
    'Keep answers concise, direct, and actionable. Use *asterisks* for bold. Reference specific leads and data when relevant.',
  ].filter(Boolean).join('\n');

  try {
    const groqRes = await fetch(GROQ_BASE, {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message },
        ],
        temperature: 0.35,
        max_tokens: 700,
      }),
    });
    if (!groqRes.ok) {
      const e = await groqRes.json().catch(() => ({}));
      return res.status(502).json({ error: e.error?.message || `Groq error ${groqRes.status}` });
    }
    const data = await groqRes.json();
    const reply = data.choices?.[0]?.message?.content || 'No response generated.';
    return res.status(200).json({
      reply,
      sources: webResults.map(r => ({ title: r.title, url: r.url })),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
