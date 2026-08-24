// Supabase Edge Function: openrouter-proxy
// Proxies requests to OpenRouter (OpenAI-compatible API) to avoid browser
// CORS y para mantener las API keys server-side. Estructura idéntica a
// groq-proxy: JWT check, rate limit, doble key con rotación + fallback,
// soporte de streaming por passthrough SSE.
//
// OpenRouter expone catálogo amplio (Claude, Llama, Mistral, Gemma,
// DeepSeek, GPT-OSS, gratis y pagos). El default `openrouter/auto` deja
// que OpenRouter elija el mejor modelo disponible; el cliente puede
// pinear con `model` (ej. 'meta-llama/llama-3.3-70b-instruct:free').

/// <reference lib="deno.ns" />

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createRateLimiter } from '../_shared/rateLimiter.ts';
import { getKeyAttemptOrder, TRANSIENT_UPSTREAM_STATUSES } from '../_shared/keyRotation.ts';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// SOLO modelos free. `openrouter/auto` NO se usa porque puede rutar a
// modelos pagos y cobraría contra la key.
//
// Convención de OpenRouter: los modelos gratuitos llevan sufijo ":free" en
// el slug (p.ej. "meta-llama/llama-3.3-70b-instruct:free"). Enforced abajo
// con FREE_ONLY_GUARD — si el cliente pide un modelo sin ":free", se
// rechaza el request con 400 antes de tocar OpenRouter.
//
// Default: dots-studio/dots-3-note-preview:free — uno de los DOS únicos
// modelos free en OpenRouter (2026-08) que declaran soporte real de
// structured_outputs / response_format json_object. Sin eso el análisis
// devuelve chain-of-thought y falla el validador.
//
// Historial de intentos fallidos (para no volver a caer en la misma trampa):
//   - meta-llama/llama-3.3-70b-instruct:free  → 404 (discontinuado)
//   - nvidia/nemotron-3.5-lightning:free      → ignora JSON mode, chain-of-thought
//   - thinkingmachines/inkling:free           → 403 (requiere aceptar TML ToS +
//                                                "solo para agentic harnesses")
//
// Catálogo free vigente al 2026-08 (verificado contra /api/v1/models):
//   - dots-studio/dots-3-note-preview:free    ← default (JSON mode real)
//   - liquid/lfm-2.5-2.6b:free                (JSON mode real, pero solo 2.6B params)
//   - thinkingmachines/inkling:free           (403 TML)
//   - thinkingmachines/inkling-small:free     (mismo TML)
//   - nvidia/nemotron-3.5-lightning:free      (no JSON)
//   - poolside/laguna-s-2.1:free              (no JSON)
const DEFAULT_MODEL = 'dots-studio/dots-3-note-preview:free';

// Enforcement duro: cualquier `model` que no termine en ":free" se rechaza
// con 400. Es defensa en profundidad — si un cliente futuro (o un bug)
// pasara un modelo pago por accidente, el proxy no lo deja pasar.
const FREE_ONLY_GUARD = true;
const isFreeModel = (m: string) => m.endsWith(':free');

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

  if (rateLimiter.isRateLimited(userId)) {
    return new Response(JSON.stringify({ error: 'Too many requests, slow down.' }), {
      status: 429,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const {
      prompt, systemPrompt, model, temperature, responseFormat,
      maxTokens: payloadMaxTokens, stream, keySlot,
    } = await req.json();

    if (!prompt || typeof prompt !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing prompt' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const temp = Number.isFinite(temperature)
      ? Math.min(1, Math.max(0, Number(temperature)))
      : 0.7;
    const wantsJson = responseFormat === 'json_object';
    const wantsStream = stream === true;

    const HARD_MAX_TOKENS = 4096;
    const clientMaxTokens = Number(payloadMaxTokens);
    const maxTokens = Number.isFinite(clientMaxTokens) && clientMaxTokens > 0
      ? Math.min(HARD_MAX_TOKENS, Math.floor(clientMaxTokens))
      : 2000;

    const preferredSlot = keySlot === 1 || keySlot === 2 ? keySlot : undefined;
    const attemptOrder = getKeyAttemptOrder(Deno.env, { prefix: 'OPENROUTER', preferredSlot });
    if (attemptOrder.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Server misconfigured: missing OPENROUTER_API_KEY[_2]' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const messages: Array<{ role: string; content: string }> = [];
    if (systemPrompt && typeof systemPrompt === 'string') {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const requestedModel = typeof model === 'string' && model ? model : DEFAULT_MODEL;
    if (FREE_ONLY_GUARD && !isFreeModel(requestedModel)) {
      return new Response(JSON.stringify({
        error: `OpenRouter proxy solo permite modelos free (sufijo ":free"). Recibido: "${requestedModel}".`,
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const payload: Record<string, unknown> = {
      model: requestedModel,
      messages,
      temperature: temp,
      max_tokens: maxTokens,   // OpenRouter usa `max_tokens`, no `max_completion_tokens`
    };
    if (wantsJson) payload.response_format = { type: 'json_object' };
    if (wantsStream) payload.stream = true;

    let lastRes: Response | null = null;
    let usedSlot: 1 | 2 = attemptOrder[0].slot;

    for (let i = 0; i < attemptOrder.length; i++) {
      const { key, slot } = attemptOrder[i];
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          // Headers opcionales que OpenRouter usa para atribuir el request
          // en su leaderboard/analytics. No afectan la respuesta.
          'HTTP-Referer': 'https://pianostudy.app',
          'X-Title': 'PianoStudy',
        },
        body: JSON.stringify(payload),
      });
      lastRes = res;
      usedSlot = slot;

      if (wantsStream) break;
      if (res.ok) break;
      if (!TRANSIENT_UPSTREAM_STATUSES.has(res.status)) break;
      if (i === attemptOrder.length - 1) break;
    }

    if (wantsStream && lastRes && lastRes.ok && lastRes.body) {
      return new Response(lastRes.body, {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Key-Slot': String(usedSlot),
        },
      });
    }

    const raw = await (lastRes?.text() ?? Promise.resolve(''));
    let body: unknown = raw;
    try { body = JSON.parse(raw); } catch { /* deja como string */ }

    return new Response(JSON.stringify({
      status: lastRes?.status ?? 500,
      body,
      meta: { keySlotUsed: usedSlot },
    }), {
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
