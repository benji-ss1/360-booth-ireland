// 360 Booth Ireland — Lead Scout Intelligence Engine v3
// Fixed: exaContents batched (was silently dropping all 70 URLs), queries parallelised,
// Groq fully parallel, recovery window corrected, highlights used as content fallback.

const EXA_BASE = 'https://api.exa.ai';
const GROQ_BASE = 'https://api.groq.com/openai/v1/chat/completions';

const DEFAULT_QUERIES = [
  'Dublin corporate events 2026',
  'Dublin business networking events 2026',
  'Dublin conferences summit 2026',
  'Dublin company launches events 2026',
  'Dublin startup ecosystem events 2026',
  'Dublin award ceremonies gala 2026',
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
  'brand activation event Dublin Ireland 2026',
  'influencer event brand launch Dublin 2026',
  'experiential marketing activation Ireland 2026',
  'product launch party event Dublin Cork 2026',
  'hospitality launch reception Ireland 2026',
  'luxury wedding reception venue hire Ireland 2026',
  'Dublin luxury weddings 2026',
  'bridal expo wedding fair Ireland 2026',
  'wedding venue event Dublin Galway Cork 2026',
  'charity gala ball fundraiser dinner Ireland 2026',
  'fundraising gala auction dinner Dublin 2026',
  'black tie charity ball Ireland 2026',
  'Dublin university events 2026',
  'university college graduation ball Ireland 2026',
  'student union event college party Ireland 2026',
  'UCD Trinity DCU graduation event 2026',
  'sports awards banquet dinner Ireland 2026',
  'golf classic corporate dinner Ireland 2026',
  'festival outdoor event summer Ireland 2026',
  'nightclub event party Dublin Cork 2026',
  'music live concert venue Ireland 2026',
  'Cork corporate events conferences 2026',
  'Galway business events networking 2026',
  'Limerick corporate events 2026',
  'events Galway Limerick Waterford 2026',
  'events Cork Kerry Kilkenny Wexford 2026',
  'hospitality venue hotel event Cork Galway 2026',
  'conference centre events booking Ireland 2026',
  'hotel ballroom event hire Dublin Cork 2026',
  'RDS Aviva Convention Centre event Dublin 2026',
  'event management company Dublin Ireland 2026',
  'corporate events agency Ireland contact',
  'Ireland event announcement 2026 press release',
];

const EVENT_DOMAINS = [
  'eventbrite.ie', 'entertainment.ie', 'lovin.ie', 'visitdublin.com',
  'discoverireland.ie', 'dublintown.ie', 'goldenplec.com',
  'eventbrite.com', 'ticketmaster.ie', 'ticketmaster.com',
  'meetup.com', 'universe.com', 'tickettailor.com',
  'dice.fm', 'residentadvisor.net', 'skiddle.com',
  'songkick.com', 'bandsintown.com', 'fatsoma.com',
  '10times.com', 'allevents.in', 'yapsody.com',
  'eventzilla.net', 'splash.com', 'conferenz.co.uk',
  'lu.ma', 'humanitix.com', 'fever.com', 'goldstar.com',
  'irishtimes.com', 'independent.ie', 'businesspost.ie',
  'irishexaminer.com', 'silicon.ie', 'thejournal.ie',
  'dublinbic.ie', 'ibec.ie', 'isme.ie', 'siliconrepublic.com',
];

const RECOVERY_QUERIES = [
  'upcoming events Ireland 2026 contact organiser',
  'event organiser Dublin Cork Galway email contact 2026',
  'Ireland conference gala dinner 2026 registration contact',
  'corporate event planner Dublin 2026 enquiries',
  'Dublin hotel conference booking events 2026',
  'Cork conference centre events 2026',
  'Galway event venue hire 2026',
  'event management company Dublin Ireland 2026',
  'corporate events agency Ireland contact',
  'wedding event planner Dublin 2026 enquiries',
  'Ireland 2026 event gala registration',
  'Irish startup launch event 2026',
  'Ireland experiential activation agency 2026',
  'event entertainment hire Ireland 2026',
  'photo booth wedding corporate hire Dublin 2026',
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
  if (e.linkedin || e.instagram || e.website) return 'social';
  if (e.organizer_name || e.company) return 'discovery';
  if (e.event_name) return 'event-only'; // no score threshold — any named event is worth keeping
  return null;
}

// ── Exa: search — returns url, title, AND highlights for fallback content ─────
async function exaSearch(query, exaKey, opts = {}) {
  // Search from 6 months ago so existing listings are included, not just today's
  const sixMonthsAgo = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
  const eighteenMonths = new Date(Date.now() + 548 * 86400000).toISOString().slice(0, 10);
  const body = {
    query,
    type: 'auto',
    numResults: opts.numResults || 10,
    startPublishedDate: opts.startDate || sixMonthsAgo,
    endPublishedDate: opts.endDate || eighteenMonths,
    contents: { highlights: { numSentences: 5, highlightsPerUrl: 3 } },
  };
  if (!opts.openWeb) body.includeDomains = EVENT_DOMAINS;
  try {
    const res = await fetch(`${EXA_BASE}/search`, {
      method: 'POST',
      headers: { 'x-api-key': exaKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error('[exa-search] HTTP', res.status, query.slice(0, 60));
      return [];
    }
    const data = await res.json();
    return (data.results || []).map(r => ({
      url: r.url,
      title: r.title || '',
      // Carry highlights forward — used as content fallback if /contents fails
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
      body: JSON.stringify({ url, numResults: 5, includeDomains: EVENT_DOMAINS }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map(r => ({ url: r.url, title: r.title || '', highlights: '' }));
  } catch (err) {
    console.error('[exa-similar] error:', err.message);
    return [];
  }
}

// ── Exa: fetch full content — BATCHED in groups of 10 to prevent silent failure
async function exaContentsBatch(urls, exaKey) {
  if (!urls.length) return {};
  // Split into chunks of 10 and run in parallel — a single large batch silently fails
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

// ── Groq: extract + score ─────────────────────────────────────────────────────
async function extractWithGroq(text, title, url, groqKey) {
  // Fallback to title if content is short — still worth attempting extraction
  const content = (text && text.length >= 30) ? text : `Event title: ${title}\nURL: ${url}`;
  if (!content || content.length < 10) return null;

  const prompt = `You are the Lead Scout AI for 360 Booth Ireland — a premium 360 photo booth and experiential activation company.

Analyse this event page and return ONLY valid JSON. If data is missing use null. Do NOT invent data.

Return this exact JSON structure:
{
  "event_name": null,
  "date": null,
  "venue": null,
  "city": null,
  "ticket_price": null,
  "attendance_estimate": null,
  "sponsors": [],
  "event_type": "corporate|brand_activation|product_launch|luxury_wedding|awards_gala|conference|trade_show|networking|christmas_party|graduation|university|festival|nightlife|sports|fundraiser|birthday|party|other",
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

LEAD SCORING (0–100):
+25 corporate/company event
+20 luxury/high-end/VIP event
+20 brand activation or product launch
+15 large attendance (200+)
+15 premium Dublin/Cork/Galway venue
+15 awards/conference/gala dinner
+15 graduation ball/university event
+10 sponsors present (signals budget)
+10 Dublin location
+10 Christmas/NYE party
-20 small gathering under 30 people
-15 free volunteer/community meetup
-15 low-budget event

likelihood_to_buy: "high" if score≥60, "medium" if 30–59, "low" below 30
estimated_budget: "€500–€2,000" / "€2,000–€5,000" / "€5,000–€15,000" / "€15,000+"
estimated_revenue: "€500–€1,500" / "€1,500–€3,000" / "€3,000–€8,000" / "€8,000+"

Page content:
${content.slice(0, 3800)}`;

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
    if (!parsed.email) parsed.email = extractEmailFallback(content);
    if (!parsed.phone) parsed.phone = extractPhoneFallback(content);
    parsed.source_url = url;
    return parsed;
  } catch (err) {
    console.error('[groq] error:', err.message, url.slice(0, 60));
    return {
      event_name: title || null,
      date: null, venue: null, city: null, ticket_price: null,
      attendance_estimate: null, sponsors: [], event_type: 'other',
      organizer_name: null, company: null,
      email: extractEmailFallback(content),
      phone: extractPhoneFallback(content),
      website: null, linkedin: null, instagram: null,
      lead_score: 25, reasoning: 'Fallback — Groq parse error',
      likelihood_to_buy: 'low', estimated_budget: null, estimated_revenue: null,
      why_relevant: '', confidence: 'low', source_url: url,
    };
  }
}

function mapToLead(extracted) {
  if (!extracted) return null;
  const cq = getContactQuality(extracted);
  if (!cq) return null; // no event name at all — not usable

  const urgency = calcUrgency(extracted.date);
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
  if (extracted.reasoning) parts.push(`Score: ${extracted.lead_score}/100 — ${extracted.reasoning}`);
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
    likelihood_to_buy: extracted.likelihood_to_buy || 'low',
    urgency,
    estimated_revenue: extracted.estimated_revenue || null,
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
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!EXA_KEY || !GROQ_KEY) {
    return res.status(500).json({ error: 'EXA_API_KEY and GROQ_API_KEY must be set in Vercel environment variables.' });
  }

  const body = req.body || {};
  const customTerms = (body.customTerms || '').trim();
  const queries = [...DEFAULT_QUERIES];
  if (customTerms) {
    queries.push(`${customTerms} Ireland 2026`);
    queries.push(`${customTerms} event organiser contact Ireland`);
    queries.push(`${customTerms} venue booking Dublin Cork Galway`);
    queries.push(`${customTerms} event company launch Ireland`);
  }

  const seen = new Set();
  const meta = { queriesRun: 0, pagesScanned: 0, recoveryRan: false, recoveryReason: null };

  // Deduplicate by URL using the shared seen set
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

  // Run all queries in parallel — not sequentially in batches
  async function runAllQueries(queryList, opts = {}) {
    meta.queriesRun += queryList.length;
    const all = await Promise.all(queryList.map(q => exaSearch(q, EXA_KEY, opts)));
    return all.flat();
  }

  // Extract leads from a page list — all Groq calls run fully in parallel
  async function extractLeads(pages) {
    if (!pages.length) return [];
    // Fetch full page content in batched parallel chunks of 10
    const contentMap = await exaContentsBatch(pages.map(p => p.url), EXA_KEY);
    meta.pagesScanned += pages.length;

    // For each page: use full content if available, fall back to search highlights
    const extracted = await Promise.all(pages.map(p => {
      const fullText = contentMap[p.url] || '';
      const text = fullText.length >= 30 ? fullText : p.highlights || '';
      return extractWithGroq(text, p.title, p.url, GROQ_KEY);
    }));

    return extracted.map(mapToLead).filter(Boolean);
  }

  try {
    // PASS 1: Fire all queries in parallel
    const pass1Results = await runAllQueries(queries);
    let unique = dedup(pass1Results, 50);

    // Recursive discovery from top 8 seeds — parallel
    if (unique.length) {
      const seeds = unique.slice(0, 8).map(p => p.url);
      const similar = (await Promise.all(seeds.map(url => exaFindSimilar(url, EXA_KEY)))).flat();
      unique = unique.concat(dedup(similar, 70 - unique.length));
    }

    let leads = await extractLeads(unique);

    // PASS 2: Recovery if direct contacts still thin
    const directCount = leads.filter(l => l.contact_quality === 'direct').length;
    if (directCount < 5) {
      meta.recoveryRan = true;
      meta.recoveryReason = directCount === 0
        ? 'Zero direct contacts — running open-web recovery'
        : `Only ${directCount} direct contact(s) — expanding`;

      // Recovery A: wider date window (2 years ago → 2 years ahead, no domain restriction)
      const recovA = await runAllQueries(RECOVERY_QUERIES, { openWeb: true, numResults: 12 });
      const recovAPages = dedup(recovA, 30);

      // Recovery B: domain-restricted but very wide date window
      const wideStart = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
      const wideEnd = new Date(Date.now() + 730 * 86400000).toISOString().slice(0, 10);
      const recovB = await runAllQueries(RECOVERY_QUERIES.slice(0, 8), { startDate: wideStart, endDate: wideEnd });
      const recovBPages = dedup(recovB, 20);

      const recovPages = [...recovAPages, ...recovBPages];
      if (recovPages.length) {
        const recovLeads = await extractLeads(recovPages);
        // Dedup by source_url (consistent with how seen Set works)
        const existingUrls = new Set(leads.map(l => l.source_url).filter(Boolean));
        for (const l of recovLeads) {
          if (!existingUrls.has(l.source_url)) {
            leads.push(l);
            existingUrls.add(l.source_url);
          }
        }
      }
    }

    // Sort: urgency first, then score
    const urgencyRank = { urgent: 0, high: 1, pipeline: 2, 'long-term': 3, unknown: 4, past: 5 };
    leads.sort((a, b) => {
      const uDiff = (urgencyRank[a.urgency] ?? 4) - (urgencyRank[b.urgency] ?? 4);
      return uDiff !== 0 ? uDiff : (b.lead_score || 0) - (a.lead_score || 0);
    });

    console.log(`[scan-leads] done: ${leads.length} leads, ${meta.pagesScanned} pages, ${meta.queriesRun} queries, recovery=${meta.recoveryRan}`);

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
