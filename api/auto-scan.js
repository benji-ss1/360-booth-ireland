// 360 Booth Ireland — Scheduled Event Scanner
// Called daily by Vercel Cron (see vercel.json).
// Checks the scan_config table → runs scan if scheduled → writes to event_leads.

const SUPABASE_URL = 'https://kcjmmiifemdarknrvpas.supabase.co';
const EXA_BASE    = 'https://api.exa.ai';
const GROQ_BASE   = 'https://api.groq.com/openai/v1/chat/completions';
const TWILIO_BASE = 'https://api.twilio.com/2010-04-01';

const DEFAULT_QUERIES = [
  // Corporate & Awards
  'corporate awards ceremony gala dinner Ireland 2026',
  'company end of year party Dublin Cork Galway 2026',
  'corporate awards night black tie Ireland 2026',
  'business awards gala ceremony Dublin 2026',
  // Conferences & Summits
  'tech conference summit Dublin Ireland 2026 evening reception',
  'industry conference gala dinner Ireland 2026',
  'professional association annual dinner awards Ireland 2026',
  'business summit conference networking Dublin 2026',
  // Weddings
  'wedding reception venue hire Dublin Cork Galway 2026',
  'luxury wedding reception Ireland 2026',
  'wedding entertainment hire Ireland 2026',
  // Product Launches & Brand Events
  'product launch event party Dublin Ireland 2026',
  'brand activation launch party Ireland 2026',
  'company milestone anniversary celebration Ireland 2026',
  // Charity & Galas
  'charity gala ball fundraiser dinner Ireland 2026',
  'black tie charity ball auction dinner Ireland 2026',
  // Sports & Social Clubs
  'golf club annual dinner dance awards Ireland 2026',
  'sports club gala dinner awards night Ireland 2026',
  // Venue & Hospitality
  'hotel ballroom gala event hire Dublin Cork 2026',
  'premium event venue hire celebration Ireland 2026',
];

const EVENT_DOMAINS = [
  'eventbrite.ie', 'eventbrite.com', 'ticketmaster.ie',
  'meetup.com', 'lovin.ie', 'entertainment.ie',
  'irishvenues.com', 'weddingsonline.ie', 'confex.com',
];

// ── Supabase REST helpers ──────────────────────────────────────────────────
async function supabaseGet(path, serviceKey) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) return null;
  return res.json();
}

async function supabasePost(table, body, serviceKey) {
  return fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  });
}

async function supabasePatch(table, match, body, serviceKey) {
  const params = Object.entries(match).map(([k, v]) => `${k}=eq.${v}`).join('&');
  return fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    method: 'PATCH',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  });
}

async function supabaseUpsert(table, body, serviceKey) {
  return fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(body),
  });
}

// ── Scan helpers (shared with scan-leads.js) ───────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function inferService(t) {
  t = (t || '').toLowerCase();
  if (t === 'wedding' || t === 'birthday' || t === 'party') return 'Selfie Mirror';
  return '360 Booth';
}

function emailFallback(text) {
  const m = (text || '').match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0] : null;
}

function phoneFallback(text) {
  const m = (text || '').match(/(\+353|0)[\s\-]?\d[\s\-]?\d{3}[\s\-]?\d{4}/);
  return m ? m[0].replace(/[\s\-]/g, '') : null;
}

async function exaSearch(query, exaKey) {
  const today = new Date().toISOString().slice(0, 10);
  const nextYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  try {
    const res = await fetch(`${EXA_BASE}/search`, {
      method: 'POST',
      headers: { 'x-api-key': exaKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query, type: 'auto', numResults: 8,
        startPublishedDate: today, endPublishedDate: nextYear,
        includeDomains: EVENT_DOMAINS, contents: { highlights: true },
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map(r => ({ url: r.url, title: r.title }));
  } catch { return []; }
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
  } catch { return {}; }
}

async function extractWithGroq(text, title, url, groqKey) {
  if (!text || text.length < 100) return null;
  try {
    const res = await fetch(GROQ_BASE, {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: `Extract event organiser contacts as JSON: {"organizer_name":null,"email":null,"phone":null,"event_name":"","event_date":null,"venue":null,"event_type":"wedding|corporate|birthday|party|fundraiser|conference|other"}\nContent: ${text.slice(0, 3000)}` }],
        temperature: 0.1, max_tokens: 250,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const p = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    if (!p.email) p.email = emailFallback(text);
    if (!p.phone) p.phone = phoneFallback(text);
    p.source_url = url;
    return p;
  } catch {
    return { organizer_name: null, email: emailFallback(text), phone: phoneFallback(text), event_name: title, event_date: null, venue: null, event_type: 'other', source_url: url };
  }
}

function mapToLead(e, scanRunId) {
  if (!e) return null;
  const today = new Date().toISOString().slice(0, 10);
  const parts = [];
  if (e.event_name) parts.push(`Event: ${e.event_name}`);
  if (e.event_date) parts.push(`Date: ${e.event_date}`);
  if (e.venue) parts.push(`Venue: ${e.venue}`);
  if (e.source_url) parts.push(`Source: ${e.source_url}`);
  return {
    id: uid(),
    name: e.organizer_name || `${e.event_name || 'Event'} Organiser`,
    email: e.email || '',
    phone: e.phone || '',
    source: 'Event Scrape',
    service: inferService(e.event_type),
    status: 'New',
    date: today,
    notes: parts.join(' | '),
    imported: false,
    scan_run_id: scanRunId,
    scan_run_at: new Date().toISOString(),
  };
}

// ── WhatsApp alert after scan ─────────────────────────────────────────────
async function sendWhatsAppAlert(leads, sid, token, from, to) {
  if (!sid || !token || !from || !to || !leads.length) return;
  try {
    const withContact = leads.filter(l => l.email || l.phone).slice(0, 3);
    const lines = [
      '*Jarvis Auto-Scan — 360 Booth Ireland*',
      '',
      `${leads.length} new lead${leads.length !== 1 ? 's' : ''} found and saved to your database.`,
    ];
    if (withContact.length) {
      lines.push('', 'Top contacts found:');
      withContact.forEach((l, i) => {
        lines.push(`${i + 1}. ${l.name || 'Event Lead'}`);
        if (l.email) lines.push(`   ${l.email}`);
        if (l.phone) lines.push(`   ${l.phone}`);
      });
    }
    lines.push('', 'Open your dashboard to review and score them.');
    const body = lines.join('\n').slice(0, 1600);
    const url = `${TWILIO_BASE}/Accounts/${sid}/Messages.json`;
    const params = new URLSearchParams({ To: to, From: from, Body: body });
    const credentials = Buffer.from(`${sid}:${token}`).toString('base64');
    await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
  } catch (err) {
    console.warn('[auto-scan] WhatsApp alert failed (non-fatal):', err.message);
  }
}

// ── Next run date calculator ───────────────────────────────────────────────
function calcNextRun(scheduleType, fromDate = new Date()) {
  const d = new Date(fromDate);
  switch (scheduleType) {
    case 'weekly':    d.setDate(d.getDate() + 7); break;
    case 'monthly':   d.setMonth(d.getMonth() + 1); break;
    case 'biannual':  d.setMonth(d.getMonth() + 6); break;
    default: return null;
  }
  return d.toISOString();
}

// ── Main handler ──────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: Vercel sends CRON_SECRET in Authorization header for cron jobs.
  // Also allow manual POST from dashboard with dashboard_trigger flag.
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || '';
  const isDashboardTrigger = req.body?.dashboard_trigger === true;
  const isCronCall = cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!isCronCall && !isDashboardTrigger) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const EXA_KEY = process.env.EXA_API_KEY;
  const GROQ_KEY = process.env.GROQ_API_KEY;

  if (!SERVICE_KEY || !EXA_KEY || !GROQ_KEY) {
    return res.status(500).json({ error: 'Missing required environment variables' });
  }

  // Read schedule config from Supabase — create a default row if it doesn't exist yet
  let configs = await supabaseGet('scan_config?id=eq.main&select=*', SERVICE_KEY);
  if (!configs || !configs.length) {
    // Bootstrap the row so future cron calls and the settings page both have something to work with
    await supabaseUpsert('scan_config', {
      id: 'main',
      is_active: true,
      schedule_type: 'weekly',
      next_run_at: null,
      last_run_at: null,
      custom_terms: '',
    }, SERVICE_KEY);
    configs = await supabaseGet('scan_config?id=eq.main&select=*', SERVICE_KEY);
  }
  const config = configs?.[0];

  // If cron call: check if scan is actually due
  if (isCronCall && !isDashboardTrigger) {
    if (!config || !config.is_active) {
      return res.status(200).json({ message: 'Scanner not active — skipped' });
    }
    // If next_run_at is set, check if we've passed it; if not set, always run
    if (config.next_run_at) {
      const nextRun = new Date(config.next_run_at);
      const now = new Date();
      if (nextRun > now) {
        return res.status(200).json({ message: `Next scan scheduled for ${nextRun.toISOString()} — skipped today` });
      }
    }
  }

  // Build queries from config
  const queries = [...DEFAULT_QUERIES];
  const customTerms = config?.custom_terms || '';
  if (customTerms) {
    customTerms.split(',').map(t => t.trim()).filter(Boolean).forEach(term => {
      queries.push(`${term} events Ireland`);
    });
  }

  try {
    const scanRunId = uid();

    // Run searches
    const allResults = [];
    for (const q of queries) {
      allResults.push(...(await exaSearch(q, EXA_KEY)));
    }

    // Deduplicate + cap
    const seen = new Set();
    const unique = allResults.filter(r => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    }).slice(0, 30);

    const contentMap = await exaContents(unique.map(r => r.url), EXA_KEY);

    // Extract leads
    const leads = [];
    for (let i = 0; i < unique.length; i += 5) {
      const batch = unique.slice(i, i + 5);
      const extracted = await Promise.all(
        batch.map(r => extractWithGroq(contentMap[r.url]?.text || '', r.title, r.url, GROQ_KEY))
      );
      for (const e of extracted) {
        const lead = mapToLead(e, scanRunId);
        if (lead && (lead.email || lead.phone)) leads.push(lead);
      }
    }

    // Write to Supabase event_leads table + send WhatsApp alert
    if (leads.length) {
      await supabasePost('event_leads', leads, SERVICE_KEY);
      sendWhatsAppAlert(
        leads,
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN,
        process.env.TWILIO_WHATSAPP_FROM,
        process.env.TWILIO_WHATSAPP_TO
      ); // non-blocking
    }

    // Update scan_config: last_run_at + next_run_at
    const now = new Date().toISOString();
    const nextRun = calcNextRun(config?.schedule_type, new Date());
    await supabasePatch('scan_config', { id: 'main' }, {
      last_run_at: now,
      next_run_at: nextRun || config?.next_run_at,
    }, SERVICE_KEY);

    return res.status(200).json({
      success: true,
      leadsFound: leads.length,
      scanRunId,
      scannedAt: now,
      nextRun,
    });
  } catch (err) {
    console.error('[auto-scan]', err);
    return res.status(500).json({ error: err.message });
  }
};
