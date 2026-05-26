// 360 Booth Ireland — Event Lead Scanner API
// Called by the dashboard "Scan Now" button.

const EXA_BASE = 'https://api.exa.ai';
const GROQ_BASE = 'https://api.groq.com/openai/v1/chat/completions';

const DEFAULT_QUERIES = [
  // Corporate & Business — Irish cities
  'corporate events Dublin Ireland 2026',
  'business conference networking Ireland 2026',
  'product launch event Dublin Cork 2026',
  'company awards gala dinner Ireland 2026',
  'tech summit conference Ireland 2026',
  // Weddings & Social
  'wedding reception venue hire Dublin Galway Cork 2026',
  'wedding expo Ireland bridal fair 2026',
  'birthday party venue hire Ireland 2026',
  'engagement party event Dublin 2026',
  // Charity & Fundraisers
  'charity ball gala fundraiser Ireland 2026',
  'fundraiser event Dublin charity night 2026',
  'community event fair Ireland 2026',
  // Entertainment & Nightlife
  'nightclub party event Dublin Cork 2026',
  'festival Ireland outdoor event 2026',
  'music event concert venue Ireland 2026',
  // Sports & Special Events
  'sports awards banquet Ireland 2026',
  'golf society dinner event Ireland 2026',
  // Regional
  'events Galway Limerick Waterford 2026',
  'events Cork Kerry Kilkenny 2026',
];

const EVENT_DOMAINS = [
  // Ireland-specific
  'eventbrite.ie', 'entertainment.ie', 'lovin.ie',
  'visitdublin.com', 'discoverireland.ie', 'entertainment.ie',
  // Major event platforms
  'eventbrite.com', 'ticketmaster.ie', 'ticketmaster.com',
  'meetup.com', 'universe.com', 'tickettailor.com',
  // Music & nightlife
  'dice.fm', 'residentadvisor.net', 'skiddle.com',
  'songkick.com', 'bandsintown.com',
  // B2B & conference
  '10times.com', 'allevents.in', 'yapsody.com',
  // Venue & local
  'fatsoma.com', 'goldstar.com',
];

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
    return (data.results || []).map(r => ({ url: r.url, title: r.title }));
  } catch {
    return [];
  }
}

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

async function extractWithGroq(text, title, url, groqKey) {
  if (!text || text.length < 100) return null;
  const prompt = `You are a lead extraction agent for a photo booth hire company in Ireland.
Extract event organiser contact details from this event page content.
Return ONLY valid JSON — use null for missing fields, never invent data:
{"organizer_name":null,"email":null,"phone":null,"event_name":"string","event_date":"YYYY-MM-DD or null","venue":null,"event_type":"wedding|corporate|birthday|party|fundraiser|conference|other"}

Content:
${text.slice(0, 3000)}`;

  try {
    const res = await fetch(GROQ_BASE, {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 300,
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
      event_type: 'other', source_url: url,
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
    createdAt: Date.now(),
  };
}

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

  const queries = [...DEFAULT_QUERIES];
  if (customTerms.trim()) {
    customTerms.split(',').map(t => t.trim()).filter(Boolean).forEach(term => {
      queries.push(`${term} events Ireland`);
    });
  }

  try {
    const allResults = [];
    for (const q of queries) {
      const results = await exaSearch(q, extraDomains, EXA_KEY);
      allResults.push(...results);
    }

    const seen = new Set();
    const unique = allResults.filter(r => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    }).slice(0, 50);

    if (!unique.length) {
      return res.status(200).json({ leads: [], count: 0, scannedAt: new Date().toISOString() });
    }

    const contentMap = await exaContents(unique.map(r => r.url), EXA_KEY);

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

    return res.status(200).json({ leads, count: leads.length, scannedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[scan-leads]', err);
    return res.status(500).json({ error: err.message || 'Scan failed' });
  }
};
