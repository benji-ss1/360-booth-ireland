// 360 Booth Ireland — Two-way WhatsApp via Twilio
//
// TWILIO SETUP (one-time):
//   Console → Messaging → Try it out → Send a WhatsApp message
//   Under "When a message comes in" set Webhook URL to:
//     https://360-booth-ireland.vercel.app/api/whatsapp-webhook
//   Method: HTTP POST → Save
//
// Every inbound reply is saved to Supabase whatsapp_messages (direction=inbound).
// Jarvis auto-replies and that reply is also saved (direction=outbound).
// The dashboard polls /api/agent/messages every 7s and shows both.

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

async function sbInsert(table, key, data) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(data),
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    console.error(`[sbInsert] ${table} failed HTTP ${r.status}: ${errText.slice(0, 200)}`);
  }
  return r.ok;
}

// ── Twilio send ───────────────────────────────────────────────
async function twilioSend(body, sid, token, from, to) {
  const url  = `${TWILIO_BASE}/Accounts/${sid}/Messages.json`;
  const form = new URLSearchParams({ To: to, From: from, Body: body.slice(0, 1600) });
  const creds = Buffer.from(`${sid}:${token}`).toString('base64');
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (r.ok) {
    const d = await r.json();
    return d.sid || null;
  }
  return null;
}

// ── Format leads for WhatsApp ─────────────────────────────────
function formatLeads(leads, limit = 5) {
  if (!leads.length) return 'No leads found.';
  return leads.slice(0, limit).map((l, i) => {
    const score = l.lead_score || 0;
    const tag   = score >= 80 ? '🔴' : score >= 55 ? '🟡' : '🔵';
    const lines = [`${i + 1}. ${tag} *${l.name || 'Event Lead'}* — ${score}/100`];
    if (l.event_name && l.event_name !== l.name) lines.push(`   ${l.event_name}`);
    if (l.email)  lines.push(`   ✉ ${l.email}`);
    if (l.phone)  lines.push(`   📞 ${l.phone}`);
    return lines.join('\n');
  }).join('\n\n');
}

// ── Groq AI reply ─────────────────────────────────────────────
async function groqReply(userMsg, leads, groqKey) {
  const hot  = leads.filter(l => (l.lead_score || 0) >= 80);
  const warm = leads.filter(l => (l.lead_score || 0) >= 55 && (l.lead_score || 0) < 80);
  const topLeads = leads.slice(0, 8).map(l =>
    `${l.name || 'Lead'} | score:${l.lead_score || 0} | email:${l.email || 'none'} | phone:${l.phone || 'none'}`
  ).join('\n');

  const system = `You are 360 — Michael's AI intelligence officer for 360 Booth Ireland, a premium 360° photo/video booth hire company.

LIVE DATA: ${hot.length} hot leads (≥80) · ${warm.length} warm · ${leads.length} total
TOP LEADS:
${topLeads || 'None yet.'}

RULES:
- This is WhatsApp — keep replies concise, use *bold* and emoji naturally
- Address the owner as Michael
- Show lead name, score, email/phone when asked
- Suggest the next best action
- Sign complex replies with "— 360 🤖"`;

  const r = await fetch(GROQ_BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }],
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
  if (/\b(hot leads?|best leads?|top leads?|urgent|priority)\b/.test(m))     return 'hot';
  if (/\b(all leads?|lead list|show leads?|how many leads?)\b/.test(m))       return 'all';
  if (/\b(pipeline|status|stats|summary|report)\b/.test(m))                  return 'summary';
  if (/\b(hi|hello|hey 360|good morning|good evening|good afternoon)\b/.test(m)) return 'greeting';
  return 'ai';
}

// ── Main handler ──────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');

  if (req.method !== 'POST') {
    return res.status(200).end('<?xml version="1.0"?><Response/>');
  }

  const inboundFrom = req.body?.From || '';
  const inboundBody = (req.body?.Body || '').trim();
  const twilioMsgSid = req.body?.MessageSid || null;

  if (!inboundBody || !inboundFrom) {
    return res.status(200).end('<?xml version="1.0"?><Response/>');
  }

  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const GROQ_KEY    = process.env.GROQ_API_KEY;
  const TWILIO_SID  = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_TOK  = process.env.TWILIO_AUTH_TOKEN;
  const WA_FROM     = process.env.TWILIO_WHATSAPP_FROM;

  // ── 1. Persist inbound message immediately (before anything else) ──
  if (SERVICE_KEY) {
    sbInsert('whatsapp_messages', SERVICE_KEY, {
      direction:   'inbound',
      body:        inboundBody,
      from_number: inboundFrom,
      to_number:   WA_FROM || 'sandbox',
      twilio_sid:  twilioMsgSid,
      label:       'Reply',
    }).catch(() => {});
  }

  // ── 2. Respond to Twilio immediately (must be fast) ──
  res.status(200).end('<?xml version="1.0"?><Response/>');

  // ── 3. Build reply + save outbound async ──
  if (!SERVICE_KEY || !GROQ_KEY || !TWILIO_SID || !TWILIO_TOK || !WA_FROM) return;

  try {
    const leads = await sbGet('event_leads?order=scan_run_at.desc&limit=50&select=*', SERVICE_KEY);
    const arr   = leads || [];
    const hot   = arr.filter(l => (l.lead_score || 0) >= 80);
    const warm  = arr.filter(l => (l.lead_score || 0) >= 55 && (l.lead_score || 0) < 80);

    const intent = detectIntent(inboundBody);
    let reply;

    if (intent === 'scan') {
      reply = `⚡ *Scan queued, Michael.*\n\nRunning a full Exa + Groq search right now — you'll get a WhatsApp report and email in ~30 seconds.\n\n— 360 🤖`;
      fetch('https://360-booth-ireland.vercel.app/api/auto-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dashboard_trigger: true }),
      }).catch(() => {});

    } else if (intent === 'hot') {
      reply = hot.length
        ? `🔴 *${hot.length} Hot Lead${hot.length > 1 ? 's' : ''} — Contact Now*\n\n${formatLeads(hot, 5)}\n\n— 360 🤖`
        : `No hot leads right now, Michael. ${warm.length} warm leads in the pipeline.\n\nSay *"run scan"* to find new ones.`;

    } else if (intent === 'all') {
      reply = `📊 *${arr.length} Total Leads*\n🔴 ${hot.length} hot · 🟡 ${warm.length} warm\n\n${formatLeads(arr, 5)}\n\n🔗 https://360-booth-ireland.vercel.app`;

    } else if (intent === 'summary') {
      reply = `📊 *360 Booth Ireland — Pipeline*\n\n🔴 Hot: ${hot.length}\n🟡 Warm: ${warm.length}\n📋 Total: ${arr.length}\n💰 Est. value: €${(hot.length * 750).toLocaleString()}\n\n${hot.length ? `Top pick: *${hot[0]?.name || 'Lead'}* (${hot[0]?.lead_score || 0}/100)` : 'Run a scan to find leads.'}\n\n— 360 🤖`;

    } else if (intent === 'greeting') {
      const h    = new Date().getHours();
      const time = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
      reply = `Good ${time}, Michael! 👋\n\n*360 — online and ready.*\n🔴 ${hot.length} hot · 🟡 ${warm.length} warm leads\n\nWhat would you like?\n• *hot leads* — see top leads\n• *run scan* — find new leads\n• *summary* — pipeline overview\n• Or just ask anything`;

    } else {
      reply = await groqReply(inboundBody, arr, GROQ_KEY);
      if (!reply) reply = `Got your message, Michael. Try:\n• *hot leads* • *run scan* • *summary*\n\n— 360 🤖`;
    }

    // ── 4. Send reply via Twilio ──
    const outSid = await twilioSend(reply, TWILIO_SID, TWILIO_TOK, WA_FROM, inboundFrom);

    // ── 5. Persist outbound reply to Supabase ──
    if (SERVICE_KEY) {
      await sbInsert('whatsapp_messages', SERVICE_KEY, {
        direction:   'outbound',
        body:        reply,
        from_number: WA_FROM,
        to_number:   inboundFrom,
        twilio_sid:  outSid,
        label:       '360',
      });
    }
  } catch (err) {
    console.error('[whatsapp-webhook]', err.message);
  }
};
