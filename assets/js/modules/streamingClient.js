// streamingClient.js — cliente para consumir SSE de los proxies de IA
// (groq-proxy, gemini-proxy, openrouter-proxy) cuando piden `stream: true`.
//
// Por qué no `db.functions.invoke()`: supabase-js espera JSON completo,
// bufferea todo y NO expone el body como ReadableStream. Para streaming
// hacemos fetch() directo contra la URL del edge function y agarramos el
// JWT del cliente vía `db.auth.getSession()`.
//
// Formatos SSE que parseamos:
//   OpenAI-compat (Groq, OpenRouter):
//     data: {"choices":[{"delta":{"content":"hola"}}]}
//     data: [DONE]
//   Gemini (:streamGenerateContent?alt=sse):
//     data: {"candidates":[{"content":{"parts":[{"text":"hola"}]}}]}
//
// Uso:
//   await streamChat({
//     provider: 'groq' | 'gemini' | 'openrouter',
//     body: { prompt, systemPrompt, temperature, maxTokens },
//     onChunk: (delta) => { ... },
//     onDone: (fullText, meta) => { ... },
//     signal: AbortSignal,
//   });
//
// El helper NO tira si el upstream responde JSON error en vez de SSE —
// devuelve `onError({ status, body })` para que el caller decida qué hacer
// (típicamente: caer al método no-stream).

import { db } from './supabase-client.js';

const SUPABASE_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL)
    || 'https://mtejpgwjdhzuqrqfdlud.supabase.co';

const PROVIDER_TO_FUNCTION = {
    groq:       'groq-proxy',
    gemini:     'gemini-proxy',
    openrouter: 'openrouter-proxy',
};

// Extrae el delta de texto de un frame SSE parseado. Cada proveedor tiene
// su shape; devolvemos string vacío si no hay contenido nuevo (los frames
// de "role" o "done" caen acá).
function extractDelta(provider, frame) {
    if (!frame || typeof frame !== 'object') return '';
    if (provider === 'gemini') {
        const parts = frame?.candidates?.[0]?.content?.parts;
        if (!Array.isArray(parts)) return '';
        return parts.map(p => (typeof p?.text === 'string' ? p.text : '')).join('');
    }
    // OpenAI-compat (groq, openrouter)
    const delta = frame?.choices?.[0]?.delta?.content;
    return typeof delta === 'string' ? delta : '';
}

export async function streamChat({
    provider,
    body,
    onChunk,
    onDone,
    onError,
    signal,
} = {}) {
    const edgeFn = PROVIDER_TO_FUNCTION[provider];
    if (!edgeFn) throw new Error(`streamChat: proveedor desconocido "${provider}"`);

    // JWT del usuario para que el edge function autorice.
    const { data: sessionData } = await db.auth.getSession();
    const token = sessionData?.session?.access_token;
    if (!token) throw new Error('streamChat: sin sesión activa');

    const url = `${SUPABASE_URL}/functions/v1/${edgeFn}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ ...body, stream: true }),
        signal,
    });

    // Si el proxy devolvió JSON (error antes de empezar a streamear) en vez
    // de text/event-stream, no hay stream que consumir. Extraemos el error
    // y notificamos al caller.
    const contentType = res.headers.get('Content-Type') || '';
    if (!contentType.includes('text/event-stream')) {
        let bodyParsed = null;
        try { bodyParsed = await res.json(); } catch { /* no JSON tampoco */ }
        const err = { status: res.status, body: bodyParsed };
        if (typeof onError === 'function') onError(err);
        throw new Error(`streamChat: upstream no-stream (status ${res.status})`);
    }

    if (!res.body) {
        throw new Error('streamChat: response sin body');
    }

    const keySlot = res.headers.get('X-Key-Slot');
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    let fullText = '';

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value;
            // Los frames SSE están separados por doble newline.
            let idx;
            while ((idx = buffer.indexOf('\n\n')) !== -1) {
                const frame = buffer.slice(0, idx).trim();
                buffer = buffer.slice(idx + 2);
                if (!frame) continue;
                // Cada frame puede tener múltiples líneas; nos interesa la
                // que empieza con "data:".
                for (const line of frame.split('\n')) {
                    if (!line.startsWith('data:')) continue;
                    const payload = line.slice(5).trim();
                    if (!payload || payload === '[DONE]') continue;
                    let parsed;
                    try { parsed = JSON.parse(payload); }
                    catch { continue; }   // frame no-JSON — ignoramos
                    const delta = extractDelta(provider, parsed);
                    if (delta) {
                        fullText += delta;
                        if (typeof onChunk === 'function') onChunk(delta, fullText);
                    }
                }
            }
        }
    } finally {
        try { reader.releaseLock(); } catch { /* noop */ }
    }

    if (typeof onDone === 'function') {
        onDone(fullText, { keySlot: keySlot ? Number(keySlot) : null });
    }
    return { fullText, keySlot: keySlot ? Number(keySlot) : null };
}
