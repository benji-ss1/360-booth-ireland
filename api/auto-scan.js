// 360 Booth Ireland — Scheduled Event Scanner
// Called daily by Vercel Cron (see vercel.json).
// Checks the scan_config table → runs scan if scheduled → writes to event_leads.

const SUPABASE_URL = 'https://kcjmmiifemdarknrvpas.supabase.co';
const EXA_BASE    = 'https://api.exa.ai';
const GROQ_BASE   = 'https://api.groq.com/openai/v1/chat/completions';
const TWILIO_BASE = 'https://api.twilio.com/2010-04-01';

// ── Rolling scan window ───────────────────────────────────────────────────────
// Always: 2 months ahead → 14 months ahead (12-month window).
// Gives enough lead time to book and never resurfaces events that are too close.
// May 2026 → July 2026–July 2027 | Aug 2026 → Oct 2026–Oct 2027 | etc.
function getScanWindow() {
  const now = new Date();
  const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1));
  const endDate   = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + 12, 1));
  const years     = [...new Set([startDate.getUTCFullYear(), endDate.getUTCFullYear()])].sort();
  return {
    startDate,
    endDate,
    years,
    startISO: startDate.toISOString().slice(0, 10),
    endISO:   endDate.toISOString().slice(0, 10),
  };
}

// Query templates — year(s) injected at runtime by buildDefaultQueries()
const QUERY_TEMPLATES = [
  // Corporate & Awards
  'corporate awards ceremony gala dinner Ireland',
  'company end of year party Dublin Cork Galway',
  'corporate awards night black tie Ireland',
  'business awards gala ceremony Dublin',
  'annual awards dinner business Ireland Cork Galway',
  'employee recognition awards gala Ireland',
  // Conferences & Summits
  'tech conference summit Dublin Ireland evening reception',
  'industry conference gala dinner Ireland',
  'professional association annual dinner awards Ireland',
  'business summit conference networking Dublin',
  'pharma biotech annual conference gala Ireland',
  'fintech finance summit gala dinner Dublin',
  'legal professional dinner awards Ireland',
  // Weddings
  'wedding reception venue hire Dublin Cork Galway',
  'luxury wedding reception Ireland',
  'wedding entertainment hire Ireland',
  'wedding venue booking Ireland Cork Limerick',
  // Product Launches & Brand Events
  'product launch event party Dublin Ireland',
  'brand activation launch party Ireland',
  'company milestone anniversary celebration Ireland',
  'new office opening celebration Ireland',
  'rebranding launch party corporate Ireland',
  // Charity & Galas
  'charity gala ball fundraiser dinner Ireland',
  'black tie charity ball auction dinner Ireland',
  'charity ball ticket gala Ireland Cork Dublin',
  'fundraiser gala dinner auction Ireland',
  // Sports & Social Clubs
  'golf club annual dinner dance awards Ireland',
  'sports club gala dinner awards night Ireland',
  'GAA club annual dinner dance Ireland',
  'rugby club gala dinner awards Ireland',
  // Venue & Hospitality
  'hotel ballroom gala event hire Dublin Cork',
  'premium event venue hire celebration Ireland',
  'venue hire corporate event Galway Limerick Waterford',
  // City-Specific Queries
  'gala dinner awards night Dublin',
  'corporate event awards ceremony Cork',
  'black tie event gala Galway',
  'awards dinner celebration Limerick Ireland',
  'corporate gala event Waterford Kilkenny',
  // Sector-Specific
  'healthcare medical annual conference gala Ireland',
  'construction property awards dinner Ireland',
  'retail fashion brand launch Ireland',
  'hospitality tourism awards Ireland',
  'media entertainment industry awards Ireland',
  // Social Media Workaround — Facebook/Instagram events indexed by Exa
  'site:facebook.com/events corporate gala party Ireland',
  'site:facebook.com/events awards dinner Ireland Cork Dublin',
  'site:facebook.com/events charity ball Ireland',
  'site:eventbrite.ie gala awards corporate dinner Ireland',
  'site:lovin.ie corporate event gala awards party Ireland',
  // Instagram/PR indirect — PR sites carry IG-announced events
  'site:businesspost.ie event launch gala awards corporate',
  'site:siliconrepublic.com event launch party Dublin Ireland',
  'site:irishexaminer.com gala awards fundraiser event Ireland',
  'site:independent.ie corporate event awards gala dinner',
  // LinkedIn Events workaround
  'site:linkedin.com/events Ireland corporate gala awards',
];

// Builds queries with the correct years for the rolling window.
// When the window spans two calendar years, both years are queried.
function buildDefaultQueries(years) {
  const queries = [];
  for (const template of QUERY_TEMPLATES) {
    for (const year of years) {
      queries.push(`${template} ${year}`);
    }
  }
  return queries;
}

const EVENT_DOMAINS = [
  'eventbrite.ie', 'eventbrite.com', 'ticketmaster.ie',
  'meetup.com', 'lovin.ie', 'entertainment.ie',
  'irishvenues.com', 'weddingsonline.ie', 'confex.com',
  'facebook.com', 'linkedin.com',
  'businesspost.ie', 'siliconrepublic.com', 'irishexaminer.com',
  'independent.ie', 'businessworld.ie', 'irishtimes.com',
];

// ── Supabase REST helpers ──────────────────────────────────────────────────

// Normalise a company/event name for fuzzy dedup comparison
function normName(s) {
  return (s || '').toLowerCase()
    .replace(/\b(the|a|an|&|and|of|in|at|for|by|ltd|limited|plc|llc|inc)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

// Fetch fingerprints of all existing leads to skip duplicates.
// Returns a Set of: email values + normName(event_name) + URLs extracted from notes.
async function fetchExistingFingerprints(serviceKey) {
  const prints = new Set();
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/event_leads?select=email,event_name,notes&limit=2000`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    );
    if (!res.ok) return prints;
    const rows = await res.json();
    for (const r of (rows || [])) {
      if (r.email) prints.add(r.email.trim().toLowerCase());
      if (r.event_name) prints.add(normName(r.event_name));
      // Extract URL from notes field: "Source: https://..."
      const urlMatch = (r.notes || '').match(/Source:\s*(https?:\/\/[^\s|]+)/);
      if (urlMatch) prints.add(urlMatch[1].trim().toLowerCase());
    }
  } catch (e) { /* non-fatal */ }
  return prints;
}

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
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    console.error(`[supabasePost] ${table} failed HTTP ${r.status}: ${errText.slice(0, 300)}`);
  }
  return r;
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

const GENERIC_EMAIL_RX = /^(info|hello|contact|support|admin|noreply|no-reply|enquir|press|media|office|reception|team|sales|booking|events?|general|mail|post|web|webmaster|editor|feedback)@/i;

function emailFallback(text) {
  // Find ALL emails in text, prefer non-generic ones first
  const all = (text || '').match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/g) || [];
  const specific = all.filter(e => !GENERIC_EMAIL_RX.test(e));
  return (specific[0] || all[0]) || null;
}

function phoneFallback(text) {
  const m = (text || '').match(/(\+353|0)[\s\-]?\d[\s\-]?\d{3}[\s\-]?\d{4}/);
  return m ? m[0].replace(/[\s\-]/g, '') : null;
}

async function exaSearch(query, exaKey, numResults = 15) {
  try {
    const res = await fetch(`${EXA_BASE}/search`, {
      method: 'POST',
      headers: { 'x-api-key': exaKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query, type: 'auto', numResults,
        contents: { highlights: true },
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map(r => ({ url: r.url, title: r.title }));
  } catch { return []; }
}

async function exaContents(urls, exaKey, maxCharacters = 4000) {
  if (!urls.length) return {};
  try {
    const res = await fetch(`${EXA_BASE}/contents`, {
      method: 'POST',
      headers: { 'x-api-key': exaKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: urls, text: { maxCharacters } }),
    });
    if (!res.ok) return {};
    const data = await res.json();
    const map = {};
    for (const r of (data.results || [])) map[r.url] = r;
    return map;
  } catch { return {}; }
}

async function extractWithGroq(text, title, url, groqKey, scanWindowStart, scanWindowEnd) {
  // Even with minimal text, attempt extraction using the page title
  const content = (text && text.length >= 80) ? text.slice(0, 3500) : title;
  if (!content) return null;
  const todayISO       = new Date().toISOString().slice(0, 10);
  const windowStartISO = (scanWindowStart || new Date()).toISOString().slice(0, 10);
  const windowEndISO   = (scanWindowEnd   || new Date(Date.now() + 365*24*3600*1000)).toISOString().slice(0, 10);
  try {
    const res = await fetch(GROQ_BASE, {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: `You are extracting an event lead for a 360° photo booth hire company in Ireland. Today is ${todayISO}. We are only interested in events happening between ${windowStartISO} and ${windowEndISO}.\nFrom the content below, extract as much as possible into JSON. Make your best guess for event_type from context clues.\nReturn: {"organizer_name":null,"email":null,"phone":null,"event_name":"","event_date":null,"venue":null,"event_type":"wedding|corporate|birthday|party|fundraiser|conference|gala|awards|other"}\nRULES FOR event_date:\n- Always return a full ISO date (YYYY-MM-DD) or null.\n- If only month+year is visible, use the 1st of that month (e.g. "August 2026" → "2026-08-01").\n- If only month+day is visible with no year, choose the year that falls within ${windowStartISO} to ${windowEndISO}. If no valid year fits, return null.\n- If the event date is before ${windowStartISO} or after ${windowEndISO}, still return the actual date — it will be filtered out downstream.\n- If no date is mentioned, return null.\nIf the page is a venue, hotel, or event space — set organizer_name to the venue name.\nContent:\n${content}` }],
        temperature: 0.1, max_tokens: 300,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const p = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    if (!p.email) p.email = emailFallback(text || '');
    if (!p.phone) p.phone = phoneFallback(text || '');
    // If Groq returned nothing useful, use the title as event_name
    if (!p.event_name && title) p.event_name = title.slice(0, 120);
    p.source_url = url;
    return p;
  } catch {
    return { organizer_name: null, email: emailFallback(text||''), phone: phoneFallback(text||''), event_name: title||'', event_date: null, venue: null, event_type: 'other', source_url: url };
  }
}

function computeLeadScore(e) {
  let score = 35; // base
  // Contact info — email+phone is the gold tier
  if (e.email && e.phone)   score += 40; // 75+ before event type → hot after type bonus
  else if (e.email)          score += 22; // email only → still hot with good event type
  else if (e.phone)          score += 10; // phone only → warm with good event type
  // Event type bonus
  const type = (e.event_type || '').toLowerCase();
  if (['corporate', 'conference', 'fundraiser', 'gala', 'awards'].some(t => type.includes(t))) score += 28;
  else if (type === 'wedding') score += 22;
  else if (['birthday', 'party'].some(t => type.includes(t))) score += 12;
  else score += 8;
  if (e.venue) score += 8;
  if (e.event_date) score += 7;
  return Math.min(score, 100);
}

// Signals that a page/event is already closed, sold out, or past
const CLOSED_RX = /\b(bookings?\s+(are\s+)?(now\s+)?closed|booking\s+closed|tickets?\s+(are\s+)?no\s+longer\s+available|event\s+has\s+(passed|ended|concluded)|this\s+event\s+is\s+over|registrations?\s+(are\s+)?closed|sold[\s-]out|event\s+(already\s+)?took\s+place|event\s+was\s+held)\b/i;

function isPageClosed(text) {
  return CLOSED_RX.test(text || '');
}

// Returns true if the event date falls within the scan window (or is unknown).
// Rejects events that are in the past OR too soon (before scanWindowStart).
function isEventInWindow(eventDate, scanWindowStart) {
  if (!eventDate) return true; // no date = keep (venue/organiser pages etc.)
  try {
    const iso = eventDate.length === 7 ? eventDate + '-01' : eventDate;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return true; // unparseable → keep to be safe
    return d >= scanWindowStart;
  } catch { return true; }
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

// ── Enrich leads with no contact info — 3-tier approach ──────────────────
// Tier 1: Fetch homepage + /contact + /about at 8000 chars (catches footers)
// Tier 2: Groq reads the page text if regex found nothing
// Tier 3: Exa web search for "[org name] email contact Ireland" — like web-searching for their email
// Zero hallucination — only extracts from real fetched page content.
async function enrichLeadContacts(leads, exaKey, groqKey) {
  const noContact = leads.filter(l => !l.email && !l.phone);
  if (!noContact.length) return;

  // Map origin → lead for batch processing
  const leadByOrigin = {};
  for (const l of noContact) {
    const m = (l.notes || '').match(/Source:\s*(https?:\/\/[^\s|]+)/);
    if (!m) continue;
    try {
      const origin = new URL(m[1]).origin;
      if (!leadByOrigin[origin]) leadByOrigin[origin] = l;
    } catch {}
  }
  if (!Object.keys(leadByOrigin).length) return;

  // TIER 1: Batch fetch homepage + contact pages with 8000 chars (footers are at the bottom)
  const tier1Urls = [];
  for (const origin of Object.keys(leadByOrigin)) {
    for (const path of ['/', '/contact', '/contact-us', '/about', '/about-us']) {
      tier1Urls.push(origin + path);
    }
  }
  const cm = await exaContents(tier1Urls, exaKey, 8000);

  const stillMissing = [];
  for (const [origin, l] of Object.entries(leadByOrigin)) {
    const text = ['/', '/contact', '/contact-us', '/about', '/about-us']
      .map(p => cm[origin + p]?.text || '')
      .join('\n');

    const email = emailFallback(text);
    const phone = phoneFallback(text);
    if (email) l.email = email;
    if (phone) l.phone = phone;

    // TIER 2: Groq reads the page text if regex found nothing
    if (!l.email && !l.phone && text.length > 150) {
      try {
        const extracted = await extractWithGroq(text.slice(0, 3000), l.event_name, origin + '/contact', groqKey);
        if (extracted?.email) l.email = extracted.email;
        if (extracted?.phone) l.phone = extracted.phone;
      } catch {}
    }

    if (l.email || l.phone) { l.lead_score = computeLeadScore(l); continue; }
    stillMissing.push(l);
  }

  if (!stillMissing.length) return;

  // TIER 3: Exa web search — search the open web for the organiser's contact details
  // This is the equivalent of searching Google for their email.
  await Promise.all(stillMissing.map(async (l) => {
    try {
      const q = `"${(l.event_name || l.name || '').slice(0, 60)}" email contact Ireland`;
      const searchHits = await exaSearch(q, exaKey, 4);
      if (!searchHits.length) return;
      const hitContent = await exaContents(searchHits.map(r => r.url), exaKey, 3000);
      const allText = Object.values(hitContent).map(c => c?.text || '').join('\n');
      const email = emailFallback(allText);
      const phone = phoneFallback(allText);
      if (email) l.email = email;
      if (phone) l.phone = phone;
      if (l.email || l.phone) l.lead_score = computeLeadScore(l);
    } catch {}
  }));
}

// ── WhatsApp alert after scan ─────────────────────────────────────────────
async function sendWhatsAppAlert(leads, hotLeads, warnLeads, sid, token, from, to, scannedAt, serviceKey) {
  if (!sid || !token || !from || !to) return;
  try {
    const dublinTime = new Date(scannedAt).toLocaleString('en-IE', {
      timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit',
    });
    const lines = [
      '⚡ *360 Scan — 360 Booth Ireland*',
      `🕐 ${dublinTime}`,
      '',
      `✅ *${leads.length} NEW lead${leads.length !== 1 ? 's' : ''} added* (deduped — no repeats)`,
      `🔴 ${hotLeads.length} hot  🟡 ${warnLeads.length} warm`,
    ];

    if (hotLeads.length) {
      lines.push('', '━━━━━━━━━━━━━━', '🔥 *HOT — Contact Today*');
      hotLeads.forEach((l, i) => {
        lines.push('');
        lines.push(`${i + 1}. *${l.event_name || l.name}* — ${l.lead_score}/100`);
        if (l.event_type) lines.push(`   📌 ${l.event_type}`);
        if (l.event_date) lines.push(`   📅 ${l.event_date}`);
        if (l.venue)      lines.push(`   📍 ${l.venue}`);
        if (l.name && l.event_name) lines.push(`   👤 ${l.name}`);
        if (l.email)      lines.push(`   ✉ ${l.email}`);
        if (l.phone)      lines.push(`   📞 ${l.phone}`);
      });
    }
    if (warnLeads.length) {
      lines.push('', '🟡 *Warm Leads*');
      warnLeads.forEach((l, i) => {
        lines.push(`${i + 1}. *${l.event_name || l.name}* — ${l.lead_score}/100`);
        if (l.email) lines.push(`   ✉ ${l.email}`);
        if (l.phone) lines.push(`   📞 ${l.phone}`);
      });
    }
    if (!leads.length) {
      lines.push('', '📭 No new leads this run (all already in database).');
    }

    lines.push('', '━━━━━━━━━━━━━━');
    lines.push('🔗 https://360-booth-ireland.vercel.app');

    const body = lines.join('\n').slice(0, 1600);
    const url = `${TWILIO_BASE}/Accounts/${sid}/Messages.json`;
    const params = new URLSearchParams({ To: to, From: from, Body: body });
    const credentials = Buffer.from(`${sid}:${token}`).toString('base64');
    const twilioRes = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const twilioData = twilioRes.ok ? await twilioRes.json().catch(() => ({})) : {};

    // Save the outbound alert to whatsapp_messages so the dashboard can display it
    if (serviceKey) {
      await supabasePost('whatsapp_messages', {
        direction:   'outbound',
        body,
        from_number: from,
        to_number:   to,
        twilio_sid:  twilioData.sid || null,
        label:       '360 Scan',
      }, serviceKey).catch(() => {});
    }
  } catch (err) {
    console.warn('[auto-scan] WhatsApp alert failed (non-fatal):', err.message);
  }
}

// ── Email report after auto-scan ──────────────────────────────────────────
const RESEND_BASE  = 'https://api.resend.com/emails';
// onboarding@resend.dev (sandbox) only delivers to the Resend account owner.
// Send only to that address until a custom domain is verified on Resend.
const TO_ADDRESSES = ['benj.sanusi@gmail.com'];
const FROM_ADDRESS = '360 Booth Ireland <onboarding@resend.dev>';

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
<title>360 Auto-Scan Report</title>
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
        <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#C9A84C;text-transform:uppercase;margin-bottom:8px">360 Booth Ireland · Intelligence OS</div>
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
    <div style="font-size:10px;color:#30363D;letter-spacing:.5px">Powered by 360 Booth Intelligence · Exa · Groq LLaMA 3.3 70B</div>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  const subject = hotLeads.length > 0
    ? `🔴 ${hotLeads.length} hot lead${hotLeads.length > 1 ? 's' : ''} — 360 ·${new Date(scannedAt).toLocaleDateString('en-IE',{timeZone:'Europe/Dublin',day:'numeric',month:'short'})}`
    : leads.length > 0
    ? `📊 ${leads.length} lead${leads.length > 1 ? 's' : ''} found — 360 Auto-Scan`
    : `⚡ 360 Auto-Scan ran — 0 leads with contact info`;

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

  // Build queries using the rolling 12-month window
  const { startDate: winStart, endDate: winEnd, years: winYears, startISO: winStartISO, endISO: winEndISO } = getScanWindow();
  const queries = buildDefaultQueries(winYears);
  const customTerms = config?.custom_terms || '';
  if (customTerms) {
    customTerms.split(',').map(t => t.trim()).filter(Boolean).forEach(term => {
      for (const year of winYears) queries.push(`${term} events Ireland ${year}`);
    });
  }
  console.log(`[auto-scan] window: ${winStartISO} → ${winEndISO} | years: ${winYears.join(', ')} | queries: ${queries.length}`);

  try {
    const scanRunId = uid();

    // Fetch existing fingerprints to avoid cross-scan duplicates
    const existingPrints = await fetchExistingFingerprints(SERVICE_KEY);

    // Run searches
    const allResults = [];
    for (const q of queries) {
      allResults.push(...(await exaSearch(q, EXA_KEY)));
    }

    // Deduplicate within this scan by URL, and against existing Supabase records
    const seen = new Set();
    const unique = allResults.filter(r => {
      const urlKey = (r.url || '').trim().toLowerCase();
      if (seen.has(urlKey)) return false;
      if (existingPrints.has(urlKey)) return false; // already in database
      seen.add(urlKey);
      return true;
    }).slice(0, 60);

    const contentMap = await exaContents(unique.map(r => r.url), EXA_KEY);

    // Extract leads — keep anything with a recognisable event name (no email required)
    async function extractBatch(batch) {
      const extracted = await Promise.all(
        batch.map(r => {
          const text = contentMap[r.url]?.text || '';
          // Skip pages that signal the event is already closed or past
          if (isPageClosed(text) || isPageClosed(r.title)) return null;
          return extractWithGroq(text, r.title, r.url, GROQ_KEY, winStart, winEnd);
        })
      );
      for (const e of extracted) {
        if (!e) continue;
        const emailKey = (e.email || '').trim().toLowerCase();
        const nameKey  = normName(e.event_name);
        if (emailKey && existingPrints.has(emailKey)) continue;
        if (nameKey.length > 4 && existingPrints.has(nameKey)) continue;
        // Accept lead if it has an event name OR organizer name (contact info optional)
        if (!e.event_name && !e.organizer_name) continue;
        // Drop events outside the rolling window (too soon or too old)
        if (!isEventInWindow(e.event_date, winStart)) continue;
        const lead = mapToLead(e, scanRunId);
        if (!lead) continue;
        // Only save Hot (≥80) and Warm (55-79) — Cool leads have no actionable value
        if (lead.lead_score < 55) continue;
        leads.push(lead);
        if (emailKey) existingPrints.add(emailKey);
        if (nameKey.length > 4) existingPrints.add(nameKey);
      }
    }

    const leads = [];
    for (let i = 0; i < unique.length; i += 6) {
      await extractBatch(unique.slice(i, i + 6));
      if (leads.length >= 12) break; // enough for a good scan report
    }

    // ── Fallback sweep — if < 2 leads, broaden search with simpler queries ──
    if (leads.length < 2) {
      const FALLBACK_TEMPLATES = [
        'awards gala dinner Ireland',
        'corporate event entertainment hire Dublin',
        'wedding entertainment photo booth Ireland',
        'charity fundraiser gala ball Ireland',
        'hotel venue event hire Cork Galway Dublin',
      ];
      const FALLBACK_QUERIES = FALLBACK_TEMPLATES.flatMap(t => winYears.map(y => `${t} ${y}`));
      const fallbackResults = [];
      for (const q of FALLBACK_QUERIES) {
        fallbackResults.push(...(await exaSearch(q, EXA_KEY, 12)));
      }
      const fallbackSeen = new Set(unique.map(r => r.url));
      const fallbackUnique = fallbackResults.filter(r => {
        const k = (r.url || '').toLowerCase();
        if (fallbackSeen.has(k) || existingPrints.has(k)) return false;
        fallbackSeen.add(k);
        return true;
      }).slice(0, 30);
      if (fallbackUnique.length) {
        const fbContentMap = await exaContents(fallbackUnique.map(r => r.url), EXA_KEY);
        // Merge into contentMap
        Object.assign(contentMap, fbContentMap);
        for (let i = 0; i < fallbackUnique.length; i += 6) {
          await extractBatch(fallbackUnique.slice(i, i + 6));
          if (leads.length >= 8) break;
        }
      }
    }

    // Enrich leads that have no email/phone via their contact/about pages
    await enrichLeadContacts(leads, EXA_KEY, GROQ_KEY);

    // Write only genuinely new leads to Supabase
    if (leads.length) {
      const insertRes = await supabasePost('event_leads', leads, SERVICE_KEY);
      if (!insertRes.ok) {
        console.error('[auto-scan] Lead insert failed — check Supabase schema matches mapToLead()');
      }
    }

    const hotLeads  = leads.filter(l => (l.lead_score || 0) >= 80);
    const warnLeads = leads.filter(l => (l.lead_score || 0) >= 55 && (l.lead_score || 0) < 80);
    const scannedAt = new Date().toISOString();

    // Send WhatsApp alert — awaited so Vercel doesn't terminate before Supabase save
    await sendWhatsAppAlert(
      leads, hotLeads, warnLeads,
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN,
      process.env.TWILIO_WHATSAPP_FROM,
      process.env.TWILIO_WHATSAPP_TO,
      scannedAt,
      SERVICE_KEY
    ).catch(e => console.warn('[auto-scan] WhatsApp alert outer catch:', e.message));

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
