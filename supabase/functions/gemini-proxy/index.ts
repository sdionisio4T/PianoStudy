// Supabase Edge Function: gemini-proxy
// Proxies requests to Google Gemini to avoid browser CORS limitations.
// The API key lives only here (server-side secret) — the client never sees it.
// Requires a valid Supabase JWT and applies a basic per-user rate limit.
//
// Modos soportados:
// - texto  (default): { prompt, systemPrompt?, temperature?, responseFormat? }
// - audio            : { mode: 'audio', systemPrompt, parts: [...],
//                        model?, temperature?, maxOutputTokens?, responseFormat? }
//
// El modo audio se usa desde GeminiAudioAnalyzer.js — "escucha profunda" con
// fragmentos recortados (WAV mono 16k base64 en inline_data). Rate-limit
// dedicado, más estricto que el de texto (5/min vs 10/min por user).

/// <reference lib="deno.ns" />

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createRateLimiter } from '../_shared/rateLimiter.ts';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// 'gemini-flash-latest' es el alias vivo que Google mantiene para el mejor
// flash del momento — sobrevive a la rotación (los pines viejos como
// 1.5-flash-latest y 2.5-flash se cierran para keys nuevas sin aviso).
// Simetría texto/audio: mismo modelo para los dos modos, más simple de razonar
// sobre costos. Se puede sobreescribir por request con `model:` en el body.
const DEFAULT_TEXT_MODEL = 'gemini-flash-latest';
const DEFAULT_AUDIO_MODEL = 'gemini-flash-latest';

// URL Gemini por modelo — se resuelve dinámicamente para permitir que el
// cliente pida un modelo específico (default distinto por modo).
const geminiUrl = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

// Rate limiters separados: audio pesa mucho más por request (payload +
// tokens), lo limitamos a la mitad de lo que se permite en texto. Ambos en
// memoria por instancia — ver rateLimiter.ts para las limitaciones conocidas.
const rateLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });
const audioRateLimiter = createRateLimiter({ limit: 5, windowMs: 60_000 });

// Límites duros para el modo audio — sirven como defensa en profundidad si
// el cliente envía un payload absurdo (ej. sesión entera bypaseando el
// selector). Aún dentro del rate-limit, un request abusivo se rechaza acá.
const AUDIO_MAX_PARTS = 12;              // 3 clips + 3 labels + intro/outro margen
const AUDIO_MAX_TOTAL_BYTES = 2_500_000; // ~2.5 MB base64 total ≈ 45s WAV 16k mono

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

  // TODO: gate premium — ver comentario original conservado abajo. Sigue
  // desactivado por la misma razón: no todos los usuarios tienen plan real
  // todavía y el análisis de IA (texto y audio) es parte del plan free hoy.
  //
  // const { data: profile } = await supabaseClient
  //   .from('user_profiles').select('plan, paid_until').eq('id', userId).maybeSingle();
  // const isPremium = profile?.plan === 'premium' && (!profile.paid_until || new Date(profile.paid_until) > new Date());
  // if (!isPremium) { ... 402 ... }

  let payloadIn: Record<string, unknown> = {};
  try {
    payloadIn = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const mode = payloadIn?.mode === 'audio' ? 'audio' : 'text';

  // Rate limit según el modo.
  const isLimited = mode === 'audio'
    ? audioRateLimiter.isRateLimited(userId)
    : rateLimiter.isRateLimited(userId);
  if (isLimited) {
    return new Response(JSON.stringify({
      error: mode === 'audio' ? 'Too many audio requests, slow down.' : 'Too many requests, slow down.',
    }), {
      status: 429,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Server misconfigured: missing GEMINI_API_KEY' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const model = typeof payloadIn.model === 'string' && payloadIn.model
      ? payloadIn.model
      : (mode === 'audio' ? DEFAULT_AUDIO_MODEL : DEFAULT_TEXT_MODEL);

    const temperature = Number.isFinite(payloadIn.temperature as number)
      ? Math.min(1, Math.max(0, Number(payloadIn.temperature)))
      : undefined;
    const wantsJson = payloadIn.responseFormat === 'json_object';
    const systemPrompt = typeof payloadIn.systemPrompt === 'string' ? payloadIn.systemPrompt : '';

    let contents: unknown;
    let maxOutputTokens: number | undefined;

    if (mode === 'audio') {
      const parts = Array.isArray(payloadIn.parts) ? payloadIn.parts : null;
      if (!parts || parts.length === 0) {
        return new Response(JSON.stringify({ error: 'Missing audio parts' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (parts.length > AUDIO_MAX_PARTS) {
        return new Response(JSON.stringify({ error: `Too many parts (max ${AUDIO_MAX_PARTS})` }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      // Validación mínima de cada part + cálculo de payload total.
      let totalBytes = 0;
      for (const p of parts as Array<Record<string, unknown>>) {
        if (!p || typeof p !== 'object') {
          return new Response(JSON.stringify({ error: 'Invalid part' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        if (typeof (p as { text?: unknown }).text === 'string') {
          totalBytes += (p as { text: string }).text.length;
          continue;
        }
        const inline = (p as { inline_data?: { mime_type?: unknown; data?: unknown } }).inline_data;
        if (inline && typeof inline === 'object'
          && typeof inline.mime_type === 'string'
          && typeof inline.data === 'string') {
          totalBytes += (inline.data as string).length;
          continue;
        }
        return new Response(JSON.stringify({ error: 'Unknown part shape' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (totalBytes > AUDIO_MAX_TOTAL_BYTES) {
        return new Response(JSON.stringify({
          error: `Audio payload too large (${totalBytes} > ${AUDIO_MAX_TOTAL_BYTES} bytes)`,
        }), {
          status: 413, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      contents = [{ role: 'user', parts }];
      const maxTokRaw = Number(payloadIn.maxOutputTokens);
      if (Number.isFinite(maxTokRaw) && maxTokRaw > 0) {
        maxOutputTokens = Math.min(2048, Math.floor(maxTokRaw));
      }
    } else {
      const prompt = payloadIn.prompt;
      if (typeof prompt !== 'string' || !prompt) {
        return new Response(JSON.stringify({ error: 'Missing prompt' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      contents = [{ role: 'user', parts: [{ text: prompt }] }];
    }

    const payload: Record<string, unknown> = { contents };
    if (systemPrompt) {
      payload.systemInstruction = { parts: [{ text: systemPrompt }] };
    }
    const generationConfig: Record<string, unknown> = {};
    if (typeof temperature === 'number') generationConfig.temperature = temperature;
    if (wantsJson) generationConfig.responseMimeType = 'application/json';
    if (typeof maxOutputTokens === 'number') generationConfig.maxOutputTokens = maxOutputTokens;
    if (Object.keys(generationConfig).length > 0) payload.generationConfig = generationConfig;

    const res = await fetch(`${geminiUrl(model)}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
