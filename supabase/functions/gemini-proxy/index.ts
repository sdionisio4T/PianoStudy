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
import { getKeyAttemptOrder, TRANSIENT_UPSTREAM_STATUSES } from '../_shared/keyRotation.ts';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// 'gemini-flash-latest' es el alias vivo que Google mantiene para el mejor
// flash del momento — sobrevive a la rotación (los pines viejos como
// 1.5-flash-latest y 2.5-flash se cierran para keys nuevas sin aviso).
// Simetría texto/audio: mismo modelo para los dos modos, más simple de razonar
// sobre costos. Se puede sobreescribir por request con `model:` en el body,
// pero el modelo debe pasar por FREE_MODEL_GUARD abajo.
const DEFAULT_TEXT_MODEL = 'gemini-flash-latest';
const DEFAULT_AUDIO_MODEL = 'gemini-flash-latest';

// Política: solo modelos free-tier de Google. Los modelos flash (flash,
// flash-latest, 1.5-flash, 2.0-flash, 2.5-flash, flash-lite, etc.) tienen
// generosa cuota gratuita en AI Studio. Los "-pro" (gemini-1.5-pro,
// gemini-2.5-pro) son de pago fuera de la cuota chica de trial y NO deben
// llamarse desde esta app. Match sobre la substring "flash" en el slug
// (case-insensitive) — cubre alias vivos y pines históricos sin whitelistear
// cada uno. Rechazamos con 400 antes de tocar Google.
const FREE_MODEL_GUARD = true;
const isFreeGeminiModel = (m: string) => /flash/i.test(m);

// URL Gemini por modelo — se resuelve dinámicamente para permitir que el
// cliente pida un modelo específico (default distinto por modo). Cuando el
// cliente pide streaming, cambia el endpoint a :streamGenerateContent con
// alt=sse para obtener SSE compatible con nuestro parser.
const geminiUrl = (model: string, stream: boolean) =>
  stream
    ? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
    : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

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

  const rawKeySlot = (payloadIn as { keySlot?: unknown }).keySlot;
  const preferredSlot = rawKeySlot === 1 || rawKeySlot === 2 ? rawKeySlot : undefined;
  const attemptOrder = getKeyAttemptOrder(Deno.env, { prefix: 'GEMINI', preferredSlot });
  if (attemptOrder.length === 0) {
    return new Response(JSON.stringify({ error: 'Server misconfigured: missing GEMINI_API_KEY[_2]' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const model = typeof payloadIn.model === 'string' && payloadIn.model
      ? payloadIn.model
      : (mode === 'audio' ? DEFAULT_AUDIO_MODEL : DEFAULT_TEXT_MODEL);

    if (FREE_MODEL_GUARD && !isFreeGeminiModel(model)) {
      return new Response(JSON.stringify({
        error: `Gemini proxy solo permite modelos free ("flash*"). Recibido: "${model}".`,
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const temperature = Number.isFinite(payloadIn.temperature as number)
      ? Math.min(1, Math.max(0, Number(payloadIn.temperature)))
      : undefined;
    const wantsJson = payloadIn.responseFormat === 'json_object';
    // Streaming solo soportado en modo texto — el modo audio ya usa un endpoint
    // distinto (generateContent + inline_data) y no vale la pena complicarlo.
    const wantsStream = mode === 'text' && (payloadIn as { stream?: unknown }).stream === true;
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
      // maxOutputTokens en modo texto: sin esto, Gemini puede cortar el JSON
      // a mitad de string. El schema completo del análisis ronda 1500-2500
      // tokens; 3000 deja margen. Se puede override desde el cliente con
      // maxOutputTokens en el body (mismo campo que audio), cap 4096.
      const HARD_MAX_TEXT_TOKENS = 4096;
      const maxTokRaw = Number(payloadIn.maxOutputTokens);
      maxOutputTokens = Number.isFinite(maxTokRaw) && maxTokRaw > 0
        ? Math.min(HARD_MAX_TEXT_TOKENS, Math.floor(maxTokRaw))
        : 3000;
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

    let lastRes: Response | null = null;
    let usedSlot: 1 | 2 = attemptOrder[0].slot;
    const baseUrl = geminiUrl(model, wantsStream);

    for (let i = 0; i < attemptOrder.length; i++) {
      const { key, slot } = attemptOrder[i];
      // Gemini pasa la API key por query string (`?key=...`). Añadimos `&`
      // vs `?` según si la URL ya lleva query (streaming lleva alt=sse).
      const sep = baseUrl.includes('?') ? '&' : '?';
      const res = await fetch(`${baseUrl}${sep}key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
    try { body = JSON.parse(raw); } catch { /* leave as string */ }

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
