// Supabase Edge Function: groq-proxy
// Proxies requests to Groq (OpenAI-compatible API) to avoid browser CORS
// limitations. The API key lives only here (server-side secret) — the client
// never sees it. Requires a valid Supabase JWT and applies a basic per-user
// rate limit.
//
// Groq da inferencia muy rápida y tiene free tier generoso; se usa como
// proveedor primario desde AIAnalysisEngine.js. Si falla o no está
// configurado, el cliente cae automáticamente a gemini-proxy.

/// <reference lib="deno.ns" />

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createRateLimiter } from '../_shared/rateLimiter.ts';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
// Modelo por defecto — groq/compound-mini. Historia del cambio (2026-08-18):
//   1. `llama-3.3-70b-versatile` dejó de estar habilitado para la org
//      Personal entre el 16 y el 18 de agosto (Groq removió acceso;
//      /models no lo lista más, toda llamada devuelve model_not_found).
//   2. Migramos a `qwen/qwen3.6-27b` — funcionó, pero su TPM free tier es
//      8K y el prompt (~4K) + max_completion_tokens (2K) = 6K por request,
//      dejando 2K de margen: cualquier segunda grabación dentro del minuto
//      caía por 429.
//   3. Migramos a `groq/compound-mini`: TPM free tier 70K (8.75× más
//      margen), mismo endpoint OpenAI-compatible. Trade-off: compound es
//      un modelo agentic (LLM + tools); en teoría puede añadir metadatos
//      no previstos, pero response_format json_object + parseLlmJson en
//      el cliente toleran texto alrededor del JSON. Si aparecen problemas
//      de formato, revertir a qwen es un one-liner.
// Se puede sobreescribir desde el cliente pasando `model`.
const DEFAULT_MODEL = 'groq/compound-mini';

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
    const { prompt, systemPrompt, model, temperature, responseFormat, maxTokens: payloadMaxTokens } = await req.json();

    if (!prompt || typeof prompt !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing prompt' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Clamps: temperature acotada [0, 1] (Groq acepta hasta 2 pero para nuestros
    // casos análisis + Q&A no queremos ir arriba de 1); responseFormat solo
    // acepta el literal 'json_object' — cualquier otra cosa se ignora.
    const temp = Number.isFinite(temperature)
      ? Math.min(1, Math.max(0, Number(temperature)))
      : 0.7;
    const wantsJson = responseFormat === 'json_object';

    // max_completion_tokens: sin esto, el default de Groq cortaba respuestas
    // JSON a mitad de string (~1024 tokens) y el parser caía a fallback. Con
    // el schema completo (musicalAnalysis 2-3 párrafos + hasta 3 observations
    // × 3 capas + exercise steps + moments + beliefVsDetection +
    // metacognitiveQuestion) una respuesta rica ronda 1500-2000 tokens.
    //
    // Ajustado 2026-08-18: 3000 → 2000. Groq factura el TPM contra el max
    // SOLICITADO, no contra lo que la respuesta realmente usa. Con Qwen 3.6
    // 27B (8000 TPM en free tier), 3000 hacía inviable dos grabaciones
    // seguidas en el mismo minuto. 2000 deja margen para respuestas ricas
    // (>90% de las respuestas medidas caen dentro) y libera ~1000 TPM por
    // request. Se puede override desde el cliente con `maxTokens` si algún
    // caller necesita respuestas más largas, siempre acotado al techo duro.
    const HARD_MAX_TOKENS = 4096;
    const clientMaxTokens = Number(payloadMaxTokens);
    const maxTokens = Number.isFinite(clientMaxTokens) && clientMaxTokens > 0
      ? Math.min(HARD_MAX_TOKENS, Math.floor(clientMaxTokens))
      : 2000;

    const apiKey = Deno.env.get('GROQ_API_KEY');
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'Server misconfigured: missing GROQ_API_KEY' }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    const messages: Array<{ role: string; content: string }> = [];
    if (systemPrompt && typeof systemPrompt === 'string') {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const payload: Record<string, unknown> = {
      model: typeof model === 'string' && model ? model : DEFAULT_MODEL,
      messages,
      temperature: temp,
      max_completion_tokens: maxTokens,
    };
    if (wantsJson) {
      payload.response_format = { type: 'json_object' };
    }

    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    const raw = await res.text();
    let body: unknown = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      // deja como string
    }

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
