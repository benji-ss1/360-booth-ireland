// 360 Booth Ireland — Lead Scout Intelligence Engine v4
// Simplified: open-web queries, no date filter, compact 11-field Groq prompt.
// Core fix: exaContentsBatch (chunks of 10), all queries parallel, highlights fallback.

const EXA_BASE = 'https://api.exa.ai';
const GROQ_BASE = 'https://api.groq.com/openai/v1/chat/completions';

const QUERIES = [
  'corporate event company Dublin Ireland 2026 contact email',
  'wedding venue event hire Ireland 2026 enquiries contact',
  'charity gala fundraiser Dublin Cork Galway 2026 organiser contact',
  'corporate awards ceremony conference Ireland 2026 booking contact',
  'brand activation product launch event Dublin 2026 contact',
  'hotel conference dinner event Dublin 2026 enquiries contact',
  'entertainment hire event Dublin Cork Ireland 2026 quote',
  'event management agency Ireland 2026 upcoming events contact',
  'business gala networking dinner Dublin 2026 registration',
  'graduation ball university event Ireland 2026 entertainment hire',
  'Galway Cork Limerick corporate event 2026 organiser contact',
  'photo booth 360 booth wedding corporate hire Ireland 2026',
  'Christmas party corporate venue Dublin 2026 contact',
  'awards night gala dinner Irish business 2026 organiser',
  'tech summit conference Ireland 2026 event contact registration',
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function inferService(eventType) {
  const t = (eventType || '').toLowerCase();
  return (t === 'wedding' || t === 'birthday' || t === 'party') ? 'Selfie Mirror' : '360 Booth';
}

function extractEmailFallback(text) {
  const m = (text || '').match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0] : null;
}

function extractPhoneFallback(text) {
  const m = (text || '').match(/(\+353|0)[\s\-]?\d[\s\-]?\d{3}[\s\-]?\d{4}/);
  return m ? m[0].replace(/[\s\-]/g, '') : null;
}

function calcUrgency(eventDate) {
  if (!eventDate) return 'unknown';
  try {
    const days = Math.ceil((new Date(eventDate) - Date.now()) / 86400000);
    if (days < 0) return 'past';
    if (days <= 14) return 'urgent';
    if (days <= 30) return 'high';
    if (days <= 90) return 'pipeline';
    return 'long-term';
  } catch { return 'unknown'; }
}

function getContactQuality(e) {
  if (e.email || e.phone) return 'direct';
  if (e.website) return 'social';
  if (e.organizer_name || e.company) return 'discovery';
  if (e.event_name) return 'event-only';
  return null;
}

// ── Exa: open-web search, no date filter ─────────────────────────────────────
async function exaSearch(query, exaKey, numResults = 8) {
  try {
    const res = await fetch(`${EXA_BASE}/search`, {
      method: 'POST',
      headers: { 'x-api-key': exaKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        type: 'auto',
        numResults,
        contents: { highlights: { numSentences: 4, highlightsPerUrl: 2 } },
      }),
    });
    if (!res.ok) {
      console.error('[exa-search] HTTP', res.status, query.slice(0, 60));
      return [];
    }
    const data = await res.json();
    return (data.results || []).map(r => ({
      url: r.url,
      title: r.title || '',
      highlights: (r.highlights || []).join(' '),
    }));
  } catch (err) {
    console.error('[exa-search] error:', err.message, query.slice(0, 60));
    return [];
  }
}

// ── Exa: findSimilar ──────────────────────────────────────────────────────────
async function exaFindSimilar(url, exaKey) {
  try {
    const res = await fetch(`${EXA_BASE}/findSimilar`, {
      method: 'POST',
      headers: { 'x-api-key': exaKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, numResults: 4 }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map(r => ({ url: r.url, title: r.title || '', highlights: '' }));
  } catch (err) {
    console.error('[exa-similar] error:', err.message);
    return [];
  }
}

// ── Exa: content fetch — BATCHED in chunks of 10 (single large POST silently fails)
async function exaContentsBatch(urls, exaKey) {
  if (!urls.length) return {};
  const chunks = [];
  for (let i = 0; i < urls.length; i += 10) chunks.push(urls.slice(i, i + 10));
  const maps = await Promise.all(chunks.map(async chunk => {
    try {
      const res = await fetch(`${EXA_BASE}/contents`, {
        method: 'POST',
        headers: { 'x-api-key': exaKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: chunk, text: { maxCharacters: 4000 } }),
      });
      if (!res.ok) {
        console.error('[exa-contents] HTTP', res.status, 'chunk size', chunk.length);
        return {};
      }
      const data = await res.json();
      const map = {};
      for (const r of (data.results || [])) map[r.url] = r.text || '';
      return map;
    } catch (err) {
      console.error('[exa-contents] chunk error:', err.message);
      return {};
    }
  }));
  return Object.assign({}, ...maps);
}

// ── Groq: compact 11-field prompt — simple enough to never truncate at 600 tokens
async function extractWithGroq(text, title, url, groqKey) {
  const content = (text && text.length >= 30) ? text : (title ? `Event: ${title}\nURL: ${url}` : '');
  if (content.length < 10) return null;

  const prompt = `You extract event organiser leads for 360 Booth Ireland (photo booth hire).

From this web page return ONLY valid compact JSON (no markdown, no explanation):
{"event_name":null,"event_date":null,"venue":null,"city":null,"event_type":"corporate|wedding|gala|conference|party|other","organizer_name":null,"company":null,"email":null,"phone":null,"website":null,"lead_score":0}

lead_score (0–100): +25 corporate/company event, +20 premium/luxury/VIP, +20 Dublin location, +15 200+ attendees, +10 has email or phone, +10 awards/gala/conference, -20 free/volunteer, -15 past event.

Page:
${content.slice(0, 4000)}`;

  try {
    const res = await fetch(GROQ_BASE, {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 600,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) {
      console.error('[groq] HTTP', res.status);
      return null;
    }
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    if (!parsed.email) parsed.email = extractEmailFallback(content);
    if (!parsed.phone) parsed.phone = extractPhoneFallback(content);
    parsed.source_url = url;
    return parsed;
  } catch (err) {
    console.error('[groq] error:', err.message, url.slice(0, 60));
    return {
      event_name: title || null,
      event_date: null, venue: null, city: null,
      event_type: 'other',
      organizer_name: null, company: null,
      email: extractEmailFallback(content),
      phone: extractPhoneFallback(content),
      website: null,
      lead_score: 20,
      source_url: url,
    };
  }
}

function mapToLead(extracted) {
  if (!extracted) return null;
  const cq = getContactQuality(extracted);
  if (!cq) return null;

  const urgency = calcUrgency(extracted.event_date);
  const parts = [];
  if (extracted.event_name) parts.push(`Event: ${extracted.event_name}`);
  if (extracted.event_date) parts.push(`Date: ${extracted.event_date}`);
  if (urgency && urgency !== 'unknown' && urgency !== 'past') parts.push(`Urgency: ${urgency}`);
  if (extracted.venue) parts.push(`Venue: ${extracted.venue}`);
  if (extracted.city) parts.push(`City: ${extracted.city}`);
  if (extracted.company) parts.push(`Company: ${extracted.company}`);
  if (extracted.website) parts.push(`Website: ${extracted.website}`);
  if (extracted.source_url) parts.push(`Source: ${extracted.source_url}`);

  return {
    id: uid(),
    name: extracted.organizer_name || extracted.company || `${extracted.event_name || 'Event'} Organiser`,
    email: extracted.email || '',
    phone: extracted.phone || '',
    source: 'Event Scrape',
    service: inferService(extracted.event_type),
    status: 'New',
    date: new Date().toISOString().slice(0, 10),
    notes: parts.join(' | '),
    lead_score: extracted.lead_score || 0,
    urgency,
    contact_quality: cq,
    source_url: extracted.source_url || '',
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

  const body = req.body || {};
  const customTerms = (body.customTerms || '').trim();
  const queries = [...QUERIES];
  if (customTerms) {
    queries.unshift(`${customTerms} event company Dublin Cork Ireland contact`);
    queries.unshift(`${customTerms} Ireland 2026 organiser contact email`);
  }

  const seen = new Set();
  const meta = { queriesRun: queries.length, pagesScanned: 0 };

  function dedup(results, cap) {
    const fresh = [];
    for (const r of results) {
      if (r.url && !seen.has(r.url)) {
        seen.add(r.url);
        fresh.push(r);
        if (cap && fresh.length >= cap) break;
      }
    }
    return fresh;
  }

  try {
    // All queries fire in parallel — open web, no domain filter, no date filter
    const searchResults = (await Promise.all(queries.map(q => exaSearch(q, EXA_KEY, 8)))).flat();
    let pages = dedup(searchResults, 25);

    // Recursive discovery from top seeds
    if (pages.length >= 3) {
      const seeds = pages.slice(0, 5).map(p => p.url);
      const similar = (await Promise.all(seeds.map(url => exaFindSimilar(url, EXA_KEY)))).flat();
      pages = pages.concat(dedup(similar, 35 - pages.length));
    }

    meta.pagesScanned = pages.length;
    console.log(`[scan-leads] searching ${pages.length} pages via ${meta.queriesRun} queries`);

    // Fetch full content — batched in chunks of 10
    const contentMap = await exaContentsBatch(pages.map(p => p.url), EXA_KEY);

    // All Groq calls in parallel — use highlights as fallback if contents failed
    const extracted = await Promise.all(pages.map(p => {
      const fullText = contentMap[p.url] || '';
      const text = fullText.length >= 30 ? fullText : p.highlights || '';
      return extractWithGroq(text, p.title, p.url, GROQ_KEY);
    }));

    const leads = extracted.map(mapToLead).filter(Boolean);
    leads.sort((a, b) => (b.lead_score || 0) - (a.lead_score || 0));

    console.log(`[scan-leads] done: ${leads.length} leads (direct:${leads.filter(l=>l.contact_quality==='direct').length}, discovery:${leads.filter(l=>l.contact_quality==='discovery').length})`);

    return res.status(200).json({
      leads,
      count: leads.length,
      directCount: leads.filter(l => l.contact_quality === 'direct').length,
      socialCount: leads.filter(l => l.contact_quality === 'social').length,
      discoveryCount: leads.filter(l => l.contact_quality === 'discovery').length,
      eventOnlyCount: leads.filter(l => l.contact_quality === 'event-only').length,
      scannedAt: new Date().toISOString(),
      ...meta,
    });

  } catch (err) {
    console.error('[scan-leads] fatal:', err);
    return res.status(500).json({ error: err.message || 'Scan failed' });
  }
};
