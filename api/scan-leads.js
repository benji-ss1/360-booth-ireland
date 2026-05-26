// 360 Booth Ireland — Lead Scout v5
// Exa Agent beta handles autonomous multi-hop research (search + crawl + extract).
// Groq (GROQ_SCRAPER_KEY) scores and filters the structured results.

const EXA_BASE = 'https://api.exa.ai';
const GROQ_BASE = 'https://api.groq.com/openai/v1/chat/completions';

// ── Helpers ───────────────────────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function inferService(type) {
  const t = (type || '').toLowerCase();
  return (t === 'wedding' || t === 'birthday' || t === 'party') ? 'Selfie Mirror' : '360 Booth';
}

function calcUrgency(dateStr) {
  if (!dateStr) return 'unknown';
  try {
    const days = Math.ceil((new Date(dateStr) - Date.now()) / 86400000);
    if (days < 0) return 'past';
    if (days <= 14) return 'urgent';
    if (days <= 30) return 'high';
    if (days <= 90) return 'pipeline';
    return 'long-term';
  } catch { return 'unknown'; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Exa Agent: start a research run ──────────────────────────────────────────
async function startAgentRun(query, exaKey) {
  const res = await fetch(`${EXA_BASE}/agent/runs`, {
    method: 'POST',
    headers: {
      'x-api-key': exaKey,
      'Content-Type': 'application/json',
      'Exa-Beta': 'agent-2026-05-07',
    },
    body: JSON.stringify({
      query,
      effort: 'low',
      outputSchema: {
        type: 'object',
        required: ['leads'],
        properties: {
          leads: {
            type: 'array',
            maxItems: 30,
            items: {
              type: 'object',
              properties: {
                event_name:     { type: 'string' },
                event_date:     { type: 'string' },
                venue:          { type: 'string' },
                city:           { type: 'string' },
                event_type:     { type: 'string' },
                organizer_name: { type: 'string' },
                company:        { type: 'string' },
                email:          { type: 'string' },
                phone:          { type: 'string' },
                website:        { type: 'string' },
                source_url:     { type: 'string' },
              },
            },
          },
        },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => res.status);
    throw new Error(`Exa Agent start failed (${res.status}): ${body}`);
  }
  return res.json();
}

// ── Exa Agent: poll until done or timeout ────────────────────────────────────
async function pollAgentRun(runId, exaKey, maxMs = 52000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await sleep(4000);
    const res = await fetch(`${EXA_BASE}/agent/runs/${runId}`, {
      headers: {
        'x-api-key': exaKey,
        'Exa-Beta': 'agent-2026-05-07',
      },
    });
    if (!res.ok) continue;
    const run = await res.json();
    if (run.status === 'completed') return run;
    if (run.status === 'failed' || run.status === 'cancelled') {
      throw new Error(`Agent run ${run.status}`);
    }
  }
  throw new Error('Agent run did not complete within 52s — try again or use a shorter search term.');
}

// ── Groq: score each lead (uses GROQ_SCRAPER_KEY) ────────────────────────────
async function scoreWithGroq(leads, groqKey) {
  if (!leads.length) return leads;
  const prompt = `You score event leads for 360 Booth Ireland (photo booth hire).

Score each lead 0–100. Rules:
+25 corporate/company event, +20 luxury/premium/VIP, +20 Dublin location, +15 200+ attendees, +10 email or phone present, +10 awards/gala/conference, -20 free/volunteer event, -15 past event, -10 outside Ireland.

Return ONLY valid JSON: {"scores":[{"index":0,"lead_score":75,"likelihood":"high"},…]}
likelihood: "high" if score≥60, "medium" if 30–59, else "low".

Leads to score:
${JSON.stringify(leads.map((l, i) => ({
  index: i,
  event_type: l.event_type,
  city: l.city,
  event_name: l.event_name,
  has_email: !!l.email,
  has_phone: !!l.phone,
  company: l.company,
})))}`;

  try {
    const res = await fetch(GROQ_BASE, {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 800,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) return leads;
    const data = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    const scores = parsed.scores || [];
    return leads.map((l, i) => {
      const s = scores.find(x => x.index === i) || {};
      return { ...l, lead_score: s.lead_score || 0, likelihood_to_buy: s.likelihood || 'low' };
    });
  } catch (err) {
    console.error('[groq-score] error:', err.message);
    return leads;
  }
}

// ── Map Exa Agent result to 360 lead schema ───────────────────────────────────
function mapToLead(item) {
  const cq = item.email || item.phone ? 'direct'
    : item.website ? 'social'
    : item.organizer_name || item.company ? 'discovery'
    : item.event_name ? 'event-only'
    : null;
  if (!cq) return null;

  const urgency = calcUrgency(item.event_date);
  const parts = [];
  if (item.event_name) parts.push(`Event: ${item.event_name}`);
  if (item.event_date) parts.push(`Date: ${item.event_date}`);
  if (urgency && urgency !== 'unknown' && urgency !== 'past') parts.push(`Urgency: ${urgency}`);
  if (item.venue) parts.push(`Venue: ${item.venue}`);
  if (item.city) parts.push(`City: ${item.city}`);
  if (item.company) parts.push(`Company: ${item.company}`);
  if (item.website) parts.push(`Website: ${item.website}`);
  if (item.likelihood_to_buy) parts.push(`Likelihood: ${item.likelihood_to_buy}`);
  if (item.source_url) parts.push(`Source: ${item.source_url}`);

  return {
    id: uid(),
    name: item.organizer_name || item.company || `${item.event_name || 'Event'} Organiser`,
    email: item.email || '',
    phone: item.phone || '',
    source: 'Event Scrape',
    service: inferService(item.event_type),
    status: 'New',
    date: new Date().toISOString().slice(0, 10),
    notes: parts.join(' | '),
    lead_score: item.lead_score || 0,
    likelihood_to_buy: item.likelihood_to_buy || 'low',
    urgency,
    contact_quality: cq,
    source_url: item.source_url || '',
    createdAt: Date.now(),
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const EXA_KEY = process.env.EXA_API_KEY;
  const GROQ_KEY = process.env.GROQ_SCRAPER_KEY || process.env.GROQ_API_KEY;
  if (!EXA_KEY || !GROQ_KEY) {
    return res.status(500).json({ error: 'EXA_API_KEY and GROQ_SCRAPER_KEY must be set in Vercel environment variables.' });
  }

  const customTerms = (req.body?.customTerms || '').trim();
  const query = [
    'Find 25 event organisers in Ireland (Dublin, Cork, Galway, Limerick, Waterford) planning events in 2026 that would benefit from a 360 photo booth or selfie mirror entertainment service.',
    'Target: corporate gala dinners, awards ceremonies, company Christmas parties, brand activation events, product launches, hotel conference managers, wedding planners, charity fundraiser balls, university graduation balls, networking event organisers.',
    customTerms ? `Also specifically search for: ${customTerms}.` : '',
    'For each organiser, extract: organiser name, company name, email address, phone number, website, event name, event date, venue name, city, and event type.',
    'Prioritise results with direct contact information (email or phone). Focus on events with professional budgets.',
  ].filter(Boolean).join(' ');

  try {
    console.log('[scan-leads v5] Starting Exa Agent run — effort: low');
    const run = await startAgentRun(query, EXA_KEY);
    console.log('[scan-leads v5] Run queued:', run.id, '— polling...');

    const completed = await pollAgentRun(run.id, EXA_KEY, 52000);
    const rawLeads = completed?.output?.structured?.leads || [];
    console.log('[scan-leads v5] Agent done — raw leads:', rawLeads.length, '— cost:', JSON.stringify(completed?.costDollars));

    const scored = await scoreWithGroq(rawLeads, GROQ_KEY);
    const leads = scored.map(mapToLead).filter(Boolean);
    leads.sort((a, b) => (b.lead_score || 0) - (a.lead_score || 0));

    console.log('[scan-leads v5] Final leads:', leads.length, `(direct:${leads.filter(l=>l.contact_quality==='direct').length})`);

    return res.status(200).json({
      leads,
      count: leads.length,
      directCount: leads.filter(l => l.contact_quality === 'direct').length,
      socialCount: leads.filter(l => l.contact_quality === 'social').length,
      discoveryCount: leads.filter(l => l.contact_quality === 'discovery').length,
      eventOnlyCount: leads.filter(l => l.contact_quality === 'event-only').length,
      scannedAt: new Date().toISOString(),
      queriesRun: 1,
      pagesScanned: rawLeads.length,
    });

  } catch (err) {
    console.error('[scan-leads v5] error:', err.message);
    return res.status(500).json({ error: err.message || 'Scan failed' });
  }
};
