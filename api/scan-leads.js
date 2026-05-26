// 360 Booth Ireland — Lead Scout Intelligence Engine
// Multi-source autonomous prospecting: Exa search + research + findSimilar → Groq scoring

const EXA_BASE = 'https://api.exa.ai';
const GROQ_BASE = 'https://api.groq.com/openai/v1/chat/completions';

// ── 30+ semantic query variants across all event types ──────────────────────
const DEFAULT_QUERIES = [
  // Corporate & Business
  'corporate event Dublin Ireland 2026',
  'business awards gala ceremony Ireland 2026',
  'product launch brand activation Dublin 2026',
  'company conference summit Ireland 2026',
  'tech startup launch party Dublin Cork 2026',
  'networking event business association Ireland 2026',
  'trade show expo exhibition Ireland 2026',
  'B2B corporate hospitality event Dublin 2026',
  // Weddings & Social
  'luxury wedding reception venue hire Ireland 2026',
  'bridal expo wedding fair Ireland 2026',
  'wedding party Dublin Galway Cork 2026',
  'engagement party celebration event Ireland 2026',
  // Charity & Fundraisers
  'charity gala ball fundraiser dinner Ireland 2026',
  'fundraising event auction dinner Dublin 2026',
  // Entertainment & Nightlife
  'nightclub club night party event Dublin Cork 2026',
  'festival outdoor event summer Ireland 2026',
  'music live event concert venue Ireland 2026',
  // Universities & Graduation
  'university college graduation event Ireland 2026',
  'student union event college party Ireland 2026',
  'graduation ball prom event Ireland 2026',
  // Sport & Awards
  'sports awards banquet dinner Ireland 2026',
  'golf classic society corporate dinner Ireland 2026',
  // Seasonal & Christmas
  'Christmas party corporate event Dublin 2026',
  'New Year event gala celebration Ireland 2026',
  'summer party outdoor corporate Ireland 2026',
  // Influencer & Brand
  'influencer event brand launch activation Dublin 2026',
  'experiential marketing event Dublin 2026',
  // Regional
  'events Galway Limerick Waterford 2026 venue',
  'events Cork Kerry Kilkenny Wexford 2026',
  'hospitality venue hotel event Ireland 2026',
];

// ── 25+ event platform domains ───────────────────────────────────────────────
const EVENT_DOMAINS = [
  // Ireland
  'eventbrite.ie', 'entertainment.ie', 'lovin.ie',
  'visitdublin.com', 'discoverireland.ie',
  // Major global platforms
  'eventbrite.com', 'ticketmaster.ie', 'ticketmaster.com',
  'meetup.com', 'universe.com', 'tickettailor.com',
  // Music & nightlife
  'dice.fm', 'residentadvisor.net', 'skiddle.com',
  'songkick.com', 'bandsintown.com',
  // B2B & corporate
  '10times.com', 'allevents.in', 'yapsody.com',
  'eventzilla.net', 'splash.com',
  // Social & community
  'lu.ma', 'humanitix.com', 'fever.com',
  // Venue/local
  'fatsoma.com', 'goldstar.com',
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function inferService(eventType) {
  const t = (eventType || '').toLowerCase();
  if (t === 'wedding' || t === 'birthday' || t === 'party') return 'Selfie Mirror';
  return '360 Booth';
}

function extractEmailFallback(text) {
  const m = (text || '').match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0] : null;
}

function extractPhoneFallback(text) {
  const m = (text || '').match(/(\+353|0)[\s\-]?\d[\s\-]?\d{3}[\s\-]?\d{4}/);
  return m ? m[0].replace(/[\s\-]/g, '') : null;
}

// ── Exa: standard search ─────────────────────────────────────────────────────
async function exaSearch(query, extraDomains, exaKey) {
  const today = new Date().toISOString().slice(0, 10);
  const nextYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const domains = extraDomains?.length ? [...EVENT_DOMAINS, ...extraDomains] : EVENT_DOMAINS;
  try {
    const res = await fetch(`${EXA_BASE}/search`, {
      method: 'POST',
      headers: { 'x-api-key': exaKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        type: 'auto',
        numResults: 10,
        startPublishedDate: today,
        endPublishedDate: nextYear,
        includeDomains: domains,
        contents: { highlights: true },
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map(r => ({ url: r.url, title: r.title || '' }));
  } catch {
    return [];
  }
}

// ── Exa: findSimilar — recursive discovery from a seed URL ───────────────────
async function exaFindSimilar(url, exaKey) {
  try {
    const res = await fetch(`${EXA_BASE}/findSimilar`, {
      method: 'POST',
      headers: { 'x-api-key': exaKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        numResults: 5,
        includeDomains: EVENT_DOMAINS,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map(r => ({ url: r.url, title: r.title || '' }));
  } catch {
    return [];
  }
}

// ── Exa: batch fetch page content ────────────────────────────────────────────
async function exaContents(urls, exaKey) {
  if (!urls.length) return {};
  try {
    const res = await fetch(`${EXA_BASE}/contents`, {
      method: 'POST',
      headers: { 'x-api-key': exaKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: urls, text: { maxCharacters: 4000 } }),
    });
    if (!res.ok) return {};
    const data = await res.json();
    const map = {};
    for (const r of (data.results || [])) map[r.url] = r;
    return map;
  } catch {
    return {};
  }
}

// ── Groq: extract contacts + score lead 0–100 ─────────────────────────────
async function extractWithGroq(text, title, url, groqKey) {
  if (!text || text.length < 80) return null;

  const prompt = `You are a lead extraction and scoring agent for 360 Booth Ireland, a premium photo booth hire company.

Analyse this event page and return ONLY valid JSON. Never invent data — use null for missing fields.

Return:
{
  "organizer_name": null,
  "email": null,
  "phone": null,
  "event_name": "string",
  "event_date": "YYYY-MM-DD or null",
  "venue": null,
  "event_type": "wedding|corporate|birthday|party|fundraiser|conference|graduation|festival|nightlife|sports|university|other",
  "attendance_estimate": null,
  "lead_score": 0,
  "score_reason": "one sentence"
}

LEAD SCORING GUIDE (total 0–100):
Add:
+25 if corporate launch / product activation / brand event
+20 if wedding or luxury event
+20 if large attendance (200+ people)
+15 if premium Dublin/Cork/Galway venue
+15 if conference / awards / gala dinner
+15 if graduation / university ball
+10 if charity gala or fundraiser ball
+10 if nightclub / club night with capacity
+10 if festival or outdoor event

Subtract:
-20 if free/volunteer community meetup
-15 if no entertainment or photo element mentioned
-10 if very small local gathering under 30 people

Content:
${text.slice(0, 3500)}`;

  try {
    const res = await fetch(GROQ_BASE, {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 350,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    if (!parsed.email) parsed.email = extractEmailFallback(text);
    if (!parsed.phone) parsed.phone = extractPhoneFallback(text);
    parsed.source_url = url;
    return parsed;
  } catch {
    return {
      organizer_name: null,
      email: extractEmailFallback(text),
      phone: extractPhoneFallback(text),
      event_name: title || 'Unknown Event',
      event_date: null, venue: null,
      event_type: 'other', attendance_estimate: null,
      lead_score: 30, score_reason: 'Fallback extraction',
      source_url: url,
    };
  }
}

function mapToLead(extracted) {
  if (!extracted) return null;
  const today = new Date().toISOString().slice(0, 10);
  const parts = [];
  if (extracted.event_name) parts.push(`Event: ${extracted.event_name}`);
  if (extracted.event_date) parts.push(`Date: ${extracted.event_date}`);
  if (extracted.venue) parts.push(`Venue: ${extracted.venue}`);
  if (extracted.attendance_estimate) parts.push(`Est. attendance: ${extracted.attendance_estimate}`);
  if (extracted.score_reason) parts.push(`Score: ${extracted.lead_score}/100 — ${extracted.score_reason}`);
  if (extracted.source_url) parts.push(`Source: ${extracted.source_url}`);
  return {
    id: uid(),
    name: extracted.organizer_name || `${extracted.event_name || 'Event'} Organiser`,
    email: extracted.email || '',
    phone: extracted.phone || '',
    source: 'Event Scrape',
    service: inferService(extracted.event_type),
    status: 'New',
    date: today,
    notes: parts.join(' | '),
    lead_score: extracted.lead_score || 0,
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
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!EXA_KEY || !GROQ_KEY) {
    return res.status(500).json({ error: 'EXA_API_KEY and GROQ_API_KEY must be set in Vercel environment variables.' });
  }

  const body = req.body || {};
  const customTerms = body.customTerms || '';
  const extraDomains = body.extraDomains || [];

  // Build query list — default + custom terms as semantic expansions
  const queries = [...DEFAULT_QUERIES];
  if (customTerms.trim()) {
    const base = customTerms.trim();
    // Generate semantic variants from the custom term
    queries.push(`${base} Ireland 2026`);
    queries.push(`${base} event organiser contact Ireland`);
    queries.push(`${base} venue booking Dublin Cork Galway`);
  }

  try {
    // LAYER 1: Discovery — run all queries in parallel batches
    const allResults = [];
    for (let i = 0; i < queries.length; i += 5) {
      const batch = queries.slice(i, i + 5);
      const batchResults = await Promise.all(
        batch.map(q => exaSearch(q, extraDomains, EXA_KEY))
      );
      for (const r of batchResults) allResults.push(...r);
    }

    // LAYER 2: Deduplication — cap at 50 unique URLs
    const seen = new Set();
    let unique = allResults.filter(r => {
      if (!r.url || seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    }).slice(0, 50);

    if (!unique.length) {
      return res.status(200).json({ leads: [], count: 0, scannedAt: new Date().toISOString() });
    }

    // LAYER 2b: Recursive discovery — findSimilar on top 6 results for broader coverage
    const seedUrls = unique.slice(0, 6).map(r => r.url);
    const similarResults = await Promise.all(
      seedUrls.map(url => exaFindSimilar(url, EXA_KEY))
    );
    for (const batch of similarResults) {
      for (const r of batch) {
        if (r.url && !seen.has(r.url)) {
          seen.add(r.url);
          unique.push(r);
        }
      }
    }
    unique = unique.slice(0, 60);

    // LAYER 3: Extraction — fetch page content in batches
    const contentMap = await exaContents(unique.map(r => r.url), EXA_KEY);

    // LAYER 3b: AI Enrichment — extract and score in parallel batches of 8
    const leads = [];
    for (let i = 0; i < unique.length; i += 8) {
      const batch = unique.slice(i, i + 8);
      const extracted = await Promise.all(
        batch.map(r => {
          const c = contentMap[r.url];
          return extractWithGroq(c?.text || '', r.title || '', r.url, GROQ_KEY);
        })
      );
      for (const e of extracted) {
        const lead = mapToLead(e);
        if (lead && (lead.email || lead.phone)) leads.push(lead);
      }
    }

    // LAYER 4: Sort by lead score descending
    leads.sort((a, b) => (b.lead_score || 0) - (a.lead_score || 0));

    return res.status(200).json({
      leads,
      count: leads.length,
      scannedAt: new Date().toISOString(),
      pagesScanned: unique.length,
    });

  } catch (err) {
    console.error('[scan-leads]', err);
    return res.status(500).json({ error: err.message || 'Scan failed' });
  }
};
