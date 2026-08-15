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
//   { observations: {...}, usage: { segments_sent, audio_seconds_sent,
//                                   input_tokens, output_tokens, total_tokens } }
// o null si no hay nada que aportar o el proxy no respondió bien.
// Nunca tira: siempre resuelve.
export async function analyzeAudioClips(clips, metadata = {}, config = {}) {
    const cfg = { ...GEMINI_AUDIO_CONFIG, ...config };
    if (!Array.isArray(clips) || clips.length === 0) return null;

    const parts = buildParts(metadata, clips);
    const totalSeconds = clips.reduce((s, c) => s + (Number(c.seconds) || 0), 0);

    const body = {
        mode: 'audio',
        systemPrompt: AUDIO_SYSTEM_PROMPT,
        parts,
        model: cfg.modelName,
        temperature: cfg.temperature,
        maxOutputTokens: cfg.maxOutputTokens,
        responseFormat: 'json_object',
    };

    // Retry silencioso ante 503/429 (transitorios). Un reintento con 1.5s de
    // backoff cubre la mayoría de los picos temporales de Gemini ("This model
    // is currently experiencing high demand"). Errores 4xx que no sean 429
    // no se reintentan — son problemas del request, reintentar no ayuda.
    const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
    const invokeOnce = () => withTimeout(
        db.functions.invoke('gemini-proxy', { body }),
        cfg.timeoutMs,
    );

    const maxAttempts = 1 + Math.max(0, Number(cfg.retryAttempts) || 0);
    const backoff = Math.max(0, Number(cfg.retryBackoffMs) || 0);
    let response;
    let attempt = 0;
    while (attempt < maxAttempts) {
        attempt++;
        try {
            response = await invokeOnce();
        } catch (e) {
            if (attempt < maxAttempts) {
                console.info(`gemini-audio invoke falló (intento ${attempt}), reintento en ${backoff}ms:`, e?.message || e);
                if (backoff > 0) await new Promise(r => setTimeout(r, backoff));
                continue;
            }
            console.warn('gemini-audio invoke falló definitivo:', e?.message || e);
            return null;
        }
        const status = response?.data?.status;
        if (typeof status === 'number' && TRANSIENT_STATUSES.has(status) && attempt < maxAttempts) {
            console.info(`gemini-audio transitorio ${status} (intento ${attempt}), reintento en ${backoff}ms`);
            if (backoff > 0) await new Promise(r => setTimeout(r, backoff));
            continue;
        }
        break;
    }

    const { data, error } = response || {};
    if (error) {
        console.warn('gemini-audio error transporte:', error?.message || error);
        return null;
    }
    if (!data || typeof data.status !== 'number' || data.status >= 400) {
        // Log el body completo — el `.error` a veces viene vacío mientras el
        // resto del body tiene el mensaje real de Google (ej: "Publisher Model
        // ... was not found or your project does not have access to it").
        console.warn('gemini-audio bad status:', data?.status, 'body=', data?.body);
        return null;
    }

    const candidate = data.body?.candidates?.[0];
    const text = String(candidate?.content?.parts?.[0]?.text || '').trim();
    const finishReason = String(candidate?.finishReason || 'unknown');
    const parsed = parseJsonRelaxed(text);
    const validated = validateAuditoryPayload(parsed, clips);
    if (!validated) {
        // Log detallado para poder distinguir los tres modos de falla:
        //   MAX_TOKENS  → subir maxOutputTokens (respuesta se cortó mid-string)
        //   STOP + parsed=null → JSON con schema equivocado o control chars
        //   STOP + parsed={} vacío → observación pobre pero legítima
        const hint = finishReason === 'MAX_TOKENS'
            ? ' — RESPUESTA TRUNCADA (subir maxOutputTokens)'
            : parsed === null
                ? ' — no parseó, posible JSON malformado'
                : ' — parseó pero validación descartó (schema o arrays vacíos)';
        console.warn('gemini-audio respuesta inválida o vacía' + hint,
            'finishReason=', finishReason,
            'rawTextSnippet=', text.slice(0, 400),
            'parsedKeys=', parsed && typeof parsed === 'object' ? Object.keys(parsed) : null,
        );
        return null;
    }

    const usageMeta = data.body?.usageMetadata || {};
    return {
        observations: validated,
        usage: {
            segments_sent: clips.length,
            audio_seconds_sent: Number(totalSeconds.toFixed(2)),
            input_tokens: Number(usageMeta.promptTokenCount || 0),
            output_tokens: Number(usageMeta.candidatesTokenCount || 0),
            total_tokens: Number(usageMeta.totalTokenCount || 0),
        },
    };
}
