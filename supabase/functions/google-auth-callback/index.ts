import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') ?? '';
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '';
const REDIRECT_URI = Deno.env.get('GOOGLE_REDIRECT_URI') ?? 'https://kcjmmiifemdarknrvpas.supabase.co/functions/v1/google-auth-callback';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const APP_URL = Deno.env.get('APP_URL') ?? 'https://360-booth-ireland.vercel.app/';

function decodeState(rawState: string | null) {
  if (!rawState) return {};
  try {
    return JSON.parse(atob(rawState));
  } catch (_) {
    return {};
  }
}

function resolveReturnTo(state: Record<string, unknown>) {
  const candidate = typeof state.returnTo === 'string' ? state.returnTo : APP_URL;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
  } catch (_) {}
  return APP_URL;
}

function redirectWithParams(base: string, params: Record<string, string>) {
  const url = new URL(base);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return Response.redirect(url.toString(), 302);
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

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const state = decodeState(url.searchParams.get('state'));
  const returnTo = resolveReturnTo(state);

  if (error) return redirectWithParams(returnTo, { google_error: error });
  if (!code) return redirectWithParams(returnTo, { google_error: 'no_code' });
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return redirectWithParams(returnTo, { google_error: 'missing_credentials' });
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || tokens.error) {
      return redirectWithParams(returnTo, {
        google_error: tokens.error ?? 'token_failed',
        google_error_desc: tokens.error_description ?? '',
      });
    }

    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const userInfo = await userRes.json();

    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { error: dbError } = await supabase.from('google_tokens').upsert({
        email: userInfo.email,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
        scope: tokens.scope,
        token_type: tokens.token_type,
        user_info: userInfo,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'email' });
      if (dbError) console.error('[google-auth-callback] upsert error', dbError);
    }

    return redirectWithParams(returnTo, {
      google_connected: 'true',
      google_email: userInfo.email,
    });
  } catch (err) {
    console.error('[google-auth-callback] unexpected error', err);
    return redirectWithParams(returnTo, { google_error: 'server_error' });
  }
});
