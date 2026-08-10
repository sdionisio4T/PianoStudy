// Supabase Edge Function: gemini-proxy
// Proxies requests to Google Gemini to avoid browser CORS limitations.
// The API key lives only here (server-side secret) — the client never sees it.
// Requires a valid Supabase JWT and applies a basic per-user rate limit.

/// <reference lib="deno.ns" />

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createRateLimiter } from '../_shared/rateLimiter.ts';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent';

// In-memory per-instance rate limit: 10 req/min por user_id.
// Lógica testeada en tests/rateLimiter.test.js (ver supabase/functions/_shared/rateLimiter.ts).
const rateLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const authHeader = req.headers.get('authorization');
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userErr } = await supabaseClient.auth.getUser();
  if (userErr || !userData?.user) {
    return new Response(JSON.stringify({ error: 'Invalid or expired session' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const userId = userData.user.id;

  // TODO: conectar cuando se configure Stripe (Fase 3). Descomentar este
  // bloque SOLO cuando haya usuarios reales con plan='premium' — si se
  // activa antes, esto bloquea a TODOS los usuarios porque hoy nadie tiene
  // plan='premium' (columna agregada en supabase/migrations/0004_plan_columns.sql,
  // default 'free' para todos). Nota de producto pendiente: este es el proxy
  // que usa el análisis de IA gratuito hoy (AIAnalysisEngine.js) — según
  // DIAGNOSTICO_Y_PLAN.md el plan free debería seguir teniendo análisis/Q&A
  // básico. Gatear todo este endpoint por premium contradice eso; evaluar un
  // gate más granular (ej. límite de requests distinto por plan) antes de
  // descomentar esto en producción.
  //
  // const { data: profile, error: profileErr } = await supabaseClient
  //   .from('user_profiles')
  //   .select('plan, paid_until')
  //   .eq('id', userId)
  //   .maybeSingle();
  // const isPremium = !profileErr && profile?.plan === 'premium'
  //   && (!profile.paid_until || new Date(profile.paid_until) > new Date());
  // if (!isPremium) {
  //   return new Response(JSON.stringify({ error: 'Esta función requiere el plan Premium' }), {
  //     status: 402,
  //     headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  //   });
  // }

  if (rateLimiter.isRateLimited(userId)) {
    return new Response(JSON.stringify({ error: 'Too many requests, slow down.' }), {
      status: 429,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const { prompt, systemPrompt } = await req.json();

    if (!prompt || typeof prompt !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing prompt' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // TODO(pendiente 0.1 — acción del usuario): cargar GEMINI_API_KEY en
    // Supabase Dashboard → Project Settings → Edge Functions → Secrets antes
    // de desplegar esta función. Sin esa env var, el proxy responde 500.
    const apiKey = Deno.env.get('GEMINI_API_KEY');
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'Server misconfigured: missing GEMINI_API_KEY' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const payload: Record<string, unknown> = {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
    };

    if (systemPrompt && typeof systemPrompt === 'string') {
      payload.systemInstruction = {
        parts: [{ text: systemPrompt }],
      };
    }

    const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const raw = await res.text();
    let body: unknown = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      // leave as string
    }

    // Always return 200 so supabase-js invoke doesn't throw transport errors.
    return new Response(JSON.stringify({ status: res.status, body }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ status: 500, body: { error: message } }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
