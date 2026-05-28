// 360 Booth Ireland — Two-way Jarvis WhatsApp AI
//
// SETUP (one-time, 2 minutes):
//   Twilio Console → Messaging → Try it out → Send a WhatsApp message
//   Under "When a message comes in" set URL to:
//     https://360-booth-ireland.vercel.app/api/whatsapp-webhook
//   Method: HTTP POST  → Save
//
// After that, any WhatsApp message sent TO +1 415 523 8886 from your
// number gets processed by Jarvis and replied to automatically.

const SUPABASE_URL = 'https://kcjmmiifemdarknrvpas.supabase.co';
const GROQ_BASE    = 'https://api.groq.com/openai/v1/chat/completions';
const TWILIO_BASE  = 'https://api.twilio.com/2010-04-01';

// ── Supabase helpers ──────────────────────────────────────────
async function sbGet(path, key) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  return r.ok ? r.json() : [];
}

// ── Twilio reply (send outbound message) ──────────────────────
async function twilioReply(body, sid, token, from, to) {
  const url = `${TWILIO_BASE}/Accounts/${sid}/Messages.json`;
  const params = new URLSearchParams({ To: to, From: from, Body: body.slice(0, 1600) });
  const creds = Buffer.from(`${sid}:${token}`).toString('base64');
  await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
}

// ── Format leads for WhatsApp ─────────────────────────────────
function formatLeads(leads, limit = 5) {
  if (!leads.length) return 'No leads found.';
  return leads.slice(0, limit).map((l, i) => {
    const score = l.lead_score || 0;
    const tag = score >= 80 ? '🔴' : score >= 55 ? '🟡' : '🔵';
    const lines = [`${i + 1}. ${tag} *${l.name || 'Event Lead'}* — ${score}/100`];
    if (l.event_name && l.event_name !== l.name) lines.push(`   ${l.event_name}`);
    if (l.email) lines.push(`   ✉ ${l.email}`);
    if (l.phone) lines.push(`   📞 ${l.phone}`);
    return lines.join('\n');
  }).join('\n\n');
}

// ── Groq AI reply with full context ──────────────────────────
async function groqReply(userMsg, leads, scans, groqKey) {
  const hot  = leads.filter(l => (l.lead_score || 0) >= 80);
  const warm = leads.filter(l => (l.lead_score || 0) >= 55 && (l.lead_score || 0) < 80);
  const topLeads = leads.slice(0, 8).map(l =>
    `${l.name || 'Lead'} | score:${l.lead_score || 0} | email:${l.email || 'none'} | phone:${l.phone || 'none'} | event:${l.event_name || ''}`
  ).join('\n');
  const lastScan = scans[0];
  const scanSummary = lastScan
    ? `Last scan: ${new Date(lastScan.scan_run_at || lastScan.created_at || Date.now()).toLocaleDateString('en-IE')} — found ${leads.length} total leads`
    : 'No scans yet.';

  const system = `You are Jarvis, the AI intelligence officer for 360 Booth Ireland — a premium 360-degree photo booth and selfie mirror hire company based in Ireland.

CURRENT DATA:
- Hot leads (score ≥80): ${hot.length}
- Warm leads (score 55-79): ${warm.length}
- Total leads: ${leads.length}
- ${scanSummary}

TOP LEADS:
${topLeads || 'None yet.'}

RULES:
- Reply via WhatsApp so keep it concise and formatted with *bold* and bullet points
- Always address the owner as Benji
- For lead lookups, show name, score, email/phone
- For scans, tell them when the last one ran and how many leads were found
- If asked to run a scan, say you've queued it and they'll get a full report shortly
- Suggest next actions (who to contact first, etc.)
- Sign off with "— Jarvis 360 Booth 🤖" on complex replies`;

  const r = await fetch(GROQ_BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ],
      temperature: 0.4,
      max_tokens: 400,
    }),
  });
  if (!r.ok) return null;
  const data = await r.json();
  return data.choices?.[0]?.message?.content || null;
}

// ── Intent detection ──────────────────────────────────────────
function detectIntent(msg) {
  const m = msg.toLowerCase();
  if (/\b(run scan|scan now|find leads|search leads|start scan)\b/.test(m)) return 'scan';
  if (/\b(hot leads?|best leads?|top leads?|urgent|priority)\b/.test(m)) return 'hot';
  if (/\b(all leads?|lead list|show leads?|how many leads?)\b/.test(m)) return 'all';
  if (/\b(pipeline|status|stats|summary|report)\b/.test(m)) return 'summary';
  if (/\b(hello|hi jarvis|hey jarvis|good morning|good evening|good afternoon)\b/.test(m)) return 'greeting';
  return 'ai';
}

// ── Main handler ──────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Twilio always sends POST; respond with empty TwiML immediately (200 required)
  res.setHeader('Content-Type', 'text/xml');
  if (req.method !== 'POST') return res.status(200).end('<?xml version="1.0"?><Response/>');

  const inboundFrom = req.body?.From || '';
  const inboundBody = (req.body?.Body || '').trim();
  if (!inboundBody || !inboundFrom) return res.status(200).end('<?xml version="1.0"?><Response/>');

  // Respond to Twilio immediately (must be fast) — send the reply async
  res.status(200).end('<?xml version="1.0"?><Response/>');

  // Now process and reply in background
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const GROQ_KEY    = process.env.GROQ_API_KEY;
  const TWILIO_SID  = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_TOK  = process.env.TWILIO_AUTH_TOKEN;
  const WA_FROM     = process.env.TWILIO_WHATSAPP_FROM; // sandbox number
  const WA_TO       = inboundFrom;                      // reply to whoever messaged

  if (!SERVICE_KEY || !GROQ_KEY || !TWILIO_SID || !TWILIO_TOK || !WA_FROM) return;

  try {
    // Fetch context
    const [leads, scans] = await Promise.all([
      sbGet('event_leads?order=scan_run_at.desc&limit=50&select=*', SERVICE_KEY),
      sbGet('scan_config?id=eq.main&select=*', SERVICE_KEY),
    ]);

    const intent = detectIntent(inboundBody);
    const hot    = (leads || []).filter(l => (l.lead_score || 0) >= 80);
    const warm   = (leads || []).filter(l => (l.lead_score || 0) >= 55 && (l.lead_score || 0) < 80);
    let reply;

    if (intent === 'scan') {
      reply = `⚡ *Scan queued, Benji.*\n\nI'll run a full Exa + Groq search for Irish event leads right now. You'll get a detailed WhatsApp report and email once it's done (~30 seconds).\n\n— Jarvis 360 Booth 🤖`;
      // Fire scan in background
      fetch(`https://360-booth-ireland.vercel.app/api/auto-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dashboard_trigger: true }),
      }).catch(() => {});

    } else if (intent === 'hot') {
      reply = hot.length
        ? `🔴 *${hot.length} Hot Lead${hot.length > 1 ? 's' : ''} — Contact Now*\n\n${formatLeads(hot, 5)}\n\n— Jarvis 360 Booth 🤖`
        : `No hot leads right now, Benji. ${warm.length} warm leads available.\n\nRun a scan to find new ones: just say *"run scan"*`;

    } else if (intent === 'all') {
      reply = `📊 *${(leads || []).length} Total Leads*\n🔴 ${hot.length} hot · 🟡 ${warm.length} warm\n\n${formatLeads(leads || [], 5)}\n\n🔗 https://360-booth-ireland.vercel.app`;

    } else if (intent === 'summary') {
      reply = `📊 *360 Booth Ireland — Pipeline Summary*\n\n🔴 Hot leads: ${hot.length}\n🟡 Warm leads: ${warm.length}\n📋 Total: ${(leads || []).length}\n💰 Pipeline est: €${(hot.length * 1200).toLocaleString()}\n\n${hot.length ? `Top priority: *${hot[0]?.name || 'Event Lead'}* (${hot[0]?.lead_score || 0}/100)` : 'Run a scan to find new leads.'}\n\n— Jarvis 360 Booth 🤖`;

    } else if (intent === 'greeting') {
      const hour = new Date().getHours();
      const time = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
      reply = `Good ${time}, Benji! 👋\n\n*Jarvis 360 Booth — online and ready.*\n\n🔴 ${hot.length} hot leads · 🟡 ${warm.length} warm\n\nWhat would you like to do?\n• *hot leads* — see your top leads\n• *run scan* — find new leads now\n• *summary* — pipeline overview\n• Or just ask me anything\n\n— Jarvis 🤖`;

    } else {
      // Send to Groq for general AI response
      reply = await groqReply(inboundBody, leads || [], scans || [], GROQ_KEY);
      if (!reply) reply = `I received your message, Benji. Try asking about your *hot leads*, *pipeline summary*, or say *"run scan"* to find new leads.\n\n— Jarvis 360 Booth 🤖`;
    }

    await twilioReply(reply, TWILIO_SID, TWILIO_TOK, WA_FROM, WA_TO);
  } catch (err) {
    console.error('[whatsapp-webhook]', err.message);
  }
};
