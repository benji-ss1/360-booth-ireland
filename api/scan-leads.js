// 360 Booth Ireland — Lead Scout Intelligence Engine v2
// Full autonomous event intelligence: Exa multi-layer search + recursive enrichment + Groq scoring

const EXA_BASE = 'https://api.exa.ai';
const GROQ_BASE = 'https://api.groq.com/openai/v1/chat/completions';

// ── 50+ semantic query variants — Dublin, Cork, Galway, Limerick ─────────────
const DEFAULT_QUERIES = [
  // ── Corporate / Business ──────────────────────────────────
  'Dublin corporate events 2026',
  'Dublin business networking events 2026',
  'Dublin conferences summit 2026',
  'Dublin company launches events 2026',
  'Dublin startup ecosystem events 2026',
  'Dublin award ceremonies 2026',
  'Dublin gala dinners 2026',
  'Dublin product launches 2026',
  'Dublin executive networking events 2026',
  'Dublin technology meetups 2026',
  'Dublin business expos trade show 2026',
  'Dublin investor events 2026',
  'Dublin luxury premium hospitality events 2026',
  'Dublin experiential marketing brand activation 2026',
  'Dublin Christmas party corporate event 2026',
  'Dublin company party venue hire 2026',

  // ── Brand / Influencer / Experiential ─────────────────────
  'brand activation event Dublin Ireland 2026',
  'influencer event brand launch Dublin 2026',
  'experiential marketing activation Ireland 2026',
  'product launch party event Dublin Cork 2026',
  'hospitality launch reception Ireland 2026',

  // ── Weddings / Luxury ─────────────────────────────────────
  'luxury wedding reception venue hire Ireland 2026',
  'Dublin luxury weddings 2026',
  'bridal expo wedding fair Ireland 2026',
  'wedding venue event Dublin Galway Cork 2026',

  // ── Charity / Fundraisers ─────────────────────────────────
  'charity gala ball fundraiser dinner Ireland 2026',
  'fundraising gala auction dinner Dublin 2026',
  'black tie charity ball Ireland 2026',

  // ── University / Graduation ───────────────────────────────
  'Dublin university events 2026',
  'university college graduation ball Ireland 2026',
  'student union event college party Ireland 2026',
  'UCD Trinity DCU graduation event 2026',
  'Dublin university gala prom 2026',

  // ── Sports / Awards ───────────────────────────────────────
  'sports awards banquet dinner Ireland 2026',
  'golf classic corporate dinner Ireland 2026',
  'sports gala ceremony Ireland 2026',

  // ── Entertainment / Nightlife / Festivals ─────────────────
  'festival outdoor event summer Ireland 2026',
  'nightclub event party Dublin Cork 2026',
  'music live concert venue Ireland 2026',
  'Dice events Dublin 2026',
  'Resident Advisor Dublin events 2026',

  // ── Cork / Galway / Regional ──────────────────────────────
  'Cork corporate events conferences 2026',
  'Galway business events networking 2026',
  'Limerick corporate events 2026',
  'events Galway Limerick Waterford 2026',
  'events Cork Kerry Kilkenny Wexford 2026',
  'hospitality venue hotel event Cork Galway 2026',

  // ── News / Press releases ─────────────────────────────────
  'upcoming corporate event announcement Dublin 2026 site:irishtimes.com OR site:independent.ie OR site:businesspost.ie',
  'event launch announcement Ireland 2026 press release',

  // ── Venue-led discovery ───────────────────────────────────
  'conference centre events booking Ireland 2026',
  'hotel ballroom event hire Dublin Cork 2026',
  'RDS Aviva Convention Centre event Dublin 2026',
];

// ── Platforms: event, news, corporate, venue, Ireland-specific ────────────────
const EVENT_DOMAINS = [
  // Ireland-specific event & media
  'eventbrite.ie', 'entertainment.ie', 'lovin.ie', 'visitdublin.com',
  'discoverireland.ie', 'dublintown.ie', 'goldenplec.com',
  // Major event platforms
  'eventbrite.com', 'ticketmaster.ie', 'ticketmaster.com',
  'meetup.com', 'universe.com', 'tickettailor.com',
  // Music & nightlife
  'dice.fm', 'residentadvisor.net', 'skiddle.com',
  'songkick.com', 'bandsintown.com', 'fatsoma.com',
  // B2B / corporate
  '10times.com', 'allevents.in', 'yapsody.com',
  'eventzilla.net', 'splash.com', 'conferenz.co.uk',
  // Social & community
  'lu.ma', 'humanitix.com', 'fever.com', 'goldstar.com',
  // Irish news (press releases & event announcements)
  'irishtimes.com', 'independent.ie', 'businesspost.ie',
  'irishexaminer.com', 'silicon.ie', 'thejournal.ie',
  // Corporate / chamber / startup
  'dublinbic.ie', 'ibec.ie', 'isme.ie', 'siliconrepublic.com',
];

// ── Recovery queries — broader, different angles, fallback sources ────────────
const RECOVERY_QUERIES = [
  // Open web — no domain restriction
  'upcoming events Ireland 2026 contact organiser',
  'event organiser Dublin Cork Galway email contact 2026',
  'Ireland conference gala dinner 2026 registration contact',
  'corporate event planner Dublin 2026 enquiries',
  // Venue-led — find events through venue pages
  'Dublin hotel conference booking events 2026',
  'Cork conference centre events 2026',
  'Galway event venue hire 2026',
  // Organiser-led — find agencies and repeat players
  'event management company Dublin Ireland 2026',
  'corporate events agency Ireland contact',
  'wedding event planner Dublin 2026 enquiries',
  // Broader Irish discovery
  'Ireland 2026 event gala registration',
  'Northern Ireland Belfast events 2026 contact',
  'Irish startup launch event 2026',
  'Ireland experiential activation agency 2026',
  // Social proof angles
  'event entertainment hire Ireland 2026',
  '360 photo booth event Ireland hire',
  'photo booth wedding corporate hire Dublin 2026',
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

// Classify contact quality — never discard a lead that has any event intelligence
function getContactQuality(e) {
  if (e.email || e.phone) return 'direct';
  if (e.linkedin || e.instagram || e.website) return 'social';
  if (e.organizer_name || e.company) return 'discovery';
  if (e.event_name && (e.lead_score || 0) >= 15) return 'event-only';
  return null;
}

// Keep any lead with a quality tier — even event-only leads can be researched
function hasActionableContact(lead) {
  return lead.contact_quality !== null;
}

// ── Exa: standard semantic search ────────────────────────────────────────────
async function exaSearch(query, extraDomains, exaKey, opts = {}) {
  // Event listings are published BEFORE the event — search from 90 days ago, not today
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const eighteenMonths = new Date(Date.now() + 548 * 86400000).toISOString().slice(0, 10);
  const domains = extraDomains?.length ? [...EVENT_DOMAINS, ...extraDomains] : EVENT_DOMAINS;
  const body = {
    query,
    type: 'auto',
    numResults: opts.numResults || 10,
    startPublishedDate: opts.startDate || ninetyDaysAgo,
    endPublishedDate: opts.endDate || eighteenMonths,
    contents: { highlights: true },
  };
  // Recovery mode: don't restrict to known domains — search the open web
  if (!opts.openWeb) body.includeDomains = domains;
  try {
    const res = await fetch(`${EXA_BASE}/search`, {
      method: 'POST',
      headers: { 'x-api-key': exaKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map(r => ({ url: r.url, title: r.title || '' }));
  } catch { return []; }
}

// ── Exa: findSimilar — recursive discovery from seed URLs ────────────────────
async function exaFindSimilar(url, exaKey) {
  try {
    const res = await fetch(`${EXA_BASE}/findSimilar`, {
      method: 'POST',
      headers: { 'x-api-key': exaKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, numResults: 5, includeDomains: EVENT_DOMAINS }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map(r => ({ url: r.url, title: r.title || '' }));
  } catch { return []; }
}

// ── Exa: batch fetch full page content ───────────────────────────────────────
async function exaContents(urls, exaKey) {
  if (!urls.length) return {};
  try {
    const res = await fetch(`${EXA_BASE}/contents`, {
      method: 'POST',
      headers: { 'x-api-key': exaKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: urls, text: { maxCharacters: 5000 } }),
    });
    if (!res.ok) return {};
    const data = await res.json();
    const map = {};
    for (const r of (data.results || [])) map[r.url] = r;
    return map;
  } catch { return {}; }
}

// ── Groq: full intelligence extraction + scoring ──────────────────────────────
async function extractWithGroq(text, title, url, groqKey) {
  if (!text || text.length < 80) return null;

  const prompt = `You are the Lead Scout AI for 360 Booth Ireland — a premium 360 photo booth and experiential activation company.

Analyse this event page and return ONLY valid JSON. Never invent data — use null for unknown fields.

EXTRACTION REQUIREMENTS:

EVENT fields:
- event_name: string
- date: "YYYY-MM-DD or null"
- venue: string or null
- address: string or null
- city: string or null (Dublin/Cork/Galway/Limerick/Other)
- ticket_price: string or null ("Free", "€20", "€500" etc)
- attendance_estimate: number or null
- sponsors: array of strings (brands/companies sponsoring) or []
- event_type: "corporate|brand_activation|product_launch|luxury_wedding|awards_gala|conference|trade_show|networking|christmas_party|graduation|university|festival|nightlife|sports|fundraiser|birthday|party|other"

ORGANISER fields:
- organizer_name: string or null
- company: string or null
- email: string or null
- phone: string or null
- website: string or null
- linkedin: string or null
- instagram: string or null

INTELLIGENCE fields:
- lead_score: 0–100 (use scoring guide below)
- reasoning: "one sentence explaining the score"
- likelihood_to_buy: "high|medium|low"
- estimated_budget: "€500–€2,000|€2,000–€5,000|€5,000–€15,000|€15,000+" or null
- estimated_revenue: "€500–€1,500|€1,500–€3,000|€3,000–€8,000|€8,000+" or null
- why_relevant: "one sentence on why 360 Booth Ireland should pitch this"
- confidence: "high|medium|low" (how confident are you in this extraction)

LEAD SCORING GUIDE (0–100):

Add:
+25 if corporate event / company-organised
+20 if luxury event (high-end wedding, premium gala, VIP)
+20 if brand activation or product launch
+15 if large attendance (200+ people)
+15 if premium Dublin/Cork/Galway venue
+15 if awards ceremony / conference / gala dinner
+15 if graduation ball or university event
+10 if sponsors or partners present (signals budget)
+10 if repeat/annual event
+10 if Dublin location
+10 if fundraiser gala ball
+10 if Christmas party or NYE event

Subtract:
-20 if small gathering (under 30 people)
-15 if volunteer / community / free informal event
-15 if clearly low-budget or student bake sale type

Return ONLY this JSON structure:
{
  "event_name": null,
  "date": null,
  "venue": null,
  "address": null,
  "city": null,
  "ticket_price": null,
  "attendance_estimate": null,
  "sponsors": [],
  "event_type": "other",
  "organizer_name": null,
  "company": null,
  "email": null,
  "phone": null,
  "website": null,
  "linkedin": null,
  "instagram": null,
  "lead_score": 0,
  "reasoning": "",
  "likelihood_to_buy": "low",
  "estimated_budget": null,
  "estimated_revenue": null,
  "why_relevant": "",
  "confidence": "low"
}

Page content:
${text.slice(0, 4500)}`;

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
    if (!res.ok) return null;
    const data = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    // Fallback regex extraction if AI missed them
    if (!parsed.email) parsed.email = extractEmailFallback(text);
    if (!parsed.phone) parsed.phone = extractPhoneFallback(text);
    parsed.source_url = url;
    return parsed;
  } catch {
    return {
      event_name: title || 'Unknown Event',
      date: null, venue: null, address: null, city: null,
      ticket_price: null, attendance_estimate: null, sponsors: [],
      event_type: 'other',
      organizer_name: null, company: null,
      email: extractEmailFallback(text),
      phone: extractPhoneFallback(text),
      website: null, linkedin: null, instagram: null,
      lead_score: 30, reasoning: 'Fallback extraction',
      likelihood_to_buy: 'low',
      estimated_budget: null, estimated_revenue: null,
      why_relevant: '', confidence: 'low',
      source_url: url,
    };
  }
}

function mapToLead(extracted) {
  if (!extracted) return null;
  const today = new Date().toISOString().slice(0, 10);
  const urgency = calcUrgency(extracted.date);

  // Build notes as rich intelligence summary
  const parts = [];
  if (extracted.event_name) parts.push(`Event: ${extracted.event_name}`);
  if (extracted.date) parts.push(`Date: ${extracted.date}`);
  if (urgency !== 'unknown' && urgency !== 'past') parts.push(`Urgency: ${urgency}`);
  if (extracted.venue) parts.push(`Venue: ${extracted.venue}`);
  if (extracted.city) parts.push(`City: ${extracted.city}`);
  if (extracted.attendance_estimate) parts.push(`Est. attendance: ${extracted.attendance_estimate}`);
  if (extracted.ticket_price) parts.push(`Ticket: ${extracted.ticket_price}`);
  if (extracted.sponsors?.length) parts.push(`Sponsors: ${extracted.sponsors.join(', ')}`);
  if (extracted.company) parts.push(`Company: ${extracted.company}`);
  if (extracted.website) parts.push(`Website: ${extracted.website}`);
  if (extracted.linkedin) parts.push(`LinkedIn: ${extracted.linkedin}`);
  if (extracted.instagram) parts.push(`Instagram: ${extracted.instagram}`);
  if (extracted.likelihood_to_buy) parts.push(`Likelihood: ${extracted.likelihood_to_buy}`);
  if (extracted.estimated_budget) parts.push(`Budget: ${extracted.estimated_budget}`);
  if (extracted.estimated_revenue) parts.push(`Revenue potential: ${extracted.estimated_revenue}`);
  if (extracted.why_relevant) parts.push(`Why relevant: ${extracted.why_relevant}`);
  if (extracted.reasoning) parts.push(`Score reason: ${extracted.lead_score}/100 — ${extracted.reasoning}`);
  if (extracted.source_url) parts.push(`Source: ${extracted.source_url}`);

  const cq = getContactQuality(extracted);

  return {
    id: uid(),
    name: extracted.organizer_name || extracted.company || `${extracted.event_name || 'Event'} Organiser`,
    email: extracted.email || '',
    phone: extracted.phone || '',
    source: 'Event Scrape',
    service: inferService(extracted.event_type),
    status: 'New',
    date: today,
    notes: parts.join(' | '),
    lead_score: extracted.lead_score || 0,
    likelihood_to_buy: extracted.likelihood_to_buy || 'low',
    urgency,
    estimated_revenue: extracted.estimated_revenue || null,
    contact_quality: cq,
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

  // Build query list — defaults + custom semantic expansions
  const queries = [...DEFAULT_QUERIES];
  if (customTerms.trim()) {
    const base = customTerms.trim();
    queries.push(`${base} Ireland 2026`);
    queries.push(`${base} event organiser contact Ireland`);
    queries.push(`${base} venue booking Dublin Cork Galway`);
    queries.push(`${base} event company launch Ireland`);
  }

  const seen = new Set();
  const meta = { queriesRun: 0, pagesScanned: 0, recoveryRan: false, recoveryReason: null };

  async function runQueryBatch(queryList, opts = {}) {
    const results = [];
    for (let i = 0; i < queryList.length; i += 5) {
      const batch = queryList.slice(i, i + 5);
      const batchResults = await Promise.all(
        batch.map(q => exaSearch(q, extraDomains, EXA_KEY, opts))
      );
      for (const r of batchResults) results.push(...r);
      meta.queriesRun += batch.length;
    }
    return results;
  }

  function dedup(results, cap) {
    const fresh = [];
    for (const r of results) {
      if (r.url && !seen.has(r.url)) {
        seen.add(r.url);
        fresh.push(r);
        if (fresh.length >= cap) break;
      }
    }
    return fresh;
  }

  async function extractLeads(pages) {
    const contentMap = await exaContents(pages.map(r => r.url), EXA_KEY);
    const leads = [];
    for (let i = 0; i < pages.length; i += 8) {
      const batch = pages.slice(i, i + 8);
      const extracted = await Promise.all(
        batch.map(r => {
          const c = contentMap[r.url];
          return extractWithGroq(c?.text || '', r.title || '', r.url, GROQ_KEY);
        })
      );
      for (const e of extracted) {
        const lead = mapToLead(e);
        // Keep any lead with actionable intelligence — not just email/phone
        if (lead && hasActionableContact(lead)) leads.push(lead);
      }
    }
    meta.pagesScanned += pages.length;
    return leads;
  }

  try {
    // ── PASS 1: Primary multi-platform discovery ──────────────────────────────
    const pass1Results = await runQueryBatch(queries);
    let unique = dedup(pass1Results, 50);

    // ── Recursive findSimilar on top 8 seeds ─────────────────────────────────
    if (unique.length) {
      const seedUrls = unique.slice(0, 8).map(r => r.url);
      const similarBatches = await Promise.all(seedUrls.map(url => exaFindSimilar(url, EXA_KEY)));
      const similarFlat = similarBatches.flat();
      unique = unique.concat(dedup(similarFlat, 70 - unique.length));
    }

    let leads = unique.length ? await extractLeads(unique) : [];

    // ── PASS 2: Recovery — if direct-contact leads < 5 ───────────────────────
    const directLeads = leads.filter(l => l.contact_quality === 'direct');
    if (directLeads.length < 5) {
      meta.recoveryRan = true;
      meta.recoveryReason = directLeads.length === 0
        ? 'Zero direct contacts found on primary pass — executing open-web recovery'
        : `Only ${directLeads.length} direct contact(s) found — expanding search space`;

      // Recovery A: same domains, wider date window (past 30 days → 18 months ahead)
      const wideStart = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const wideEnd = new Date(Date.now() + 545 * 86400000).toISOString().slice(0, 10);
      const recoveryA = await runQueryBatch(RECOVERY_QUERIES, { startDate: wideStart, endDate: wideEnd });
      const recoveryAPages = dedup(recoveryA, 30);

      // Recovery B: open web — no domain restriction on top recovery queries
      const openWebQueries = RECOVERY_QUERIES.slice(0, 6);
      const recoveryB = await runQueryBatch(openWebQueries, { openWeb: true, numResults: 8 });
      const recoveryBPages = dedup(recoveryB, 20);

      const recoveryPages = [...recoveryAPages, ...recoveryBPages];
      if (recoveryPages.length) {
        const recoveryLeads = await extractLeads(recoveryPages);
        // Merge — avoid duplicate names/emails already in leads
        const existingIds = new Set(leads.map(l => l.email || l.name));
        for (const l of recoveryLeads) {
          if (!existingIds.has(l.email || l.name)) {
            leads.push(l);
            existingIds.add(l.email || l.name);
          }
        }
      }
    }

    // ── Sort: urgency → score ─────────────────────────────────────────────────
    const urgencyRank = { urgent: 0, high: 1, pipeline: 2, 'long-term': 3, unknown: 4, past: 5 };
    leads.sort((a, b) => {
      const uDiff = (urgencyRank[a.urgency] ?? 4) - (urgencyRank[b.urgency] ?? 4);
      return uDiff !== 0 ? uDiff : (b.lead_score || 0) - (a.lead_score || 0);
    });

    return res.status(200).json({
      leads,
      count: leads.length,
      directCount: leads.filter(l => l.contact_quality === 'direct').length,
      socialCount: leads.filter(l => l.contact_quality === 'social').length,
      discoveryCount: leads.filter(l => l.contact_quality === 'discovery').length,
      scannedAt: new Date().toISOString(),
      ...meta,
    });

  } catch (err) {
    console.error('[scan-leads]', err);
    return res.status(500).json({ error: err.message || 'Scan failed' });
  }
};
