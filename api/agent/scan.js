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
        query, numResults: 8, type: 'auto', useAutoprompt: true,
        includeDomains: EVENT_DOMAINS,
        contents: { text: { maxCharacters: 1500 } },
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

async function exaContents(events, exaKey){
  const urls = events.map(e => e.url).filter(Boolean).slice(0, 8);
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
    return events.map(e => ({ ...e, text: map[e.url] || e.text || '' }));
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

async function groqAnalyse(events, groqKey){
  const list = events.slice(0, 12).map((e, i) => ({
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
        content: `You are a lead-scoring AI for 360 Booth Ireland — a premium 360° photo/video booth hire company (€500–€2,000/event). Score each event on its booking potential.

SCORING GUIDE — use the FULL 0-100 range:
90-100: Annual black-tie gala, corporate awards night, end-of-year party at KPMG/EY/Google/Deloitte/Amazon, charity ball, product launch with press
75-89: Corporate conference with evening gala (300+ attendees), professional association dinner, company milestone anniversary, VIP hospitality event
55-74: University graduation ball, large trade show with networking evening, charity auction dinner, corporate team-building at premium venue (200+ people)
30-54: Community fundraiser, sports awards night (<100 people), hotel networking event, small business meetup
10-29: Academic conference, government public event, free community event, small meetup (<50)
0-9: Virtual/online, webinar, regulatory training, student society, political event.

BONUSES: +12 if "gala/awards/ball/ceremony/dinner/launch" in title; +8 if 500+ attendees confirmed; +8 if enterprise brand sponsors named; +6 if black-tie/formal attire stated.
PENALTIES: -20 if online/virtual; -15 if student/academic; -15 if regulatory/compliance; -10 if free entry.

Return valid JSON: {"events":[{"i":1,"lead_score":0,"urgency":"Hot|Warm|Cool|Skip","event_type":"Corporate Gala|Awards Night|Conference|Tech Summit|Charity Ball|Product Launch|Networking|Other","relevance":"one sentence why 360 booth fits or doesn't","action":"precise outreach instruction","attendees_tier":"1000+|500-1000|200-500|50-200|<50|Unknown","organizer":"name or null","email":"from text only or null","email_inferred":"best guess e.g. events@domain.com","phone":"from text or null","contact_hint":"where to find contact"}]}

Events: ${JSON.stringify(list, null, 2)}`,
      }],
      response_format: { type: 'json_object' },
      temperature: 0.15,
    }),
  });
  if (!res.ok){ const e = await res.json().catch(() => ({})); throw new Error(`Groq: ${e.error?.message || res.status}`) }
  const gd = await res.json(); let parsed;
  try{ parsed = JSON.parse(gd.choices[0].message.content) }catch{ throw new Error('Failed to parse Groq response') }
  const ai = parsed.events || [];
  return events.slice(0, 12).map((e, i) => {
    const a = ai.find(x => x.i === i + 1) || {};
    const score = Math.max(0, Math.min(100, a.lead_score || 0));
    const urgency = score >= 80 ? 'Hot' : score >= 55 ? 'Warm' : score >= 25 ? 'Cool' : 'Skip';
    return {
      title: e.title || 'Untitled', url: e.url, domain: e.domain || safeDomain(e.url || ''),
      image: e.image || '', lead_score: score, event_type: a.event_type || 'Other', urgency,
      relevance: a.relevance || '', action: a.action || '', attendees_tier: a.attendees_tier || 'Unknown',
      organizer: a.organizer || '', email: a.email || null, email_inferred: a.email_inferred || null,
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

    return res.status(200).json({ events: scored });
  }catch(err){
    console.error('[agent/scan]', err);
    return res.status(500).json({ error: err.message });
  }
};
