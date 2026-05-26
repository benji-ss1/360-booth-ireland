// 360 Booth Ireland — Lead Scout v6
// Primary: Exa Agent beta (autonomous multi-hop research).
// Fallback: regular Exa search + Groq when Agent is unavailable.
// Groq (GROQ_SCRAPER_KEY) scores all results.

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

function calcUrgency(d) {
  if (!d) return 'unknown';
  try {
    const days = Math.ceil((new Date(d) - Date.now()) / 86400000);
    if (days < 0) return 'past';
    if (days <= 14) return 'urgent';
    if (days <= 30) return 'high';
    if (days <= 90) return 'pipeline';
    return 'long-term';
  } catch { return 'unknown'; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Extract a readable company name from a URL domain as last-resort fallback
function companyFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const domain = host.split('.')[0];
    return domain
      .replace(/[-_]/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim();
  } catch { return null; }
}

// ── PATH A: Exa Agent (beta) ──────────────────────────────────────────────────
async function runExaAgent(query, exaKey) {
  const startRes = await fetch(`${EXA_BASE}/agent/runs`, {
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
            maxItems: 25,
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

  if (!startRes.ok) {
    const body = await startRes.text().catch(() => '');
    throw new Error(`Agent start HTTP ${startRes.status}: ${body.slice(0, 200)}`);
  }

  const run = await startRes.json();
  console.log('[agent] run started:', run.id, 'status:', run.status);

  // Poll up to 50s
  const deadline = Date.now() + 50000;
  let current = run;
  while (Date.now() < deadline) {
    if (current.status === 'completed') {
      console.log('[agent] completed — cost:', JSON.stringify(current.costDollars));
      return current?.output?.structured?.leads || [];
    }
    if (current.status === 'failed' || current.status === 'cancelled') {
      throw new Error(`Agent run ${current.status}`);
    }
    await sleep(4000);
    const pollRes = await fetch(`${EXA_BASE}/agent/runs/${run.id}`, {
      headers: { 'x-api-key': exaKey, 'Exa-Beta': 'agent-2026-05-07' },
    });
    if (pollRes.ok) current = await pollRes.json();
  }
  throw new Error('Agent timed out after 50s');
}

// ── PATH B: Regular Exa search + Groq (fallback) ─────────────────────────────
const FALLBACK_QUERIES = [
  'corporate event management company Dublin Ireland 2026',
  'wedding planner event organiser Dublin Cork Galway 2026',
  'gala dinner charity fundraiser awards Ireland 2026',
  'hotel conference events Dublin Cork 2026 contact',
  'brand activation product launch event Ireland 2026',
  'Christmas party corporate entertainment Dublin 2026',
  'event management agency Ireland upcoming events 2026',
  'graduation ball university event entertainment Ireland 2026',
  'business networking awards ceremony Ireland 2026',
  'photo booth selfie mirror wedding corporate hire Ireland 2026',
];

async function exaSearch(query, exaKey) {
  const res = await fetch(`${EXA_BASE}/search`, {
    method: 'POST',
    headers: { 'x-api-key': exaKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      type: 'auto',
      numResults: 8,
      contents: { highlights: { numSentences: 3, highlightsPerUrl: 2 } },
    }),
  });
  if (!res.ok) {
    console.error('[search] HTTP', res.status, query.slice(0, 50));
    return [];
  }
  const data = await res.json();
  const results = data.results || [];
  console.log('[search]', results.length, 'results for:', query.slice(0, 50));
  return results.map(r => ({
    url: r.url,
    title: r.title || '',
    highlights: Array.isArray(r.highlights)
      ? r.highlights.join(' ')
      : (r.text || ''),
  }));
}

async function exaContentsBatch(urls, exaKey) {
  if (!urls.length) return {};
  const chunks = [];
  for (let i = 0; i < urls.length; i += 10) chunks.push(urls.slice(i, i + 10));
  const maps = await Promise.all(chunks.map(async chunk => {
    try {
      const res = await fetch(`${EXA_BASE}/contents`, {
        method: 'POST',
        headers: { 'x-api-key': exaKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: chunk, text: { maxCharacters: 3000 } }),
      });
      if (!res.ok) {
        console.error('[contents] HTTP', res.status, 'chunk:', chunk.length);
        return {};
      }
      const data = await res.json();
      const map = {};
      for (const r of (data.results || [])) {
        map[r.url] = r.text || r.contents?.text || '';
      }
      console.log('[contents] chunk', chunk.length, '→', Object.values(map).filter(Boolean).length, 'with text');
      return map;
    } catch (err) {
      console.error('[contents] chunk error:', err.message);
      return {};
    }
  }));
  return Object.assign({}, ...maps);
}

async function extractWithGroq(text, title, url, groqKey) {
  // Use whatever content we have — never skip a page entirely
  const fallbackContent = [
    title ? `Company/Event: ${title}` : '',
    `URL: ${url}`,
    `Domain company: ${companyFromUrl(url) || ''}`,
  ].filter(Boolean).join('\n');

  const content = (text && text.length >= 40) ? text : fallbackContent;

  const prompt = `You extract event organiser leads for 360 Booth Ireland (photo booth hire).

From this content return ONLY valid compact JSON (no markdown):
{"event_name":null,"event_date":null,"venue":null,"city":null,"event_type":"corporate|wedding|gala|conference|party|other","organizer_name":null,"company":null,"email":null,"phone":null,"website":null,"lead_score":0}

lead_score 0–100: +25 corporate/company, +20 premium/luxury, +20 Dublin, +15 large attendance, +10 email/phone found, +10 awards/gala, -20 free/volunteer, -15 past event.

If no clear organizer details exist, use the domain name as "company" and the page title as "event_name".

Content:
${content.slice(0, 3500)}`;

  try {
    const res = await fetch(GROQ_BASE, {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 500,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) {
      console.error('[groq] HTTP', res.status);
      return null;
    }
    const data = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');

    // Regex fallbacks for contact info in raw content
    if (!parsed.email) {
      const m = content.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
      if (m) parsed.email = m[0];
    }
    if (!parsed.phone) {
      const m = content.match(/(\+353|0)[\s\-]?\d[\s\-]?\d{3}[\s\-]?\d{4}/);
      if (m) parsed.phone = m[0].replace(/[\s\-]/g, '');
    }

    // Guarantee at least company from domain if Groq found nothing
    if (!parsed.company && !parsed.organizer_name && !parsed.event_name) {
      parsed.company = companyFromUrl(url);
    }
    if (!parsed.event_name && title) parsed.event_name = title;

    parsed.source_url = url;
    return parsed;
  } catch (err) {
    console.error('[groq] error:', err.message, url.slice(0, 60));
    // Hard fallback — always return something
    return {
      event_name: title || null,
      company: companyFromUrl(url),
      email: null, phone: null, website: null,
      venue: null, city: null, event_date: null,
      event_type: 'corporate',
      organizer_name: null,
      lead_score: 15,
      source_url: url,
    };
  }
}

async function runFallbackSearch(customTerms, exaKey, groqKey) {
  const queries = [...FALLBACK_QUERIES];
  if (customTerms) {
    queries.unshift(`${customTerms} event organiser Ireland contact`);
    queries.unshift(`${customTerms} Ireland 2026`);
  }

  const seen = new Set();
  const all = (await Promise.all(queries.map(q => exaSearch(q, exaKey)))).flat();
  const pages = [];
  for (const r of all) {
    if (r.url && !seen.has(r.url)) { seen.add(r.url); pages.push(r); }
    if (pages.length >= 30) break;
  }
  console.log('[fallback] unique pages to extract:', pages.length);

  const contentMap = await exaContentsBatch(pages.map(p => p.url), exaKey);

  const extracted = await Promise.all(pages.map(p => {
    const fullText = contentMap[p.url] || '';
    const text = fullText.length >= 40 ? fullText : p.highlights || '';
    return extractWithGroq(text, p.title, p.url, groqKey);
  }));

  return extracted.filter(Boolean);
}

// ── Groq: score Agent results ─────────────────────────────────────────────────
async function scoreWithGroq(leads, groqKey) {
  if (!leads.length) return leads;
  const prompt = `Score each event lead 0–100 for 360 Booth Ireland (photo booth hire).

+25 corporate/company, +20 premium/luxury/VIP, +20 Dublin, +15 200+ people, +10 email/phone present, +10 awards/gala/conference, -20 free/volunteer, -15 past event.

Return ONLY valid JSON: {"scores":[{"index":0,"lead_score":75,"likelihood":"high"},…]}
likelihood: "high" if ≥60, "medium" if 30–59, else "low".

Leads:
${JSON.stringify(leads.map((l, i) => ({ index: i, event_type: l.event_type, city: l.city, event_name: l.event_name, has_email: !!(l.email), has_phone: !!(l.phone), company: l.company })))}`;

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
      return { ...l, lead_score: s.lead_score ?? l.lead_score ?? 0, likelihood_to_buy: s.likelihood || 'low' };
    });
  } catch (err) {
    console.error('[groq-score] error:', err.message);
    return leads;
  }
}

// ── Map to 360 lead schema ────────────────────────────────────────────────────
function mapToLead(item) {
  // Accept any lead that has at least ONE identifiable field
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
  let rawLeads = [];
  let usedAgent = false;

  // PATH A: Try Exa Agent
  try {
    const agentQuery = [
      'Find 25 upcoming event organisers in Ireland (Dublin, Cork, Galway, Limerick) planning events in 2026 for: corporate gala dinners, awards ceremonies, hotel events, wedding planners, brand activations, charity fundraiser balls, Christmas parties, graduation balls, conference organisers.',
      customTerms ? `Also find: ${customTerms}.` : '',
      'For each, extract: organiser name, company, email, phone, website, event name, event date, venue, city, event type. Prioritise those with direct contact information.',
    ].filter(Boolean).join(' ');

    console.log('[v6] Trying Exa Agent...');
    rawLeads = await runExaAgent(agentQuery, EXA_KEY);
    usedAgent = true;
    console.log('[v6] Agent returned', rawLeads.length, 'raw leads');
  } catch (agentErr) {
    console.warn('[v6] Exa Agent unavailable:', agentErr.message, '— falling back to search');
  }

  // PATH B: Fallback to regular search if Agent failed or returned nothing
  if (!usedAgent || rawLeads.length === 0) {
    console.log('[v6] Running fallback search pipeline...');
    rawLeads = await runFallbackSearch(customTerms, EXA_KEY, GROQ_KEY);
    console.log('[v6] Fallback extracted', rawLeads.length, 'raw items');
  }

  // Score with Groq (always)
  const scored = await scoreWithGroq(rawLeads, GROQ_KEY);
  const leads = scored.map(mapToLead).filter(Boolean);
  leads.sort((a, b) => (b.lead_score || 0) - (a.lead_score || 0));

  console.log(`[v6] Final: ${leads.length} leads (direct:${leads.filter(l => l.contact_quality === 'direct').length}, discovery:${leads.filter(l => l.contact_quality === 'discovery').length}) via ${usedAgent ? 'Agent' : 'fallback search'}`);

  return res.status(200).json({
    leads,
    count: leads.length,
    directCount: leads.filter(l => l.contact_quality === 'direct').length,
    socialCount: leads.filter(l => l.contact_quality === 'social').length,
    discoveryCount: leads.filter(l => l.contact_quality === 'discovery').length,
    eventOnlyCount: leads.filter(l => l.contact_quality === 'event-only').length,
    scannedAt: new Date().toISOString(),
    queriesRun: usedAgent ? 1 : FALLBACK_QUERIES.length,
    pagesScanned: rawLeads.length,
    usedAgent,
  });
};
