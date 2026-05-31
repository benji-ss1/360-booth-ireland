// 360 Booth Ireland — Server-side scan proxy
// POST /api/agent/scan { mode: 'search'|'monitor', query?: string }
// Returns { events: [...scored] }
// Keys live in Vercel env vars — never exposed to the browser.
//
// Required env vars:
//   EXA_API_KEY   — https://dashboard.exa.ai → API Keys
//   GROQ_API_KEY  — https://console.groq.com → API Keys

const EXA_BASE   = 'https://api.exa.ai';
const GROQ_BASE  = 'https://api.groq.com/openai/v1/chat/completions';
const MONITOR_ID = '01ksht4r08s1gdkmr33qw3b6j0';

const EVENT_DOMAINS = [
  'eventbrite.ie','eventbrite.com','ticketmaster.ie',
  'meetup.com','lovin.ie','entertainment.ie',
  'irishvenues.com','weddingsonline.ie','confex.com',
];

function safeDomain(url){
  try{ return new URL(url).hostname.replace(/^www\./, '') }catch{ return '' }
}

async function exaSearch(query, exaKey){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 28000);
  try{
    const res = await fetch(`${EXA_BASE}/search`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'x-api-key': exaKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query, numResults: 15, type: 'auto', useAutoprompt: true,
        includeDomains: EVENT_DOMAINS,
        contents: { text: { maxCharacters: 1200 } },
      }),
    });
    clearTimeout(timer);
    if (!res.ok){ const t = await res.text(); throw new Error(`Exa search ${res.status}: ${t.slice(0,200)}`) }
    const d = await res.json();
    return (d.results || []).map(r => ({
      title: r.title || 'Untitled',
      url:   r.url   || r.id || '',
      domain: safeDomain(r.url || r.id || ''),
      text:  r.text  || '',
      image: r.image || '',
    }));
  }catch(e){
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('Exa search timed out after 28s.');
    throw e;
  }
}

async function exaMonitorRuns(exaKey){
  const res = await fetch(`${EXA_BASE}/monitors/${MONITOR_ID}/runs`, {
    headers: { 'x-api-key': exaKey, accept: 'application/json' },
  });
  if (!res.ok){ const t = await res.text(); throw new Error(`Exa monitor ${res.status}: ${t.slice(0,200)}`) }
  const d = await res.json();
  return Array.isArray(d) ? d : (d.data || d.runs || [d]);
}

// Signals that an event/page is past, closed or sold out — reject immediately
const CLOSED_RX = /\b(bookings?\s+(are\s+)?(now\s+)?closed|booking\s+closed|tickets?\s+(are\s+)?no\s+longer\s+available|event\s+has\s+(passed|ended|concluded)|this\s+event\s+is\s+over|registrations?\s+(are\s+)?closed|sold[\s-]out|event\s+(already\s+)?took\s+place|event\s+was\s+held|event\s+is\s+in\s+the\s+past)\b/i;

function isPageClosed(text, title) {
  return CLOSED_RX.test(text || '') || CLOSED_RX.test(title || '');
}

async function exaContents(events, exaKey){
  const urls = events.map(e => e.url).filter(Boolean).slice(0, 18);
  if (!urls.length) return events;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try{
    const res = await fetch(`${EXA_BASE}/contents`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'x-api-key': exaKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: urls, text: { maxCharacters: 1500 } }),
    });
    clearTimeout(timer);
    if (!res.ok) return events;
    const d = await res.json(); const map = {};
    (d.results || []).forEach(r => { map[r.url || r.id] = r.text || '' });
    // Filter out pages that signal the event is closed/past
    return events
      .map(e => ({ ...e, text: map[e.url] || e.text || '' }))
      .filter(e => !isPageClosed(e.text, e.title));
  }catch(e){ clearTimeout(timer); return events }
}

async function enrichPhones(events, exaKey){
  const need = events.filter(e => !e.phone && e.organizer);
  if (!need.length) return events;
  const phoneRx = /(\+353|0)[\s\-]?[1-9][\d\s\-]{6,12}/g;
  try{
    const settled = await Promise.allSettled(
      need.slice(0, 4).map(e =>
        fetch(`${EXA_BASE}/search`, {
          method: 'POST',
          headers: { 'x-api-key': exaKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: `${e.organizer} contact phone Ireland`, numResults: 2, contents: { text: { maxCharacters: 600 } } }),
        }).then(r => r.ok ? r.json() : null)
      )
    );
    settled.forEach((r, i) => {
      if (r.status !== 'fulfilled' || !r.value) return;
      const text = (r.value.results || []).map(x => x.text || '').join(' ');
      const phones = text.match(phoneRx);
      if (phones && phones[0]) need[i].phone = phones[0].trim();
    });
  }catch(e){}
  return events;
}

// Check if an organizer has previously used a 360/photo booth — competitor intelligence
async function checkBoothHistory(events, exaKey){
  const top = events.filter(e => e.organizer && (e.lead_score || 0) >= 55).slice(0, 6);
  if (!top.length) return events;
  const BOOTH_RX = /\b(360\s*(photo\s*)?booth|photo\s*booth|selfie\s*booth|mirror\s*booth|magic\s*mirror|vogue\s*booth|photobooth|360\s*video)\b/i;
  const COMPETITOR_RX = /\b(360\s*booth\s*ireland|pic\s*a\s*booth|foto\s*booth|fizz\s*booth|snappy|photofly|pixi\s*photo|360\s*craze|snap\s*a\s*pic|party\s*bus|smile\s*photo|wow\s*factor\s*booth|memories|celebration\s*booth)\b/i;

  await Promise.allSettled(top.map(async e => {
    try {
      const q = `"${(e.organizer || '').slice(0, 50)}" "photo booth" OR "360 booth" Ireland event`;
      const res = await fetch(`${EXA_BASE}/search`, {
        method: 'POST',
        headers: { 'x-api-key': exaKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, numResults: 3, contents: { text: { maxCharacters: 800 } } }),
      });
      if (!res.ok) return;
      const d = await res.json();
      const combined = (d.results || []).map(r => (r.text || r.title || '')).join(' ');
      if (BOOTH_RX.test(combined)) {
        e.booth_history = true;
        const cm = combined.match(COMPETITOR_RX);
        e.booth_competitor = cm ? cm[0] : 'Previous booth hire detected';
      }
    } catch {}
  }));
  return events;
}

async function groqAnalyse(events, groqKey){
  const todayISO = new Date().toISOString().slice(0, 10);
  const list = events.slice(0, 20).map((e, i) => ({
    i: i + 1, title: e.title, domain: e.domain,
    text: (e.text || '').slice(0, 2000),
  }));
  const res = await fetch(GROQ_BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{
        role: 'user',
        content: `You are a lead-scoring AI for 360 Booth Ireland — a premium 360° photo/video booth hire company (€500–€2,000/event). Score each event on its booking potential. Today is ${todayISO}.

DATE RULES — critical:
- If the event has a date visible in the title or text and it has ALREADY PASSED (before ${todayISO}), set urgency="Skip" and lead_score=0. Do not show past events.
- Only score events that are upcoming (after ${todayISO}) or have no date mentioned.

SCORING GUIDE — use the FULL 0-100 range:
90-100: Annual black-tie gala, corporate awards night, end-of-year party at KPMG/EY/Google/Deloitte/Amazon, charity ball, product launch with press
75-89: Corporate conference with evening gala (300+ attendees), professional association dinner, company milestone anniversary, VIP hospitality event
55-74: University graduation ball, large trade show with networking evening, charity auction dinner, corporate team-building at premium venue (200+ people)
30-54: Community fundraiser, sports awards night (<100 people), hotel networking event, small business meetup
10-29: Academic conference, government public event, free community event, small meetup (<50)
0-9: Virtual/online, webinar, regulatory training, student society, political event.

BONUSES: +12 if "gala/awards/ball/ceremony/dinner/launch" in title; +8 if 500+ attendees confirmed; +8 if enterprise brand sponsors named; +6 if black-tie/formal attire stated.
PENALTIES: -20 if online/virtual; -15 if student/academic; -15 if regulatory/compliance; -10 if free entry.

EMAIL RULES — critical:
- "email" field: only include if a real specific email address is explicitly written in the page text. Never guess.
- "email_inferred" field: only include a targeted contact email (e.g. events@company.ie) if you are confident it exists. NEVER use info@, hello@, contact@, support@, admin@, press@, media@, noreply@, enquiries@, or any other generic catch-all. If unsure, return null.

Return valid JSON: {"events":[{"i":1,"lead_score":0,"urgency":"Hot|Warm|Cool|Skip","event_type":"Corporate Gala|Awards Night|Conference|Tech Summit|Charity Ball|Product Launch|Networking|Other","relevance":"one sentence why 360 booth fits or doesn't","action":"precise outreach instruction","attendees_tier":"1000+|500-1000|200-500|50-200|<50|Unknown","organizer":"name or null","email":"from text only — never guess","email_inferred":"specific non-generic email or null","phone":"from text or null","contact_hint":"where to find contact"}]}

Events: ${JSON.stringify(list, null, 2)}`,
      }],
      response_format: { type: 'json_object' },
      temperature: 0.15,
    }),
  });
  if (!res.ok){ const e = await res.json().catch(() => ({})); throw new Error(`Groq: ${e.error?.message || res.status}`) }
  const gd = await res.json(); let parsed;
  try{ parsed = JSON.parse(gd.choices[0].message.content) }catch{ throw new Error('Failed to parse Groq response') }
  const GENERIC_EMAIL_RX = /^(info|hello|contact|support|admin|noreply|no-reply|enquir|press|media|office|reception|team|sales|booking|events?|general|mail|post|web|webmaster|editor|feedback|hello)@/i;
  const cleanEmail = (em) => (em && !GENERIC_EMAIL_RX.test(em)) ? em : null;

  const ai = parsed.events || [];
  return events.slice(0, 20).map((e, i) => {
    const a = ai.find(x => x.i === i + 1) || {};
    const score = Math.max(0, Math.min(100, a.lead_score || 0));
    // Respect Groq's Skip (past event) decision; also derive from score
    const urgency = (a.urgency === 'Skip') ? 'Skip' : score >= 80 ? 'Hot' : score >= 55 ? 'Warm' : score >= 25 ? 'Cool' : 'Skip';
    return {
      title: e.title || 'Untitled', url: e.url, domain: e.domain || safeDomain(e.url || ''),
      image: e.image || '', lead_score: score, event_type: a.event_type || 'Other', urgency,
      relevance: a.relevance || '', action: a.action || '', attendees_tier: a.attendees_tier || 'Unknown',
      organizer: a.organizer || '', email: cleanEmail(a.email) || null, email_inferred: cleanEmail(a.email_inferred) || null,
      phone: a.phone || null, contact_hint: a.contact_hint || '',
    };
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const EXA_KEY  = process.env.EXA_API_KEY;
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!EXA_KEY || !GROQ_KEY) {
    return res.status(500).json({ error: 'Missing EXA_API_KEY or GROQ_API_KEY env vars' });
  }

  const { mode = 'monitor', query = '' } = req.body || {};

  try{
    let rawEvents = [];

    if (mode === 'search'){
      if (!query) return res.status(400).json({ error: 'query is required for search mode' });
      rawEvents = await exaSearch(query, EXA_KEY);
      if (!rawEvents.length) return res.status(200).json({ events: [], message: 'No results found. Try a different query.' });
    } else {
      const runs = await exaMonitorRuns(EXA_KEY);
      if (!runs.length) return res.status(200).json({ events: [], message: 'No monitor runs found yet.' });
      const latest = runs[0];
      const results = latest.output?.results || latest.results || [];
      rawEvents = results.map(x => ({
        title: x.title || 'Untitled', url: x.url || x.id || '',
        domain: safeDomain(x.url || x.id || ''), image: x.image || '', text: '',
      }));
      if (!rawEvents.length) return res.status(200).json({ events: [], message: 'Latest monitor run has no results.' });
    }

    const withContent = await exaContents(rawEvents, EXA_KEY);
    const enriched    = await enrichPhones(withContent, EXA_KEY);
    const scored      = await groqAnalyse(enriched, GROQ_KEY);
    // Competitor intelligence — runs only on scored events to save time
    const withHistory = await checkBoothHistory(scored, EXA_KEY);

    return res.status(200).json({ events: withHistory });
  }catch(err){
    console.error('[agent/scan]', err);
    return res.status(500).json({ error: err.message });
  }
};
