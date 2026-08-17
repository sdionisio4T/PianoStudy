// GeminiAudioAnalyzer.js — segunda capa de percepción auditiva. Envía los
// fragmentos ya recortados al edge function `gemini-proxy` en modo audio y
// devuelve OBSERVACIONES estructuradas para que AIAnalysisEngine las combine
// con los datos objetivos que ya calculó Essentia/Basic Pitch.
//
// Nunca genera el feedback final. Nunca reemplaza al análisis local. Falla en
// silencio (devuelve null) — el pipeline principal sigue igual sin esta capa.

import { db } from './supabase-client.js';
import { GEMINI_AUDIO_CONFIG } from './GeminiAudioConfig.js';
import { parseLlmJson } from '../utils/jsonRepair.js';

// System prompt estable — pensado para que Gemini haga context caching implícito
// entre requests. NO meter datos de sesión acá; van en el userText.
const AUDIO_SYSTEM_PROMPT = `Sos un músico y profesor de piano especializado en jazz, latin jazz, son cubano y bolero. Vas a escuchar entre 1 y 3 fragmentos cortos de una interpretación al piano.

TU FUNCIÓN: aportar PERCEPCIÓN MUSICAL que complemente un análisis computacional que ya se hizo aparte. Sos una segunda capa auditiva, no el analizador principal.

REGLAS DURAS:
- Escuchá el audio real. No inventes notas, acordes, errores ni intenciones que no puedas percibir con razón.
- No conviertas automáticamente alta densidad en un error.
- No asumas que las agudas son la melodía ni que las graves son el bajo.
- No hagas transcripción MIDI completa. No hace falta identificar cada nota.
- Distinguí SIEMPRE:
  1. Lo que percibís directamente.
  2. Lo que parece probable.
  3. Lo que no podés determinar.

QUÉ ESCUCHAR (solo si es audiblemente relevante):
- estabilidad del pulso, sensación rítmica, groove
- fraseo, articulación, dinámica, contraste
- claridad de líneas, interacción entre acompañamiento y línea principal
- continuidad de las frases, carácter musical
- relación con el estilo declarado (si viene alguno)

FRAGMENTOS: cada fragmento viene precedido por su timestamp real (t=INICIO→FIN segundos) de la grabación original. Usá esos tiempos si citás algo — no digas "en el primer fragmento", decí "hacia el segundo N".

FORMATO DE SALIDA — objeto JSON exacto, sin fences, sin texto afuera:
{
  "auditory_observations": [
    { "type": "rhythm|articulation|dynamics|phrasing|groove|character|style|clarity", "observation": "<frase corta>", "confidence": <0.0-1.0>, "timestamp_start": <segundos>, "timestamp_end": <segundos> }
  ],
  "strengths": ["<observación positiva concreta>"],
  "areas_to_explore": ["<sugerencia expresiva o técnica, no un juicio>"],
  "uncertainties": ["<lo que no pudiste percibir con claridad>"]
}

Límites: máximo 4 observations, 3 strengths, 3 areas_to_explore, 2 uncertainties. Frases cortas (≤ 160 caracteres). Si no percibís nada específico en algún campo, devolvé el array vacío — nunca inventes relleno.`;

// Interleavea texto+audio: cada clip va precedido por su etiqueta temporal
// para que el modelo pueda anclarlas al citar tiempos.
function buildParts(metadata, clips) {
    const style = String(metadata?.style || '').trim();
    const objective = String(metadata?.objective || '').trim();
    const level = String(metadata?.level || '').trim();

    const introLines = ['Contexto mínimo de la sesión (usalo solo si es audiblemente relevante):'];
    if (style) introLines.push(`- Estilo declarado: ${style}`);
    if (level) introLines.push(`- Nivel declarado: ${level}`);
    if (objective) introLines.push(`- Objetivo declarado: ${objective}`);
    if (introLines.length === 1) introLines.push('- (ninguno declarado)');
    introLines.push('');
    introLines.push('A continuación los fragmentos, cada uno etiquetado con su timestamp en la grabación original.');

    const parts = [{ text: introLines.join('\n') }];
    clips.forEach((c, i) => {
        parts.push({
            text: `Fragmento ${i + 1} — t=${c.startSec.toFixed(1)}s → ${c.endSec.toFixed(1)}s (${c.seconds}s). Motivo de selección: ${c.reason}.`,
        });
        parts.push({
            inline_data: { mime_type: c.mimeType, data: c.dataBase64 },
        });
    });
    parts.push({ text: 'Devolvé ÚNICAMENTE el objeto JSON según el schema del system.' });
    return parts;
}

function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`gemini-audio timeout ${ms}ms`)), ms);
        Promise.resolve(promise).then(
            (v) => { clearTimeout(t); resolve(v); },
            (e) => { clearTimeout(t); reject(e); },
        );
    });
}

// Alias del util compartido — Gemini también sufre del bug de \n literal
// dentro de strings, especialmente cuando devuelve `observation` largas con
// varias oraciones. Ver assets/js/utils/jsonRepair.js.
const parseJsonRelaxed = parseLlmJson;

const VALID_TYPES = ['rhythm', 'articulation', 'dynamics', 'phrasing', 'groove', 'character', 'style', 'clarity'];

// Normaliza y valida. Devuelve null si no hay nada aprovechable. Recorta a los
// límites del schema y clampa timestamps al rango real de los clips enviados.
export function validateAuditoryPayload(parsed, clips) {
    if (!parsed || typeof parsed !== 'object') return null;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
    const validClips = Array.isArray(clips) && clips.length ? clips : [{ startSec: 0, endSec: 0 }];
    const totalStart = Math.min(...validClips.map(c => Number(c.startSec) || 0));
    const totalEnd = Math.max(...validClips.map(c => Number(c.endSec) || 0));

    const obsSrc = Array.isArray(parsed.auditory_observations) ? parsed.auditory_observations : [];
    const auditory_observations = obsSrc
        .filter(o => o && typeof o === 'object' && typeof o.observation === 'string' && o.observation.trim())
        .slice(0, 4)
        .map(o => ({
            type: VALID_TYPES.includes(o.type) ? o.type : 'character',
            observation: String(o.observation).trim().slice(0, 200),
            confidence: clamp(o.confidence, 0, 1),
            timestamp_start: clamp(o.timestamp_start, totalStart, totalEnd),
            timestamp_end: clamp(o.timestamp_end, totalStart, totalEnd),
        }));

    const asArr = (arr, max) => (Array.isArray(arr) ? arr : [])
        .filter(x => typeof x === 'string' && x.trim())
        .slice(0, max)
        .map(x => x.trim().slice(0, 200));

    const strengths = asArr(parsed.strengths, 3);
    const areas_to_explore = asArr(parsed.areas_to_explore, 3);
    const uncertainties = asArr(parsed.uncertainties, 2);

    if (!auditory_observations.length && !strengths.length && !areas_to_explore.length) {
        return null;   // respuesta vacía o de puro relleno → no aporta
    }
    return { auditory_observations, strengths, areas_to_explore, uncertainties };
}

// Punto de entrada. Devuelve:
//   { observations: {...}, model_used, usage: { segments_sent, audio_seconds_sent,
//                                               input_tokens, output_tokens, total_tokens } }
// o null si no hay nada que aportar o el proxy no respondió bien.
// Nunca tira: siempre resuelve.
export async function analyzeAudioClips(clips, metadata = {}, config = {}) {
    const cfg = { ...GEMINI_AUDIO_CONFIG, ...config };
    if (!Array.isArray(clips) || clips.length === 0) return null;

    // Lista de modelos a probar en orden. Si `modelNames` no vino, se cae al
    // legacy `modelName` como lista de uno solo para no romper callers viejos.
    const modelList = Array.isArray(cfg.modelNames) && cfg.modelNames.length > 0
        ? cfg.modelNames.filter(m => typeof m === 'string' && m.trim())
        : [cfg.modelName].filter(Boolean);
    if (modelList.length === 0) {
        console.warn('gemini-audio: no hay modelos configurados');
        return null;
    }

    const parts = buildParts(metadata, clips);
    const totalSeconds = clips.reduce((s, c) => s + (Number(c.seconds) || 0), 0);

    const backoff = Math.max(0, Number(cfg.retryBackoffMs) || 0);
    const maxAttemptsPerModel = 1 + Math.max(0, Number(cfg.retryAttempts) || 0);

    // Rotación entre modelos. Para cada uno, permitimos hasta N reintentos
    // ante errores transitorios NO relacionados con cuota (503, 500, timeout).
    // Un 429/403 con quota → saltar al siguiente modelo sin reintentar.
    let lastFailure = null;
    for (let mi = 0; mi < modelList.length; mi++) {
        const model = modelList[mi];
        const body = {
            mode: 'audio',
            systemPrompt: AUDIO_SYSTEM_PROMPT,
            parts,
            model,
            temperature: cfg.temperature,
            maxOutputTokens: cfg.maxOutputTokens,
            responseFormat: 'json_object',
        };
        const result = await _tryModel(model, body, cfg.timeoutMs, backoff, maxAttemptsPerModel);
        if (result.ok) {
            const usageMeta = result.data.body?.usageMetadata || {};
            const candidate = result.data.body?.candidates?.[0];
            const text = String(candidate?.content?.parts?.[0]?.text || '').trim();
            const finishReason = String(candidate?.finishReason || 'unknown');
            const parsed = parseJsonRelaxed(text);
            const validated = validateAuditoryPayload(parsed, clips);
            if (!validated) {
                const hint = finishReason === 'MAX_TOKENS'
                    ? ' — RESPUESTA TRUNCADA (subir maxOutputTokens)'
                    : parsed === null
                        ? ' — no parseó, posible JSON malformado'
                        : ' — parseó pero validación descartó (schema o arrays vacíos)';
                console.warn(`gemini-audio [${model}] respuesta inválida o vacía` + hint,
                    'finishReason=', finishReason,
                    'rawTextSnippet=', text.slice(0, 400),
                );
                // Respuesta inválida NO es un problema del modelo — no rotamos.
                return null;
            }
            return {
                observations: validated,
                model_used: model,
                usage: {
                    segments_sent: clips.length,
                    audio_seconds_sent: Number(totalSeconds.toFixed(2)),
                    input_tokens: Number(usageMeta.promptTokenCount || 0),
                    output_tokens: Number(usageMeta.candidatesTokenCount || 0),
                    total_tokens: Number(usageMeta.totalTokenCount || 0),
                },
            };
        }
        lastFailure = result;
        const isLast = mi === modelList.length - 1;
        if (isLast) break;
        // Log de rotación: qué modelo se agotó y a cuál pasamos.
        const reason = result.quotaExhausted
            ? `cuota diaria agotada (status ${result.status})`
            : `error definitivo (${result.reason})`;
        console.info(`gemini-audio [${model}] → fallback a [${modelList[mi + 1]}]: ${reason}`);
    }

    // Todos los modelos fallaron.
    console.warn('gemini-audio: todos los modelos fallaron. Último error:',
        lastFailure?.reason || 'desconocido', 'status=', lastFailure?.status);
    return null;
}

// Prueba un modelo con reintentos ante transitorios (503/500/timeout). Devuelve:
//   { ok: true, data }                                           → respuesta OK, caller la valida
//   { ok: false, quotaExhausted: true, status, reason }          → cuota agotada, saltar modelo
//   { ok: false, quotaExhausted: false, status?, reason }        → error irrecuperable
async function _tryModel(model, body, timeoutMs, backoff, maxAttempts) {
    const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);
    let response;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            response = await withTimeout(
                db.functions.invoke('gemini-proxy', { body }),
                timeoutMs,
            );
        } catch (e) {
            const msg = e?.message || String(e);
            if (attempt < maxAttempts) {
                console.info(`gemini-audio [${model}] invoke falló (intento ${attempt}/${maxAttempts}), reintento en ${backoff}ms:`, msg);
                if (backoff > 0) await new Promise(r => setTimeout(r, backoff));
                continue;
            }
            // Timeout o network — tratarlo como transitorio del modelo. Si
            // hay otro modelo disponible, el caller lo prueba (por si el
            // modelo específico está lento).
            return { ok: false, quotaExhausted: false, reason: msg };
        }
        // Guard: si la invoke resuelve con undefined (caso teórico, ej. mock
        // sin respuesta configurada), tratarlo como error de transporte.
        if (!response) {
            if (attempt < maxAttempts) continue;
            return { ok: false, quotaExhausted: false, reason: 'empty_response' };
        }
        const status = response?.data?.status;
        const bodyStr = _stringifyBody(response?.data?.body);

        // 429/403 con quota → modelo agotado, no reintentar acá, avisar al caller.
        if ((status === 429 || status === 403) && _isQuotaError(bodyStr)) {
            return { ok: false, quotaExhausted: true, status, reason: 'quota_exhausted' };
        }
        // 429 sin quota → rate limit temporal por segundo. Tratarlo como
        // transitorio del modelo: reintentar dentro del cupo, y si sigue
        // fallando saltar al siguiente modelo por si otro tiene RPM libre.
        if (status === 429 || TRANSIENT_STATUSES.has(status)) {
            if (attempt < maxAttempts) {
                console.info(`gemini-audio [${model}] transitorio ${status} (intento ${attempt}/${maxAttempts}), reintento en ${backoff}ms`);
                if (backoff > 0) await new Promise(r => setTimeout(r, backoff));
                continue;
            }
            return { ok: false, quotaExhausted: false, status, reason: `transient_${status}` };
        }
        // Error 4xx no rate: request malformado, key inválida, modelo no
        // disponible en tu proyecto. Reintentar el mismo modelo no ayuda,
        // pero probar OTRO modelo puede sortear el "modelo no accesible".
        if (typeof status === 'number' && status >= 400) {
            console.warn(`gemini-audio [${model}] status ${status} body=`, response?.data?.body);
            return { ok: false, quotaExhausted: false, status, reason: `status_${status}` };
        }
        // Error de transporte con data null (edge function down).
        if (response?.error) {
            const msg = response.error?.message || String(response.error);
            if (attempt < maxAttempts) {
                console.info(`gemini-audio [${model}] transport error (intento ${attempt}), reintento en ${backoff}ms:`, msg);
                if (backoff > 0) await new Promise(r => setTimeout(r, backoff));
                continue;
            }
            return { ok: false, quotaExhausted: false, reason: `transport: ${msg}` };
        }
        // OK
        return { ok: true, data: response.data };
    }
    return { ok: false, quotaExhausted: false, reason: 'max_attempts_reached' };
}

function _stringifyBody(body) {
    if (typeof body === 'string') return body;
    if (!body) return '';
    try { return JSON.stringify(body); } catch { return String(body); }
}

// Detecta si un error 429/403 viene por cuota diaria agotada (vs rate por
// segundo). Google usa "RESOURCE_EXHAUSTED" y menciona "quota" en el body
// cuando es cuota, y errores más genéricos cuando es RPM temporal.
function _isQuotaError(bodyStr) {
    if (!bodyStr) return false;
    const s = bodyStr.toLowerCase();
    return s.includes('resource_exhausted')
        || s.includes('quota exceeded')
        || s.includes('quota exhausted')
        || s.includes('exceeded your current quota')
        || s.includes('daily limit');
}
