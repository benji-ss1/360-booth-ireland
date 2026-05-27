// 360 Booth Ireland — Lead Intelligence Email Delivery
// Triggered by Vercel Cron (Mon–Fri 08:00 UTC) — checks DELIVERY_SCHEDULE env var to decide
// whether to actually run today. Manual POST { manual: true } always runs.
// Fetches the latest Exa monitor run → scores with Groq → emails digest to both addresses.
//
// Required env vars:
//   EXA_API_KEY          — https://dashboard.exa.ai → API Keys
//   GROQ_API_KEY         — https://console.groq.com → API Keys
//   RESEND_API_KEY       — https://resend.com → API Keys (free tier: 3,000 emails/mo)
//   CRON_SECRET          — any random string, set in Vercel Dashboard → Project → Settings → Environment Variables

const EXA_BASE     = 'https://api.exa.ai';
const GROQ_BASE    = 'https://api.groq.com/openai/v1/chat/completions';
const RESEND_BASE  = 'https://api.resend.com/emails';
const MONITOR_ID   = '01ksht4r08s1gdkmr33qw3b6j0';
const TO_ADDRESSES = ['benj.sanusi@gmail.com', 'info@360boothireland.ie'];
const FROM_ADDRESS = 'Jarvis 360 Booth <onboarding@resend.dev>'; // Resend default sender — no DNS setup needed

// ─────────────────────────────────────────────────────────────────────────────
// Exa helpers
// ─────────────────────────────────────────────────────────────────────────────

async function fetchMonitorRun(exaKey) {
  const res = await fetch(`${EXA_BASE}/monitors/${MONITOR_ID}/runs`, {
    headers: { 'x-api-key': exaKey },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Exa monitor runs ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  // Returns { data: [{ id, monitorId, status, output: { results: [] } }] }
  const runs = data.data || [];
  if (!runs.length) throw new Error('No monitor runs found');
  // Most recent first
  const latest = runs[0];
  return { runId: latest.id, results: latest.output?.results || [] };
}

async function fetchContents(urls, exaKey) {
  if (!urls.length) return {};
  try {
    const res = await fetch(`${EXA_BASE}/contents`, {
      method: 'POST',
      headers: { 'x-api-key': exaKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: urls, text: { maxCharacters: 1800 } }),
    });
    if (!res.ok) return {};
    const data = await res.json();
    const map = {};
    for (const r of (data.results || [])) map[r.url] = r.text || '';
    return map;
  } catch { return {}; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Groq scoring — same aggressive criteria as the Jarvis agent
// ─────────────────────────────────────────────────────────────────────────────

const SCORING_PROMPT = `You are a premium lead-scoring AI for 360 Booth Ireland — a high-end 360° photo/video booth hire company for corporate and premium social events in Ireland.

SCORING RULES (apply strictly):
HOT (85–100): Corporate awards ceremonies, black-tie gala dinners, corporate product launches with press, annual company conferences with evening gala (250+ attendees), VIP corporate hospitality, milestone company anniversaries (25/50/100 yr), professional association gala dinners, end-of-year parties at large corporations (KPMG EY Deloitte Google Amazon etc), charity balls — these clients pay premium and NEED entertainment.
WARM (55–84): Large tech summits with networking evening (300+), university graduations, trade shows with gala reception, corporate team-building at premium venues, sports club fundraiser dinners, charity auctions.
COOL (20–54): Startup/SME networking (<200 attendees), educational conferences, small meetups, basic social events.
NOT A LEAD (0–19): Virtual/online events, academic lectures, government compliance training, free public events, student events, religious ceremonies, political events.

BONUSES: +15 if gala/awards/ball/ceremony/launch/dinner in title; +10 if 500+ attendees mentioned; +10 if enterprise sponsors named; +10 if black-tie dress code mentioned.
PENALTIES: -20 regulatory/compliance focus; -15 academic/student; -20 online/virtual; -10 free entry.

Analyse these events and return ONLY valid JSON in this exact format:
{
  "events": [
    {
      "title": "...",
      "url": "...",
      "lead_score": 0-100,
      "urgency": "HOT|WARM|COOL|NOT_A_LEAD",
      "event_type": "...",
      "event_date": "YYYY-MM-DD or null",
      "venue": "...",
      "organizer": "...",
      "email": "...",
      "phone": "...",
      "attendees": "...",
      "pitch_angle": "1-sentence why 360 booth fits this event",
      "reasoning": "1-sentence score justification"
    }
  ]
}`;

async function scoreEventsWithGroq(events, groqKey) {
  const payload = events.map(e => ({
    title: e.title,
    url: e.url,
    text: e.text?.slice(0, 1200) || '',
  }));

  const res = await fetch(GROQ_BASE, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${groqKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SCORING_PROMPT },
        { role: 'user', content: `Score these ${events.length} events and return the JSON:\n${JSON.stringify(payload, null, 2)}` },
      ],
      temperature: 0.1,
      max_tokens: 3000,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Groq ${res.status}: ${t.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '{}';

  let parsed;
  try { parsed = JSON.parse(content); } catch { return []; }
  return parsed.events || [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Email HTML builder — Iron Man / Jarvis style
// ─────────────────────────────────────────────────────────────────────────────

function buildEmailHTML(events, runId, scannedAt) {
  const hot  = events.filter(e => e.urgency === 'HOT');
  const warm = events.filter(e => e.urgency === 'WARM');
  const cool = events.filter(e => e.urgency === 'COOL');

  const scoreColour = score =>
    score >= 85 ? '#FF4465' : score >= 55 ? '#F0A500' : '#00D4FF';

  const urgencyBadge = urgency => {
    const map = {
      HOT:        { bg: 'rgba(255,68,101,.18)', border: '#FF4465', text: '#FF4465', label: '🔴 HOT' },
      WARM:       { bg: 'rgba(240,165,0,.15)',  border: '#F0A500', text: '#F0A500', label: '🟡 WARM' },
      COOL:       { bg: 'rgba(0,212,255,.12)',  border: '#00D4FF', text: '#7EB8D8', label: '🔵 COOL' },
      NOT_A_LEAD: { bg: 'rgba(255,255,255,.05)', border: '#2E4A62', text: '#2E4A62', label: 'SKIP' },
    };
    const s = map[urgency] || map.COOL;
    return `<span style="display:inline-block;padding:2px 10px;border-radius:20px;border:1px solid ${s.border};background:${s.bg};color:${s.text};font-size:11px;font-weight:700;letter-spacing:.5px;">${s.label}</span>`;
  };

  const contactRow = (icon, label, value, href) => value
    ? `<tr><td style="color:#7EB8D8;font-size:12px;padding:2px 8px 2px 0;white-space:nowrap;">${icon} ${label}</td><td style="color:#D6EDFF;font-size:12px;">${href ? `<a href="${href}" style="color:#00D4FF;text-decoration:none;">${value}</a>` : value}</td></tr>`
    : '';

  const card = e => `
    <div style="background:#0C1520;border:1px solid rgba(0,212,255,${e.urgency==='HOT'?'.3':'07'});border-radius:10px;padding:18px 20px;margin-bottom:14px;">
      <table width="100%" style="border-collapse:collapse;"><tbody><tr valign="top">
        <td>
          ${urgencyBadge(e.urgency)}
          <div style="margin-top:8px;font-size:15px;font-weight:700;color:#D6EDFF;line-height:1.3;">
            <a href="${e.url}" style="color:#D6EDFF;text-decoration:none;">${e.title}</a>
          </div>
          ${e.event_type ? `<div style="font-size:12px;color:#7EB8D8;margin-top:3px;">${e.event_type}${e.event_date ? ` · ${e.event_date}` : ''}${e.venue ? ` · ${e.venue}` : ''}</div>` : ''}
          ${e.pitch_angle ? `<div style="margin-top:8px;font-size:12px;color:#C9A84C;font-style:italic;">${e.pitch_angle}</div>` : ''}
          <table style="margin-top:10px;border-collapse:collapse;"><tbody>
            ${contactRow('👤','Organizer', e.organizer, '')}
            ${contactRow('✉️','Email', e.email, e.email ? `mailto:${e.email}` : '')}
            ${contactRow('📞','Phone', e.phone, e.phone ? `tel:${e.phone}` : '')}
            ${contactRow('👥','Attendees', e.attendees, '')}
          </tbody></table>
          ${e.reasoning ? `<div style="margin-top:8px;font-size:11px;color:#2E4A62;border-top:1px solid rgba(0,212,255,.07);padding-top:8px;">${e.reasoning}</div>` : ''}
        </td>
        <td width="52" style="text-align:right;vertical-align:top;">
          <div style="font-size:22px;font-weight:800;color:${scoreColour(e.lead_score)};font-family:monospace;">${e.lead_score}</div>
          <div style="font-size:10px;color:#2E4A62;">SCORE</div>
        </td>
      </tr></tbody></table>
    </div>`;

  const section = (title, colour, items) => items.length === 0 ? '' : `
    <div style="margin-bottom:8px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:${colour};text-transform:uppercase;margin-bottom:10px;padding:6px 12px;background:rgba(0,212,255,.04);border-left:3px solid ${colour};border-radius:0 4px 4px 0;">
        ${title} — ${items.length} LEAD${items.length!==1?'S':''}
      </div>
      ${items.map(card).join('')}
    </div>`;

  const totalLeadable = hot.length + warm.length;
  const avgScore = events.length
    ? Math.round(events.reduce((s, e) => s + (e.lead_score || 0), 0) / events.length)
    : 0;

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap');
  body{margin:0;padding:0;background:#060A0E;font-family:'Inter',-apple-system,sans-serif;}
</style>
</head><body>
<div style="max-width:620px;margin:0 auto;padding:24px 16px;background:#060A0E;">

  <!-- Header -->
  <div style="text-align:center;margin-bottom:28px;">
    <div style="display:inline-block;width:48px;height:48px;border-radius:50%;border:2px solid #00D4FF;background:radial-gradient(circle,rgba(0,212,255,.3),transparent);margin-bottom:12px;line-height:48px;font-size:22px;">⚡</div>
    <div style="font-size:22px;font-weight:800;color:#00D4FF;letter-spacing:1px;">JARVIS INTEL REPORT</div>
    <div style="font-size:13px;color:#7EB8D8;margin-top:4px;">360 Booth Ireland — Weekly Lead Intelligence</div>
    <div style="font-size:11px;color:#2E4A62;margin-top:2px;">${new Date(scannedAt).toLocaleString('en-IE',{weekday:'long',year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'})} · Monitor Run ${runId.slice(0,10)}</div>
  </div>

  <!-- KPI bar -->
  <div style="display:flex;gap:12px;margin-bottom:24px;">
    <div style="flex:1;background:#0C1520;border:1px solid rgba(255,68,101,.2);border-radius:8px;padding:12px;text-align:center;">
      <div style="font-size:26px;font-weight:800;color:#FF4465;font-family:monospace;">${hot.length}</div>
      <div style="font-size:10px;color:#7EB8D8;letter-spacing:.8px;margin-top:2px;">HOT LEADS</div>
    </div>
    <div style="flex:1;background:#0C1520;border:1px solid rgba(240,165,0,.2);border-radius:8px;padding:12px;text-align:center;">
      <div style="font-size:26px;font-weight:800;color:#F0A500;font-family:monospace;">${warm.length}</div>
      <div style="font-size:10px;color:#7EB8D8;letter-spacing:.8px;margin-top:2px;">WARM LEADS</div>
    </div>
    <div style="flex:1;background:#0C1520;border:1px solid rgba(0,212,255,.15);border-radius:8px;padding:12px;text-align:center;">
      <div style="font-size:26px;font-weight:800;color:#00D4FF;font-family:monospace;">${totalLeadable}</div>
      <div style="font-size:10px;color:#7EB8D8;letter-spacing:.8px;margin-top:2px;">ACTIONABLE</div>
    </div>
    <div style="flex:1;background:#0C1520;border:1px solid rgba(201,168,76,.15);border-radius:8px;padding:12px;text-align:center;">
      <div style="font-size:26px;font-weight:800;color:#C9A84C;font-family:monospace;">${avgScore}</div>
      <div style="font-size:10px;color:#7EB8D8;letter-spacing:.8px;margin-top:2px;">AVG SCORE</div>
    </div>
  </div>

  <!-- Lead sections -->
  ${section('🔴 HOT LEADS — CALL FIRST', '#FF4465', hot)}
  ${section('🟡 WARM LEADS — WORTH PITCHING', '#F0A500', warm)}
  ${section('🔵 COOL LEADS — LOW PRIORITY', '#00D4FF', cool)}

  ${totalLeadable === 0 ? `<div style="text-align:center;padding:32px;color:#2E4A62;font-size:14px;">No actionable leads found in this scan. Monitor will run again next week.</div>` : ''}

  <!-- Footer -->
  <div style="margin-top:28px;padding-top:16px;border-top:1px solid rgba(0,212,255,.07);text-align:center;">
    <div style="font-size:11px;color:#2E4A62;line-height:1.7;">
      Powered by <span style="color:#00D4FF;">Jarvis × 360 Booth Intelligence</span><br>
      Exa Monitor · Groq LLaMA 3.3 70B · SimplifyOS<br>
      <span style="color:#1A2E42;">To update settings, open your Jarvis dashboard.</span>
    </div>
  </div>

</div>
</body></html>`;
}

function buildEmailText(events, runId, scannedAt) {
  const hot  = events.filter(e => e.urgency === 'HOT');
  const warm = events.filter(e => e.urgency === 'WARM');
  const lines = [`JARVIS INTEL REPORT — 360 Booth Ireland`, `Scanned: ${scannedAt}`, `Run: ${runId}`, '',
    `HOT: ${hot.length} | WARM: ${warm.length} | Total actionable: ${hot.length + warm.length}`, '', '---'];
  for (const e of [...hot, ...warm]) {
    lines.push(`[${e.urgency} ${e.lead_score}] ${e.title}`);
    if (e.url)       lines.push(`  URL: ${e.url}`);
    if (e.organizer) lines.push(`  Organizer: ${e.organizer}`);
    if (e.email)     lines.push(`  Email: ${e.email}`);
    if (e.phone)     lines.push(`  Phone: ${e.phone}`);
    if (e.pitch_angle) lines.push(`  Pitch: ${e.pitch_angle}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Resend email sender
// ─────────────────────────────────────────────────────────────────────────────

async function sendEmail({ html, text, subject, resendKey }) {
  const results = [];
  for (const to of TO_ADDRESSES) {
    const res = await fetch(RESEND_BASE, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM_ADDRESS, to, subject, html, text }),
    });
    const data = await res.json();
    results.push({ to, ok: res.ok, id: data.id, error: data.message });
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth — Vercel cron sends CRON_SECRET, manual triggers send the same header
  const cronSecret    = process.env.CRON_SECRET;
  const authHeader    = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const manualTrigger = req.body?.manual === true;
  const isCronCall    = cronSecret ? authHeader === cronSecret : !manualTrigger;

  if (cronSecret && authHeader !== cronSecret && !manualTrigger) {
    return res.status(401).json({ error: 'Unauthorised. Set Authorization: Bearer <CRON_SECRET> header.' });
  }

  // Schedule gate — cron fires Mon–Fri but we only deliver on configured days
  if (isCronCall && !manualTrigger) {
    const DELIVERY_DAYS = {
      weekly: [1],
      '2x':   [1, 4],
      '3x':   [1, 3, 5],
      '4x':   [1, 2, 4, 5],
      '5x':   [1, 2, 3, 4, 5],
    };
    const schedule = (process.env.DELIVERY_SCHEDULE || 'weekly').toLowerCase();
    const allowedDays = DELIVERY_DAYS[schedule] || DELIVERY_DAYS.weekly;
    const todayUTC = new Date().getUTCDay(); // 0=Sun … 6=Sat
    if (!allowedDays.includes(todayUTC)) {
      return res.status(200).json({ message: `Schedule is "${schedule}" — today (day ${todayUTC}) is not a delivery day. Skipped.` });
    }
  }

  const EXA_KEY    = process.env.EXA_API_KEY;
  const GROQ_KEY   = process.env.GROQ_API_KEY;
  const RESEND_KEY = process.env.RESEND_API_KEY;

  if (!EXA_KEY)    return res.status(500).json({ error: 'Missing EXA_API_KEY env var' });
  if (!GROQ_KEY)   return res.status(500).json({ error: 'Missing GROQ_API_KEY env var' });
  if (!RESEND_KEY) return res.status(500).json({ error: 'Missing RESEND_API_KEY env var — sign up free at resend.com' });

  try {
    // 1. Fetch latest Exa monitor run
    console.log('[deliver-leads] Fetching Exa monitor run...');
    const { runId, results: rawResults } = await fetchMonitorRun(EXA_KEY);
    console.log(`[deliver-leads] Got ${rawResults.length} results from run ${runId}`);

    if (!rawResults.length) {
      return res.status(200).json({ message: 'No results in latest monitor run — nothing to send.' });
    }

    // 2. Fetch page contents for deeper scoring
    const urls = rawResults.map(r => r.url).filter(Boolean);
    const contentMap = await fetchContents(urls.slice(0, 15), EXA_KEY);

    // Merge content into results
    const enriched = rawResults.slice(0, 15).map(r => ({
      title: r.title || 'Untitled',
      url:   r.url || '',
      text:  contentMap[r.url] || r.text || r.highlights?.join(' ') || '',
    }));

    // 3. Score with Groq — batch into groups of 8 to avoid token limit
    console.log('[deliver-leads] Scoring with Groq...');
    const scored = [];
    for (let i = 0; i < enriched.length; i += 8) {
      const batch = enriched.slice(i, i + 8);
      const batchScored = await scoreEventsWithGroq(batch, GROQ_KEY);
      scored.push(...batchScored);
    }

    // Sort by score descending
    scored.sort((a, b) => (b.lead_score || 0) - (a.lead_score || 0));

    // 4. Build + send email
    const scannedAt = new Date().toISOString();
    const hotCount  = scored.filter(e => e.urgency === 'HOT').length;
    const subject   = hotCount > 0
      ? `🔴 ${hotCount} HOT lead${hotCount > 1 ? 's' : ''} found — Jarvis Intel ${new Date().toLocaleDateString('en-IE')}`
      : `📊 Weekly Intel Report — ${scored.length} events scanned`;

    const html   = buildEmailHTML(scored, runId, scannedAt);
    const text   = buildEmailText(scored, runId, scannedAt);

    console.log('[deliver-leads] Sending email...');
    const emailResults = await sendEmail({ html, text, subject, resendKey: RESEND_KEY });
    const allOk = emailResults.every(r => r.ok);
    const warmCount = scored.filter(e => e.urgency === 'WARM').length;

    // 5. Send WhatsApp notification (non-blocking — don't fail if Twilio not configured)
    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_WHATSAPP_TO) {
      try {
        await fetch(`${process.env.VERCEL_URL ? 'https://'+process.env.VERCEL_URL : 'http://localhost:3000'}/api/whatsapp-notify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hot: hotCount, warm: warmCount, total: scored.length }),
        });
      } catch (waErr) {
        console.warn('[deliver-leads] WhatsApp notify failed (non-fatal):', waErr.message);
      }
    }

    return res.status(allOk ? 200 : 207).json({
      success: allOk,
      runId,
      eventsScored: scored.length,
      hot: hotCount,
      warm: warmCount,
      emails: emailResults,
      scannedAt,
    });

  } catch (err) {
    console.error('[deliver-leads]', err);
    return res.status(500).json({ error: err.message });
  }
};
