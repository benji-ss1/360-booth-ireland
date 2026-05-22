import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') ?? '';
const REDIRECT_URI = Deno.env.get('GOOGLE_REDIRECT_URI') ?? 'https://kcjmmiifemdarknrvpas.supabase.co/functions/v1/google-auth-callback';

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
].join(' ');

function buildState(returnTo: string) {
  return btoa(JSON.stringify({ nonce: crypto.randomUUID(), returnTo }));
}

function resolveReturnTo(req: Request) {
  const url = new URL(req.url);
  const requested = url.searchParams.get('return_to');
  const origin = req.headers.get('origin');
  const fallback = origin ? `${origin.replace(/\/$/, '')}/` : 'https://360-booth-ireland.vercel.app/';
  const candidate = requested || fallback;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
  } catch (_) {}
  return fallback;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    });
  }

  if (!GOOGLE_CLIENT_ID) {
    return new Response(JSON.stringify({ error: 'GOOGLE_CLIENT_ID not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  const returnTo = resolveReturnTo(req);
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state: buildState(returnTo),
  });

  return new Response(JSON.stringify({
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
});
