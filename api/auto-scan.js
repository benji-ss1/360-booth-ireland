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
  // Look back 6 months — event pages are published well before the event date
  const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  try {
    const res = await fetch(`${EXA_BASE}/search`, {
      method: 'POST',
      headers: { 'x-api-key': exaKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query, type: 'auto', numResults: 10,
        startPublishedDate: sixMonthsAgo,
        contents: { highlights: true },
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

function computeLeadScore(e) {
  let score = 30;
  if (e.email && e.phone) score += 35;
  else if (e.email) score += 25;
  else if (e.phone) score += 15;
  const type = (e.event_type || '').toLowerCase();
  if (['corporate', 'conference', 'fundraiser', 'gala', 'awards'].some(t => type.includes(t))) score += 30;
  else if (type === 'wedding') score += 25;
  else if (['birthday', 'party', 'other'].some(t => type.includes(t))) score += 15;
  if (e.venue) score += 8;
  if (e.event_date) score += 7;
  return Math.min(score, 100);
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
    lead_score: computeLeadScore(e),
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

// ── Email report after auto-scan ──────────────────────────────────────────
const RESEND_BASE  = 'https://api.resend.com/emails';
// onboarding@resend.dev (sandbox) only delivers to the Resend account owner.
// Send only to that address until a custom domain is verified on Resend.
const TO_ADDRESSES = ['benj.sanusi@gmail.com'];
const FROM_ADDRESS = 'Jarvis 360 Booth <onboarding@resend.dev>';

async function sendEmailReport(leads, hotLeads, warnLeads, scanRunId, scannedAt, resendKey) {
  const scoreColour = s => s >= 80 ? '#FF4465' : s >= 55 ? '#F0A500' : '#00D4FF';
  const card = l => `
    <div style="background:#0C1520;border:1px solid rgba(0,212,255,${l.lead_score>=80?'.3':'.07'});border-radius:10px;padding:16px 18px;margin-bottom:12px;">
      <div style="font-size:13px;font-weight:700;color:#D6EDFF;margin-bottom:6px;">${l.name||l.notes?.split(' | ')[0]||'Event Lead'}</div>
      ${l.email?`<div style="font-size:12px;color:#7EB8D8;">✉ ${l.email}</div>`:''}
      ${l.phone?`<div style="font-size:12px;color:#7EB8D8;">📞 ${l.phone}</div>`:''}
      ${l.notes?`<div style="font-size:11px;color:#2E4A62;margin-top:6px;">${l.notes.slice(0,120)}</div>`:''}
      <div style="font-size:20px;font-weight:800;color:${scoreColour(l.lead_score||0)};margin-top:8px;font-family:monospace;">${l.lead_score||0}<span style="font-size:11px;color:#2E4A62;font-weight:400;">/100</span></div>
    </div>`;

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:24px 16px;background:#060A0E;font-family:'Inter',-apple-system,sans-serif;max-width:600px;margin:0 auto;">
    <div style="text-align:center;margin-bottom:24px;">
      <div style="font-size:20px;font-weight:800;color:#00D4FF;letter-spacing:1px;">JARVIS AUTO-SCAN REPORT</div>
      <div style="font-size:12px;color:#7EB8D8;margin-top:4px;">360 Booth Ireland · ${new Date(scannedAt).toLocaleString('en-IE',{timeZone:'Europe/Dublin',weekday:'long',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})} Dublin</div>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;">
      <div style="flex:1;min-width:100px;background:#0C1520;border:1px solid rgba(255,68,101,.2);border-radius:8px;padding:12px;text-align:center;">
        <div style="font-size:24px;font-weight:800;color:#FF4465;font-family:monospace;">${hotLeads.length}</div>
        <div style="font-size:10px;color:#7EB8D8;letter-spacing:.8px;">HOT LEADS</div>
      </div>
      <div style="flex:1;min-width:100px;background:#0C1520;border:1px solid rgba(240,165,0,.2);border-radius:8px;padding:12px;text-align:center;">
        <div style="font-size:24px;font-weight:800;color:#F0A500;font-family:monospace;">${warnLeads.length}</div>
        <div style="font-size:10px;color:#7EB8D8;letter-spacing:.8px;">WARM LEADS</div>
      </div>
      <div style="flex:1;min-width:100px;background:#0C1520;border:1px solid rgba(0,212,255,.15);border-radius:8px;padding:12px;text-align:center;">
        <div style="font-size:24px;font-weight:800;color:#00D4FF;font-family:monospace;">${leads.length}</div>
        <div style="font-size:10px;color:#7EB8D8;letter-spacing:.8px;">TOTAL FOUND</div>
      </div>
    </div>
    ${hotLeads.length ? `<div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#FF4465;text-transform:uppercase;margin-bottom:10px;">🔴 Hot Leads — Contact First</div>${hotLeads.slice(0,5).map(card).join('')}` : ''}
    ${warnLeads.length ? `<div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#F0A500;text-transform:uppercase;margin-bottom:10px;margin-top:16px;">🟡 Warm Leads</div>${warnLeads.slice(0,4).map(card).join('')}` : ''}
    ${leads.length === 0 ? '<div style="text-align:center;padding:32px;color:#2E4A62;font-size:14px;">No leads with contact info found this run.</div>' : ''}
    <div style="margin-top:24px;padding-top:14px;border-top:1px solid rgba(0,212,255,.07);text-align:center;font-size:11px;color:#2E4A62;">
      Powered by Jarvis × 360 Booth Intelligence · Exa · Groq LLaMA 3.3 70B<br>Open <a href="https://360-booth-ireland.vercel.app" style="color:#00D4FF;">your dashboard</a> to review all leads.
    </div>
  </body></html>`;

  const subject = hotLeads.length > 0
    ? `🔴 ${hotLeads.length} hot lead${hotLeads.length > 1 ? 's' : ''} — Jarvis Auto-Scan ${new Date().toLocaleDateString('en-IE',{timeZone:'Europe/Dublin'})}`
    : `📊 Jarvis Auto-Scan — ${leads.length} leads found`;

  for (const to of TO_ADDRESSES) {
    await fetch(RESEND_BASE, {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_ADDRESS, to, subject, html }),
    });
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

  // Auth: three valid callers —
  //  1. Vercel cron  → sends X-Vercel-Cron:1 header (always present for cron invocations)
  //  2. CRON_SECRET  → Authorization: Bearer <secret> (optional extra guard)
  //  3. Dashboard    → POST body contains { dashboard_trigger: true }
  const cronSecret       = process.env.CRON_SECRET;
  const authHeader       = req.headers.authorization || '';
  const isVercelCron     = req.headers['x-vercel-cron'] === '1';
  const isDashboardTrigger = req.body?.dashboard_trigger === true;
  const isCronCall       = isVercelCron || (cronSecret && authHeader === `Bearer ${cronSecret}`);

  if (!isCronCall && !isDashboardTrigger) {
    return res.status(401).json({ error: 'Unauthorised — send X-Vercel-Cron:1 or dashboard_trigger:true' });
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

    // Write to Supabase event_leads table
    if (leads.length) {
      await supabasePost('event_leads', leads, SERVICE_KEY);
    }

    const hotLeads  = leads.filter(l => (l.lead_score || 0) >= 80);
    const warnLeads = leads.filter(l => (l.lead_score || 0) >= 55 && (l.lead_score || 0) < 80);
    const scannedAt = new Date().toISOString();

    // Send WhatsApp alert (non-blocking — non-fatal)
    sendWhatsAppAlert(
      leads,
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN,
      process.env.TWILIO_WHATSAPP_FROM,
      process.env.TWILIO_WHATSAPP_TO
    );

    // Send email report via Resend (always — so you know the cron actually ran)
    const RESEND_KEY = process.env.RESEND_API_KEY;
    if (RESEND_KEY) {
      sendEmailReport(leads, hotLeads, warnLeads, scanRunId, scannedAt, RESEND_KEY).catch(e =>
        console.warn('[auto-scan] Email report failed (non-fatal):', e.message)
      );
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
