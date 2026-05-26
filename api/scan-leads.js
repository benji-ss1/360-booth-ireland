// 360 Booth Ireland — Lead Scout (clean rebuild)
// Plain Exa search → batched content fetch → Groq extraction → scored leads.
// No Exa Agent. No embedded contents in search. Always produces something per page.

const EXA_BASE = 'https://api.exa.ai';
const GROQ_BASE = 'https://api.groq.com/openai/v1/chat/completions';

const QUERIES = [
  'corporate events Dublin 2026',
  'wedding events Ireland 2026',
  'gala dinner charity ball Ireland 2026',
  'awards ceremony conference Ireland 2026',
  'brand activation product launch event Dublin 2026',
  'event management company Dublin Ireland',
  'hotel conference dinner booking Dublin Cork 2026',
  'Christmas party corporate entertainment Ireland 2026',
  'graduation ball university event Ireland 2026',
  'business networking gala Dublin Cork 2026',
  'event organiser contact Ireland 2026',
  'corporate entertainment hire Ireland',
  'event venue hire Dublin Galway Cork 2026',
  'photo booth selfie mirror hire wedding Ireland',
  'fundraiser gala charity event Ireland 2026',
];

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

function companyFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const domain = host.split('.')[0];
    return domain.replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, c => c.toUpperCase()).trim();
  } catch { return null; }
}

// ── Exa search — PLAIN, no embedded contents ─────────────────────────────────
async function exaSearch(query, exaKey, numResults = 8) {
  try {
    const res = await fetch(`${EXA_BASE}/search`, {
      method: 'POST',
      headers: { 'x-api-key': exaKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, type: 'auto', numResults }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[search] HTTP', res.status, query.slice(0, 40), body.slice(0, 100));
      return [];
    }
    const data = await res.json();
    const results = data.results || [];
    console.log('[search]', results.length, 'results —', query.slice(0, 40));
    return results.map(r => ({ url: r.url, title: r.title || '' }));
  } catch (err) {
    console.error('[search] error:', err.message, query.slice(0, 40));
    return [];
  }
}

// ── Exa content fetch — batched in groups of 10 ──────────────────────────────
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
        const body = await res.text().catch(() => '');
        console.error('[contents] HTTP', res.status, body.slice(0, 100));
        return {};
      }
      const data = await res.json();
      const map = {};
      for (const r of (data.results || [])) {
        map[r.url] = r.text || r.contents?.text || '';
      }
      const withText = Object.values(map).filter(t => t.length > 50).length;
      console.log('[contents] chunk', chunk.length, '→', withText, 'pages with content');
      return map;
    } catch (err) {
      console.error('[contents] chunk error:', err.message);
      return {};
    }
  }));

  return Object.assign({}, ...maps);
}

// ── Groq: extract lead data ───────────────────────────────────────────────────
async function extractWithGroq(text, title, url, groqKey) {
  // Build content — fall back to title + domain if page text is empty
  const domainName = companyFromUrl(url) || '';
  const content = (text && text.length >= 50)
    ? text
    : `Page title: ${title || '(no title)'}\nWebsite: ${url}\nCompany (from domain): ${domainName}`;

  const prompt = `Extract event organiser lead info for 360 Booth Ireland (photo booth hire).

Return ONLY valid JSON, no extra text:
{"event_name":null,"event_date":null,"venue":null,"city":null,"event_type":"corporate|wedding|gala|conference|party|other","organizer_name":null,"company":null,"email":null,"phone":null,"website":null,"lead_score":0}

lead_score 0–100: +25 corporate event, +20 luxury/VIP, +20 Dublin, +15 200+ people, +10 email/phone found, +10 awards/gala, -20 free event, -15 past event.
If no organiser name or company found in text, use the domain name as "company".
If no event name found, use the page title as "event_name".

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
        max_tokens: 400,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) {
      console.error('[groq] HTTP', res.status);
      return null;
    }
    const data = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');

    // Regex fallbacks for email/phone in the raw content
    if (!parsed.email) {
      const m = content.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
      if (m) parsed.email = m[0];
    }
    if (!parsed.phone) {
      const m = content.match(/(\+353|0)[\s\-]?\d[\s\-]?\d{3}[\s\-]?\d{4}/);
      if (m) parsed.phone = m[0].replace(/[\s\-]/g, '');
    }

    // Guarantee at least company and event_name so lead isn't dropped
    if (!parsed.company && !parsed.organizer_name) parsed.company = domainName || null;
    if (!parsed.event_name && title) parsed.event_name = title;

    parsed.source_url = url;
    return parsed;
  } catch (err) {
    console.error('[groq] parse error:', err.message, url.slice(0, 60));
    // Hard fallback — always return something usable
    const m = content.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
    return {
      event_name: title || null,
      company: domainName || null,
      email: m ? m[0] : null,
      phone: null, website: null, venue: null, city: null,
      event_date: null, event_type: 'corporate', organizer_name: null,
      lead_score: 20, source_url: url,
    };
  }
}

// ── Groq: batch score ─────────────────────────────────────────────────────────
async function scoreLeads(leads, groqKey) {
  if (leads.length === 0) return leads;
  const prompt = `Score event leads for 360 Booth Ireland. Return ONLY JSON: {"scores":[{"index":0,"lead_score":70,"likelihood":"high"},…]}
likelihood: "high"≥60, "medium" 30–59, "low"<30.
+25 corporate event, +20 luxury/VIP, +20 Dublin, +15 200+ people, +10 has email/phone, +10 awards/gala, -20 free event.

Leads: ${JSON.stringify(leads.map((l, i) => ({ index: i, event_type: l.event_type, city: l.city, company: l.company, has_email: !!l.email, has_phone: !!l.phone })))}`;

  try {
    const res = await fetch(GROQ_BASE, {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1, max_tokens: 600,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) return leads;
    const data = await res.json();
    const { scores = [] } = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    return leads.map((l, i) => {
      const s = scores.find(x => x.index === i) || {};
      return { ...l, lead_score: s.lead_score ?? l.lead_score ?? 0, likelihood_to_buy: s.likelihood || 'low' };
    });
  } catch (err) {
    console.error('[groq-score]', err.message);
    return leads;
  }
}

// ── Map raw extraction to 360 lead schema ─────────────────────────────────────
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
  const queries = [...QUERIES];
  if (customTerms) {
    queries.unshift(`${customTerms} Ireland event organiser 2026`);
    queries.unshift(`${customTerms} event contact Dublin Cork`);
  }

  // 1. Search — all queries in parallel, plain (no embedded contents)
  const searchStart = Date.now();
  const allResults = (await Promise.all(queries.map(q => exaSearch(q, EXA_KEY)))).flat();
  console.log('[scan] search done in', Date.now() - searchStart, 'ms,', allResults.length, 'total results');

  // Deduplicate
  const seen = new Set();
  const pages = [];
  for (const r of allResults) {
    if (r.url && !seen.has(r.url)) {
      seen.add(r.url);
      pages.push(r);
      if (pages.length >= 30) break;
    }
  }
  console.log('[scan]', pages.length, 'unique pages to process');

  if (pages.length === 0) {
    return res.status(200).json({
      leads: [], count: 0,
      directCount: 0, socialCount: 0, discoveryCount: 0, eventOnlyCount: 0,
      scannedAt: new Date().toISOString(),
      queriesRun: queries.length,
      pagesScanned: 0,
      error: 'Exa returned no search results — check EXA_API_KEY or try again later.',
    });
  }

  // 2. Fetch page content — batched
  const contentMap = await exaContentsBatch(pages.map(p => p.url), EXA_KEY);

  // 3. Extract leads — all Groq calls in parallel
  const extracted = await Promise.all(
    pages.map(p => extractWithGroq(contentMap[p.url] || '', p.title, p.url, GROQ_KEY))
  );
  console.log('[scan] extracted', extracted.filter(Boolean).length, 'non-null from', pages.length, 'pages');

  // 4. Score
  const validExtracted = extracted.filter(Boolean);
  const scored = await scoreLeads(validExtracted, GROQ_KEY);

  // 5. Map and sort
  const leads = scored.map(mapToLead).filter(Boolean);
  leads.sort((a, b) => (b.lead_score || 0) - (a.lead_score || 0));
  console.log('[scan] DONE:', leads.length, 'leads (direct:', leads.filter(l => l.contact_quality === 'direct').length, ')');

  return res.status(200).json({
    leads,
    count: leads.length,
    directCount: leads.filter(l => l.contact_quality === 'direct').length,
    socialCount: leads.filter(l => l.contact_quality === 'social').length,
    discoveryCount: leads.filter(l => l.contact_quality === 'discovery').length,
    eventOnlyCount: leads.filter(l => l.contact_quality === 'event-only').length,
    scannedAt: new Date().toISOString(),
    queriesRun: queries.length,
    pagesScanned: pages.length,
  });
};
