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
    event_name: e.event_name || '',
    event_date: e.event_date || '',
    venue: e.venue || '',
    event_type: e.event_type || '',
    imported: false,
    scan_run_id: scanRunId,
    scan_run_at: new Date().toISOString(),
  };
}

// ── WhatsApp alert after scan ─────────────────────────────────────────────
async function sendWhatsAppAlert(leads, hotLeads, warnLeads, sid, token, from, to, scannedAt) {
  if (!sid || !token || !from || !to) return;
  try {
    const dublinTime = new Date(scannedAt).toLocaleString('en-IE', {
      timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit',
    });
    const lines = [
      '*⚡ Jarvis Auto-Scan — 360 Booth Ireland*',
      dublinTime + ' Dublin',
      '',
      `🔴 ${hotLeads.length} hot  🟡 ${warnLeads.length} warm  📊 ${leads.length} total found`,
    ];

    if (hotLeads.length) {
      lines.push('', '━━━━━━━━━━━━━━━━━━━━', '🔥 *HOT LEADS — Contact Now*');
      hotLeads.slice(0, 3).forEach((l, i) => {
        lines.push('');
        lines.push(`${i + 1}. *${l.event_name || l.name}*`);
        lines.push(`   Score: ${l.lead_score}/100`);
        if (l.event_date) lines.push(`   📅 ${l.event_date}`);
        if (l.venue) lines.push(`   📍 ${l.venue}`);
        if (l.name && l.event_name) lines.push(`   Organiser: ${l.name}`);
        if (l.email) lines.push(`   ✉ ${l.email}`);
        if (l.phone) lines.push(`   📞 ${l.phone}`);
      });
    } else if (warnLeads.length) {
      lines.push('', '━━━━━━━━━━━━━━━━━━━━', '🟡 *Warm Leads*');
      warnLeads.slice(0, 2).forEach((l, i) => {
        lines.push('');
        lines.push(`${i + 1}. *${l.event_name || l.name}* — ${l.lead_score}/100`);
        if (l.email) lines.push(`   ✉ ${l.email}`);
        if (l.phone) lines.push(`   📞 ${l.phone}`);
      });
    } else if (!leads.length) {
      lines.push('', 'No leads with contact info found this run.');
    }

    lines.push('', '━━━━━━━━━━━━━━━━━━━━');
    lines.push('🔗 https://360-booth-ireland.vercel.app');

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
  const dublinDate = new Date(scannedAt).toLocaleString('en-IE', {
    timeZone: 'Europe/Dublin', weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit',
  });

  const scoreColor = s => s >= 80 ? '#FF4465' : s >= 55 ? '#D29922' : '#58A6FF';
  const scoreBg    = s => s >= 80 ? 'rgba(255,68,101,.08)' : s >= 55 ? 'rgba(210,153,34,.08)' : 'rgba(88,166,255,.08)';
  const scoreBdr   = s => s >= 80 ? 'rgba(255,68,101,.3)' : s >= 55 ? 'rgba(210,153,34,.3)' : 'rgba(88,166,255,.15)';
  const urgency    = s => s >= 80 ? '🔴 HOT' : s >= 55 ? '🟡 WARM' : '🔵 COOL';

  const leadCard = l => {
    const sc = l.lead_score || 0;
    return `
<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;border-radius:10px;border:1px solid ${scoreBdr(sc)};background:${scoreBg(sc)}">
<tr><td style="padding:16px 18px">
  <table width="100%" cellpadding="0" cellspacing="0">
  <tr>
    <td style="font-size:13px;font-weight:700;color:#E8F0FC;padding-bottom:6px">${l.event_name || l.name || 'Event Lead'}</td>
    <td align="right" style="vertical-align:top">
      <span style="background:${scoreBg(sc)};border:1px solid ${scoreBdr(sc)};border-radius:20px;padding:3px 10px;font-size:11px;font-weight:700;color:${scoreColor(sc)};font-family:monospace;white-space:nowrap">${urgency(sc)} · ${sc}/100</span>
    </td>
  </tr>
  </table>
  ${l.name && l.event_name ? `<div style="font-size:12px;color:#8B949E;margin-bottom:6px">Organiser: ${l.name}</div>` : ''}
  ${l.event_date ? `<div style="font-size:12px;color:#8B949E;margin-bottom:3px">📅 ${l.event_date}</div>` : ''}
  ${l.venue ? `<div style="font-size:12px;color:#8B949E;margin-bottom:3px">📍 ${l.venue}</div>` : ''}
  ${l.email ? `<div style="margin-top:8px"><a href="mailto:${l.email}" style="font-size:12px;color:#C9A84C;text-decoration:none;font-weight:600">✉ ${l.email}</a></div>` : ''}
  ${l.phone ? `<div style="margin-top:4px"><a href="tel:${l.phone}" style="font-size:12px;color:#C9A84C;text-decoration:none;font-weight:600">📞 ${l.phone}</a></div>` : ''}
</td></tr>
</table>`;
  };

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Jarvis Auto-Scan Report</title>
</head>
<body style="margin:0;padding:0;background-color:#07090E;font-family:-apple-system,'Helvetica Neue',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#07090E" style="background-color:#07090E">
<tr><td align="center" style="padding:32px 16px">

<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

  <!-- Header bar -->
  <tr><td bgcolor="#C9A84C" style="background-color:#C9A84C;padding:3px 0;border-radius:12px 12px 0 0"></td></tr>

  <!-- Title block -->
  <tr><td bgcolor="#060A14" style="background-color:#060A14;padding:28px 28px 24px;border-left:1px solid rgba(201,168,76,.15);border-right:1px solid rgba(201,168,76,.15)">
    <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td>
        <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#C9A84C;text-transform:uppercase;margin-bottom:8px">360 Booth Ireland · Jarvis Intelligence</div>
        <div style="font-size:24px;font-weight:800;color:#F0F6FC;letter-spacing:-0.5px;line-height:1.2">Auto-Scan Report</div>
        <div style="font-size:12px;color:#6E7681;margin-top:6px">${dublinDate} · Dublin</div>
      </td>
      <td align="right" valign="top">
        <div style="width:52px;height:52px;border-radius:50%;background:rgba(201,168,76,.1);border:1.5px solid rgba(201,168,76,.35);text-align:center;line-height:52px;font-size:22px">⚡</div>
      </td>
    </tr>
    </table>
  </td></tr>

  <!-- KPI row -->
  <tr><td bgcolor="#0A0F1A" style="background-color:#0A0F1A;padding:0;border-left:1px solid rgba(201,168,76,.1);border-right:1px solid rgba(201,168,76,.1)">
    <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td width="33%" bgcolor="#0A0F1A" style="background:#0A0F1A;padding:20px 12px;text-align:center;border-right:1px solid rgba(255,255,255,.05)">
        <div style="font-size:36px;font-weight:800;color:#FF4465;font-family:monospace;line-height:1">${hotLeads.length}</div>
        <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:#6E7681;text-transform:uppercase;margin-top:6px">Hot Leads</div>
      </td>
      <td width="33%" bgcolor="#0A0F1A" style="background:#0A0F1A;padding:20px 12px;text-align:center;border-right:1px solid rgba(255,255,255,.05)">
        <div style="font-size:36px;font-weight:800;color:#D29922;font-family:monospace;line-height:1">${warnLeads.length}</div>
        <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:#6E7681;text-transform:uppercase;margin-top:6px">Warm Leads</div>
      </td>
      <td width="33%" bgcolor="#0A0F1A" style="background:#0A0F1A;padding:20px 12px;text-align:center">
        <div style="font-size:36px;font-weight:800;color:#58A6FF;font-family:monospace;line-height:1">${leads.length}</div>
        <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:#6E7681;text-transform:uppercase;margin-top:6px">Total Found</div>
      </td>
    </tr>
    </table>
  </td></tr>

  <!-- Leads body -->
  <tr><td bgcolor="#0D1117" style="background-color:#0D1117;padding:24px 28px;border-left:1px solid rgba(255,255,255,.05);border-right:1px solid rgba(255,255,255,.05)">

    ${hotLeads.length ? `
    <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#FF4465;text-transform:uppercase;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid rgba(255,68,101,.15)">🔴 Hot Leads — Contact These First</div>
    ${hotLeads.slice(0, 5).map(leadCard).join('')}
    ` : ''}

    ${warnLeads.length ? `
    <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#D29922;text-transform:uppercase;margin-top:${hotLeads.length ? '20px' : '0'};margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid rgba(210,153,34,.15)">🟡 Warm Leads</div>
    ${warnLeads.slice(0, 4).map(leadCard).join('')}
    ` : ''}

    ${leads.length === 0 ? `
    <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td bgcolor="#111622" style="background:#111622;border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:32px;text-align:center">
      <div style="font-size:24px;margin-bottom:12px">🔍</div>
      <div style="font-size:14px;color:#484F58">No leads with contact info found this run.<br>The scanner ran successfully.</div>
    </td></tr>
    </table>
    ` : ''}

  </td></tr>

  <!-- CTA -->
  <tr><td bgcolor="#060A14" style="background-color:#060A14;padding:24px 28px;text-align:center;border-left:1px solid rgba(201,168,76,.1);border-right:1px solid rgba(201,168,76,.1)">
    <a href="https://360-booth-ireland.vercel.app" style="display:inline-block;background:#C9A84C;color:#07090E;font-size:13px;font-weight:700;text-decoration:none;padding:12px 28px;border-radius:8px;letter-spacing:.3px">Open Dashboard →</a>
    <div style="font-size:11px;color:#484F58;margin-top:16px">360-booth-ireland.vercel.app</div>
  </td></tr>

  <!-- Footer -->
  <tr><td bgcolor="#06090D" style="background-color:#06090D;padding:16px 28px;text-align:center;border:1px solid rgba(255,255,255,.04);border-top:none;border-radius:0 0 12px 12px">
    <div style="font-size:10px;color:#30363D;letter-spacing:.5px">Powered by Jarvis × 360 Booth Intelligence · Exa · Groq LLaMA 3.3 70B</div>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  const subject = hotLeads.length > 0
    ? `🔴 ${hotLeads.length} hot lead${hotLeads.length > 1 ? 's' : ''} — Jarvis · ${new Date(scannedAt).toLocaleDateString('en-IE',{timeZone:'Europe/Dublin',day:'numeric',month:'short'})}`
    : leads.length > 0
    ? `📊 ${leads.length} lead${leads.length > 1 ? 's' : ''} found — Jarvis Auto-Scan`
    : `⚡ Jarvis Auto-Scan ran — 0 leads with contact info`;

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
      leads, hotLeads, warnLeads,
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN,
      process.env.TWILIO_WHATSAPP_FROM,
      process.env.TWILIO_WHATSAPP_TO,
      scannedAt
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
      hotCount: hotLeads.length,
      warnCount: warnLeads.length,
      scanRunId,
      scannedAt: now,
      nextRun,
    });
  } catch (err) {
    console.error('[auto-scan]', err);
    return res.status(500).json({ error: err.message });
  }
};
