// 360 Booth Ireland — Jarvis AI Chat proxy
// POST /api/agent/chat { message, context?, searchWeb? }
// Returns { reply, sources? }
// Keys live in Vercel env vars — never exposed to browser.
//
// Required env vars:
//   GROQ_API_KEY  — for Jarvis brain (LLaMA 3.3 70B)
//   EXA_API_KEY   — for live web search (optional; degrades gracefully)

const EXA_BASE  = 'https://api.exa.ai';
const GROQ_BASE = 'https://api.groq.com/openai/v1/chat/completions';

const WEB_SEARCH_RX = /price|cost|€|euro|buy|find|supplier|vendor|shop|product|where|how much|deal|hire|link|website|quote|recommend/i;

async function exaWebSearch(query, exaKey) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(`${EXA_BASE}/search`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'x-api-key': exaKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: query + ' Ireland',
        numResults: 4, type: 'auto', useAutoprompt: true,
        contents: { text: { maxCharacters: 700 } },
      }),
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const d = await res.json();
    return (d.results || []).map(r => ({ title: r.title || '', url: r.url || '', snippet: (r.text || '').slice(0, 500) }));
  } catch { return []; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const EXA_KEY  = process.env.EXA_API_KEY;
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return res.status(500).json({ error: 'Missing GROQ_API_KEY' });

  const { message = '', context = {}, searchWeb = false, intent = false, history = [], isFirstMessage = false, mode = 'chat', lead = {} } = req.body || {};

  // ── REMINDER NOTIFICATION MODE ───────────────────────────────
  if (mode === 'reminder') {
    const { reminderType = 'Follow-up', reminderNote = '', daysUntil = 3 } = req.body || {};
    const RESEND_KEY   = process.env.RESEND_API_KEY;
    const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
    const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
    const TWILIO_FROM  = process.env.TWILIO_WHATSAPP_FROM;
    const TWILIO_TO    = process.env.TWILIO_WHATSAPP_TO;
    const leadName     = lead.title || lead.organizer || 'Lead';
    const dueDate      = new Date(Date.now() + daysUntil * 24 * 60 * 60 * 1000);
    const dueDateStr   = dueDate.toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long' });
    const results      = { email: false, wa: false, dueDate: dueDate.toISOString() };

    if (RESEND_KEY) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: '360 Booth Ireland <onboarding@resend.dev>',
            to: ['benj.sanusi@gmail.com'],
            subject: `⏰ ${reminderType} reminder: ${leadName} — ${dueDateStr}`,
            html: `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:28px;background:#07090E;color:#E8F0FC;border-radius:12px">
              <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#C9A84C;text-transform:uppercase;margin-bottom:12px">360 Booth Ireland · Reminder</div>
              <h2 style="color:#F0F6FC;font-size:20px;margin:0 0 20px">⏰ ${reminderType} Reminder Set</h2>
              <table style="width:100%;border-collapse:collapse">
                <tr><td style="padding:8px 0;color:#8B949E;font-size:13px;width:80px">Lead</td><td style="padding:8px 0;font-weight:600;font-size:13px">${leadName}</td></tr>
                <tr><td style="padding:8px 0;color:#8B949E;font-size:13px">Type</td><td style="padding:8px 0;font-size:13px">${reminderType}</td></tr>
                <tr><td style="padding:8px 0;color:#8B949E;font-size:13px">Due</td><td style="padding:8px 0;font-weight:600;color:#C9A84C;font-size:13px">${dueDateStr} (in ${daysUntil} day${daysUntil !== 1 ? 's' : ''})</td></tr>
                ${reminderNote ? `<tr><td style="padding:8px 0;color:#8B949E;font-size:13px;vertical-align:top">Note</td><td style="padding:8px 0;font-size:13px">${reminderNote}</td></tr>` : ''}
              </table>
              <a href="https://360-booth-ireland.vercel.app" style="display:inline-block;margin-top:20px;background:#C9A84C;color:#07090E;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px">Open Dashboard →</a>
            </div>`,
          }),
        });
        results.email = true;
      } catch {}
    }

    if (TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM && TWILIO_TO) {
      try {
        const waMsg = [
          `⏰ *Reminder Set — ${reminderType}*`,
          ``,
          `📋 *Lead:* ${leadName}`,
          `📅 *Due:* ${dueDateStr}`,
          reminderNote ? `📝 *Note:* ${reminderNote}` : '',
          ``,
          `→ https://360-booth-ireland.vercel.app`,
        ].filter(l => l !== null && l !== undefined).join('\n');
        const creds = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
        await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
          method: 'POST',
          headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ To: TWILIO_TO, From: TWILIO_FROM, Body: waMsg }).toString(),
        });
        results.wa = true;
      } catch {}
    }

    return res.status(200).json({ ok: true, ...results });
  }

  // ── EMAIL DRAFT MODE ─────────────────────────────────────────
  if (mode === 'email-draft') {
    const {
      title = '', organizer = '', event_type = '', attendees_tier = 'Unknown',
      url = '', relevance = '', action = '', booth_history = false,
      booth_competitor = '', description = '', event_date = '', venue = '',
    } = lead;
    const services = `360 Photo Booth (from €379), Selfie Magic Mirror (from €399), Magazine Vogue Booth (from €499), Vintage Photo Booth (from €399), LED Dancefloor (from €599), Balloon Arch & Backdrops (from €80), LED Heart Stand (from €149), LED Letters/Numbers (from €79), Marquee Letters (from €599)`;
    const boothLine = booth_history
      ? `NOTE: This organiser may have used a photo booth before (${booth_competitor || 'previous hire detected'}). Acknowledge this warmly — position 360 Booth Ireland as the premium upgrade.`
      : '';
    const draftPrompt = `You are Michael, owner of 360 Booth Ireland — premium photo/video booth hire. Write a warm, personalised cold email.

SERVICES: ${services}

TARGET LEAD:
- Event: ${title}
- Organiser: ${organizer || 'Unknown'}
- Event Type: ${event_type}
- Attendees: ${attendees_tier}
${event_date ? `- Event Date: ${event_date}` : ''}
${venue ? `- Venue: ${venue}` : ''}
${description ? `- About this event: ${description}` : ''}
- Why it fits: ${relevance}
${boothLine}

FRAMEWORK — OBSERVE → INSIGHT → OPPORTUNITY → CTA:
1. OBSERVE: Reference a specific detail about THEIR event — show you know it
2. INSIGHT: A genuine reason why guests at THIS event will love interactive entertainment
3. OPPORTUNITY: One specific service that fits. Mention price tier if helpful.
4. CTA: One easy, low-pressure ask — "Can I send you a 60-second clip?" or "Worth a quick chat this week?"

TONE RULES:
- Warm, human, conversational — not stiff or corporate
- Use contractions naturally (we've, you're, it's, that's)
- Add a friendly P.S. line at the end (a bonus tip, seasonal offer, or quick thought)
- Subject: curiosity-driven (under 8 words), no spam words (deal/offer/free/discount/urgent)
- Body: 110-130 words (not counting P.S.)
- First name if organiser name known, "Hi there" if not

Return JSON: {"subject":"...","body":"..."}`;
    try {
      const r = await fetch(GROQ_BASE, {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: draftPrompt }], response_format: { type: 'json_object' }, temperature: 0.65, max_tokens: 600 }),
      });
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      const p = JSON.parse(d.choices[0].message.content);
      return res.status(200).json({ subject: p.subject || '', body: p.body || '' });
    } catch (e) {
      return res.status(500).json({ error: 'Email draft failed: ' + e.message });
    }
  }

  if (!message.trim()) return res.status(400).json({ error: 'message is required' });

  // ── INTENT MODE — voice command classification ───────────────
  // Returns structured JSON so the frontend can execute dashboard actions.
  if (intent) {
    const pages = ['overview','agent','pipeline','history','leads','messages','chat','settings'];
    const { totalLeads=0, hotLeads=0, warmLeads=0, topHot=[], lastScan=null } = context;
    const intentPrompt = `You are 360, the intent classifier for a 360° photo booth CRM dashboard (360 Booth Ireland).
The owner spoke this voice command: "${message}"

LIVE CONTEXT:
- Total leads: ${totalLeads} | Hot (≥80): ${hotLeads} | Warm (55-79): ${warmLeads}
- Top hot leads: ${topHot.map(l=>`${l.title} (${l.score}/100${l.email?', '+l.email:''})`).join('; ')||'none yet'}
- Last scan: ${lastScan?`${new Date(lastScan.date).toLocaleDateString('en-IE')}, found ${lastScan.found} leads`:'never run'}

PAGES (use exact key): overview, agent, pipeline, history, leads, messages, chat, settings
- leads = "contacts", "database", "lead list", "all leads"
- messages = "whatsapp", "comms"
- agent = "intelligence", "intel", "monitor", "scanner"
- history = "scan history", "logs", "audit"
- overview = "home", "main", "dashboard"

ACTIONS:
- navigate: any variation of "show me", "open", "go to", "take me to", "pull up", "where are my"
- scan: "run a scan", "run that scanner", "find me leads", "search for leads", "do a scan", "start scanning"
- whatsapp: "send me", "text me", "ping me", "message me", "drop me a WhatsApp", "send on WhatsApp"
- email: "email me", "send email report", "email report"
- speak: questions about data, counts, pipeline, who to contact, general questions

For whatsapp content, generate a well-formatted WhatsApp message based on the command and live context.
Keep all "reply" fields to 1 SHORT sentence (under 12 words) — this is spoken out loud.

Return ONLY valid JSON (no markdown):
{"action":"navigate|scan|whatsapp|speak|email","page":"<page key if navigate>","reply":"<short spoken reply>","content":"<formatted whatsapp body if action=whatsapp>"}`;

    try {
      const groqRes = await fetch(GROQ_BASE, {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: intentPrompt }],
          temperature: 0.1,
          max_tokens: 200,
          response_format: { type: 'json_object' },
        }),
      });
      const data = await groqRes.json();
      const raw = data.choices?.[0]?.message?.content || '{}';
      return res.status(200).json(JSON.parse(raw));
    } catch (e) {
      return res.status(200).json({ action: 'speak', reply: "I heard you. Try: show me the database, run scan, or hot leads." });
    }
  }

  const shouldSearch = EXA_KEY && (searchWeb || WEB_SEARCH_RX.test(message));
  const webResults = shouldSearch ? await exaWebSearch(message, EXA_KEY) : [];

  // Build live dashboard context for system prompt
  const { leads = [], scans = [], pipeline = {} } = context;
  const totalLeads = leads.length;
  const hotLeads   = leads.filter(l => l.lead_score >= 80);
  const warmLeads  = leads.filter(l => l.lead_score >= 55 && l.lead_score < 80).length;
  const lastScan   = scans[0];

  const topHot = hotLeads
    .sort((a, b) => b.lead_score - a.lead_score)
    .slice(0, 4)
    .map(l => `  • ${l.title || l.domain} — ${l.lead_score}/100${l.organizer ? ', ' + l.organizer : ''}${l.email ? ', ' + l.email : l.email_inferred ? ', ' + l.email_inferred + ' (est.)' : ''}`)
    .join('\n');

  const pipelineSummary = Object.entries(pipeline)
    .map(([stage, count]) => `${stage}: ${count}`)
    .join(', ');

  const systemPrompt = [
    'You are 360 — the personal AI business intelligence officer for Michael, owner of 360 Booth Ireland.',
    '360 Booth Ireland is a premium 360° photo/video booth hire company based in Ireland.',
    'Services: 360 Booth (€800–€2,000/event) and Selfie Mirror (€500–€1,200/event).',
    'Clients: corporate events, galas, awards nights, product launches, weddings, charity balls across Ireland.',
    '',
    '=== YOUR PERSONALITY ===',
    'You are warm, sharp, and confident — like a highly capable EA and business advisor rolled into one.',
    'You speak to Michael like a trusted colleague: direct, insightful, occasionally witty, never robotic.',
    'You use natural language: contractions, short punchy sentences, clear structure.',
    'You ask follow-up questions when you need more context. You celebrate wins.',
    'Format long answers with clear sections. Use **bold** for key names and numbers.',
    'Keep responses focused — 2–4 paragraphs max unless a breakdown is needed.',
    isFirstMessage ? 'This is the first message of this chat. Open with a warm personal greeting to Michael, then dive into his question.' : '',
    '',
    '=== LIVE DASHBOARD ===',
    `Total leads: ${totalLeads} | Hot (≥80): ${hotLeads.length} | Warm (55–79): ${warmLeads}`,
    `Pipeline: ${pipelineSummary || 'empty'}`,
    lastScan
      ? `Last scan: ${new Date(lastScan.ts).toLocaleDateString('en-IE')} — ${lastScan.total || 0} events, ${lastScan.hot || 0} hot`
      : 'Last scan: not yet run',
    topHot ? `\nTop hot leads:\n${topHot}` : '',
    webResults.length
      ? `\n=== WEB RESULTS ===\n${webResults.map((r, i) => `[${i+1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n')}`
      : '',
  ].filter(Boolean).join('\n');

  // Build message thread: system + history (last 10 turns) + new user message
  const conversationHistory = (Array.isArray(history) ? history.slice(-10) : [])
    .filter(m => m.role && m.content);

  try {
    const groqRes = await fetch(GROQ_BASE, {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          ...conversationHistory,
          { role: 'user', content: message },
        ],
        temperature: 0.55,
        max_tokens: 900,
      }),
    });
    if (!groqRes.ok) {
      const e = await groqRes.json().catch(() => ({}));
      return res.status(502).json({ error: e.error?.message || `Groq error ${groqRes.status}` });
    }
    const data = await groqRes.json();
    const reply = data.choices?.[0]?.message?.content || 'No response generated.';
    return res.status(200).json({
      reply,
      sources: webResults.map(r => ({ title: r.title, url: r.url })),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
