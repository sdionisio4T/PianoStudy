import { db } from './supabase-client.js';
import { deriveFeatures, handRoleZones } from './AudioFeatures.js';
import { parseLlmJson } from '../utils/jsonRepair.js';
import { getRelevantMusicalTerms } from '../data/musicalTerms.js';

export class AIAnalysisEngine {
    // NOTA (Fase 0 seguridad): esta clase ya no recibe ni usa una API key del
    // cliente. Las llamadas pasan por edge functions ('groq-proxy',
    // 'gemini-proxy'), que leen la key desde Deno.env y validan el JWT del
    // usuario autenticado.
    //
    // Estrategia de proveedores (2026-08 — modo A/B):
    //   TEXTO — Groq (default) o Gemini (experimental), elegido por
    //   localStorage['pianoStudy.aiProvider'] = 'groq' | 'gemini'. Cada modo
    //   es explícito: si el proveedor activo falla, vamos directo al fallback
    //   local (sin cruzar al otro), para que el A/B sea limpio.
    //   AUDIO — solo Gemini vía GeminiAudioAnalyzer.js (pipeline separado
    //   que NO usa esta clase).
    //
    // Cuidado: activar modo Gemini para texto CONSUME el mismo cupo diario
    // que la escucha de audio. En sesiones con mucha grabación puede agotarse
    // antes; volver a 'groq' o dejar de activarlo por defecto es la mitigación.

    // Umbral duro de tokens estimados que el prompt (system + user) NO debe
    // exceder al enviarse a Groq. El límite del free tier es ~12000 TPM;
    // dejamos margen para respuestas OK cuando la ventana está a medio
    // saturar. Si el prompt construido pasa este umbral, el guard lo trunca
    // bajando memoria/auditory/vocabulario dinámicamente.
    static PROMPT_TOKEN_SAFE_CEILING = 10500;

    // Estimador rápido de tokens: 3 chars/token en español. Empíricamente
    // los tokenizers de Groq (gpt-oss, llama) y Gemini rinden 3-3.5 chars/token
    // en español rioplatense con acentos y contracciones ("estás", "cómo",
    // "análisis"). El comentario anterior decía "conservador con /4" — no lo
    // era: /4 SUBESTIMA en ~20-25%, así que un guard de 3500 estimados
    // resultaba en 4500-4700 reales, y con Groq free tier bajado a 8K TPM
    // (2026-08) el 413 volvió. Con /3 el guard es realmente conservador y
    // sobreestima ligeramente, que es lo que queremos.
    static _estimateTokens(text) {
        if (!text) return 0;
        return Math.ceil(String(text).length / 3);
    }

    // Status transitorios donde vale la pena reintentar antes de caer al fallback.
    // 429 = rate limit (Groq free tier o proxy), 413 = TPM excedido en Groq
    // compound (llama-4-scout devuelve 413 con "try again in Ns" cuando el
    // Used+Requested pasa el límite TPM aunque el request en sí no sea grande),
    // 503 = high demand (Gemini), 500/502/504 = errores de gateway/upstream.
    // Un 400/401/403 NO se reintenta: son problemas del request o de la key.
    static TRANSIENT_STATUSES = new Set([413, 429, 500, 502, 503, 504]);

    // Backoff diferenciado por status del intento anterior.
    // - 429 / 413: la ventana de rate limit se rellena por MINUTO (tanto en el
    //   proxy —10 req/min por usuario— como en el free tier de Groq —TPM/RPM—).
    //   Se respeta primero el "try again in Ns" que viene en el body del error
    //   (mismo formato para ambos statuses); si no viene o es muy largo (>15s)
    //   directamente NO reintentamos y dejamos que el caller vaya al fallback
    //   cruzado. La tabla queda como red de seguridad sin retry-after.
    // - 5xx: picos transitorios del upstream, típicamente se resuelven en 1-3s.
    // Índice = número de intento (0 = original, sin espera).
    static BACKOFFS_MS_BY_STATUS = {
        413: [0, 5000, 12000],
        429: [0, 5000, 12000],
        default: [0, 1000, 3000],
    };

    // Umbral en ms: si Groq pide esperar MÁS que esto, no reintentamos.
    // Frustra menos al usuario ir directo al fallback + reintentar manualmente
    // que bloquear la UI 30-60s para que probablemente falle igual.
    static RETRY_AFTER_HARD_LIMIT_MS = 15000;

    // Extrae "try again in Ns" del body de error de Groq. Groq no siempre pasa
    // el header retry-after a través del proxy, pero sí incluye el tiempo en
    // el mensaje del error del body cuando es rate limit TPM/RPM. Ej:
    //   "Rate limit reached ... Please try again in 54.9s."
    // Devuelve ms o null si no encuentra el patrón.
    static _extractRetryAfterMs(body) {
        try {
            const raw = typeof body === 'string' ? body : JSON.stringify(body || '');
            // "try again in 54.9s" o "try again in 500ms"
            const m = raw.match(/try again in\s+([\d.]+)\s*(ms|s)/i);
            if (!m) return null;
            const n = parseFloat(m[1]);
            if (!Number.isFinite(n) || n < 0) return null;
            return m[2].toLowerCase() === 'ms' ? Math.round(n) : Math.round(n * 1000);
        } catch { return null; }
    }

    // Helper interno: invoca la edge function con retry por status transitorios.
    // Devuelve el string ya extraído del body o tira el último error.
    //
    // extractText: función que recibe data.body y devuelve el texto (varía por
    // proveedor porque el shape de la respuesta es distinto).
    async _callProviderWithRetry(providerName, edgeFn, prompt, systemPrompt, options, extractText) {
        const body = { prompt, systemPrompt: systemPrompt || undefined };
        if (Number.isFinite(options.temperature)) body.temperature = options.temperature;
        if (options.responseFormat === 'json_object') body.responseFormat = 'json_object';
        // Cap de tokens de respuesta: crítico para el análisis completo — el
        // schema (musicalAnalysis + strengths + 3 observations con 3 capas +
        // primaryFocus + practiceExercise + moments + nextGoal + beliefVsDetection
        // + metacognitiveQuestion) puede pasar el default de cada proxy. Si se
        // corta el JSON, el schema queda incompleto y varias secciones no
        // aparecen en la UI.
        //
        // Los dos proxies usan nombres distintos para el mismo concepto:
        // groq-proxy espera `maxTokens`, gemini-proxy espera `maxOutputTokens`.
        // Mandamos ambos; cada proxy toma el que le corresponde e ignora el otro.
        if (Number.isFinite(options.maxOutputTokens)) {
            const n = Math.floor(options.maxOutputTokens);
            body.maxOutputTokens = n;
            body.maxTokens = n;
        }
        // keySlot: si el caller lo pasa, va al proxy que lo respeta. Sirve
        // para debug/A-B manual — sin él, los proxies alternan las dos keys
        // automáticamente (roundrobin) y hacen fallback a la otra si falla.
        if (options.keySlot === 1 || options.keySlot === 2) {
            body.keySlot = options.keySlot;
        }

        const maxAttempts = 3;                  // 1 original + 2 reintentos
        let lastErr = null;
        // Status del intento anterior. Se usa para elegir la tabla de backoff
        // ANTES del intento actual: si el 1er intento devolvió 429, esperamos
        // como 429; si devolvió 503, esperamos corto.
        let lastStatus = null;

        const waitFor = (attempt) => {
            if (attempt === 0) return 0;
            const table = AIAnalysisEngine.BACKOFFS_MS_BY_STATUS[lastStatus]
                || AIAnalysisEngine.BACKOFFS_MS_BY_STATUS.default;
            return table[attempt] ?? table[table.length - 1];
        };

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const wait = waitFor(attempt);
            if (wait > 0) {
                await new Promise(r => setTimeout(r, wait));
            }
            try {
                const { data, error } = await db.functions.invoke(edgeFn, { body });
                if (error) {
                    lastErr = new Error(`${providerName} error: ${error.message || error}`);
                    // El transporte falló completo (network, edge function down).
                    // Sin status → usamos backoff default corto para el próximo.
                    lastStatus = null;
                    if (attempt < maxAttempts - 1) {
                        console.info(`${providerName} transport error (intento ${attempt + 1}/${maxAttempts}), reintento en ${waitFor(attempt + 1)}ms:`, error.message || error);
                        continue;
                    }
                    throw lastErr;
                }
                const status = data?.status;
                if (typeof status !== 'number' || status >= 400) {
                    lastErr = new Error(`${providerName} error: ${status ?? 'unknown'}`);
                    lastStatus = typeof status === 'number' ? status : null;
                    // Para 429 y 413 (TPM excedido en Groq), respetar el
                    // retry-after que viene en el body. Si Groq pide esperar
                    // más que RETRY_AFTER_HARD_LIMIT_MS, abandonamos: reintentar
                    // cuando la ventana aún no se liberó solo bloquea al usuario
                    // para probablemente fallar igual.
                    if (status === 429 || status === 413) {
                        const retryAfterMs = AIAnalysisEngine._extractRetryAfterMs(data?.body);
                        if (retryAfterMs !== null && retryAfterMs > AIAnalysisEngine.RETRY_AFTER_HARD_LIMIT_MS) {
                            console.warn(`${providerName} pidió esperar ${(retryAfterMs / 1000).toFixed(1)}s (> ${AIAnalysisEngine.RETRY_AFTER_HARD_LIMIT_MS / 1000}s) → abandonar y fallback local`);
                            throw lastErr;
                        }
                        if (retryAfterMs !== null && attempt < maxAttempts - 1) {
                            const wait = Math.min(retryAfterMs + 500, AIAnalysisEngine.RETRY_AFTER_HARD_LIMIT_MS);
                            console.info(`${providerName} 429 con retry-after ${(retryAfterMs / 1000).toFixed(1)}s (intento ${attempt + 1}/${maxAttempts}), esperando ${wait}ms`);
                            await new Promise(r => setTimeout(r, wait));
                            continue;
                        }
                    }
                    // Reintento solo si es transitorio Y todavía nos quedan intentos.
                    if (AIAnalysisEngine.TRANSIENT_STATUSES.has(status) && attempt < maxAttempts - 1) {
                        console.info(`${providerName} transitorio ${status} (intento ${attempt + 1}/${maxAttempts}), reintento en ${waitFor(attempt + 1)}ms`);
                        continue;
                    }
                    throw lastErr;
                }
                // OK — devolver texto extraído.
                return String(extractText(data.body) || '').trim();
            } catch (e) {
                // Puede caer acá por throws internos arriba, o por error inesperado
                // del await. Ya guardamos lastErr; si podemos reintentar, seguimos.
                lastErr = e;
                if (attempt < maxAttempts - 1) continue;
                throw lastErr;
            }
        }
        throw lastErr || new Error(`${providerName} error: sin respuesta`);
    }

    // options: { temperature?: number in [0,1], responseFormat?: 'json_object' }
    async callGroq(prompt, systemPrompt = null, options = {}) {
        return this._callProviderWithRetry(
            'Groq', 'groq-proxy', prompt, systemPrompt, options,
            (body) => body?.choices?.[0]?.message?.content,
        );
    }

    async callGemini(prompt, systemPrompt = null, options = {}) {
        return this._callProviderWithRetry(
            'Gemini', 'gemini-proxy', prompt, systemPrompt, options,
            (body) => body?.candidates?.[0]?.content?.parts?.[0]?.text,
        );
    }

    async callOpenRouter(prompt, systemPrompt = null, options = {}) {
        // OpenRouter usa el schema OpenAI compat (mismo shape que Groq),
        // así que el extractor es idéntico.
        return this._callProviderWithRetry(
            'OpenRouter', 'openrouter-proxy', prompt, systemPrompt, options,
            (body) => body?.choices?.[0]?.message?.content,
        );
    }

    // Ruteo por rol con override opcional desde localStorage — útil para
    // A/B manual en dev sin recompilar:
    //   localStorage['pianoStudy.provider.chat'] = 'openrouter'
    //   localStorage['pianoStudy.provider.analysis'] = 'groq'
    // Valores válidos: 'groq' | 'gemini' | 'openrouter'. Defaults por rol:
    //   - chat (mascota + chat del análisis): SIEMPRE Groq. El chat es la única
    //     superficie donde Groq luce (respuestas cortas, latencia baja, sirve
    //     de sobra dentro de los 8K TPM del free tier con el guard de tamaño).
    //     No cambiar a Gemini/OpenRouter por default — se busca "chat pega
    //     rápido, análisis piensa profundo".
    //   - analysis: Gemini. Groq compound dejó de ser viable en 2026-08 porque
    //     su free tier bajó a 8K TPM y el prompt de análisis pesa ~11K → rebota
    //     con 413. Queda disponible bajo demanda vía el chip de proveedor.
    static _getProvider(role = 'analysis') {
        try {
            const override = typeof localStorage !== 'undefined'
                ? localStorage.getItem(`pianoStudy.provider.${role}`) : null;
            if (override === 'groq' || override === 'gemini' || override === 'openrouter') {
                return override;
            }
        } catch { /* localStorage no disponible (SSR/test) — ignoramos */ }
        if (role === 'chat') return 'groq';
        return 'gemini';
    }

    async callAI(prompt, systemPrompt = null, options = {}, role = 'analysis') {
        const provider = AIAnalysisEngine._getProvider(role);
        if (provider === 'gemini') return await this.callGemini(prompt, systemPrompt, options);
        if (provider === 'openrouter') return await this.callOpenRouter(prompt, systemPrompt, options);
        return await this.callGroq(prompt, systemPrompt, options);
    }

    async analyzePerformance(audioAnalysis, recordingMetadata = {}, studentMemory = null, auditoryObservations = null, reliability = null, selfEvaluation = null) {
        const { systemPrompt, userPrompt } = this.buildAnalysisPrompt(audioAnalysis, recordingMetadata, studentMemory, auditoryObservations, reliability, selfEvaluation);
        // Temperature baja para análisis JSON: reduce variabilidad del score entre corridas.
        // responseFormat json_object: fuerza al modelo a devolver JSON válido a nivel de proveedor.
        // maxOutputTokens 4096: cap alto para que ningún proveedor corte el
        // schema completo a mitad de JSON. _callProviderWithRetry lo mapea a
        // maxTokens (Groq) y maxOutputTokens (Gemini), cada proxy respeta su
        // techo duro (Groq HARD_MAX_TOKENS=4096, Gemini HARD_MAX_TEXT_TOKENS=4096).
        //
        // Trade-off Groq: factura TPM contra el max solicitado, no contra lo
        // usado. Con compound (70K TPM) 4096 sigue dejando 17× de margen por
        // request; con compound-mini era igual. Si volviéramos a un modelo de
        // 8K TPM habría que reducirlo.
        const options = { temperature: 0.4, responseFormat: 'json_object', maxOutputTokens: 4096 };
        let providerUsed = null;
        let rawText = '';
        // Si Gemini "escuchó" y devolvió algo aprovechable, el badge lo marca —
        // sirve para el A/B (Fase 14 del plan) sin romper la UI: los sources
        // nuevos se agregan al mapa de app-audio-flow.js sin quitar los viejos.
        const hasAudioLayer = !!(auditoryObservations
            && (auditoryObservations.auditory_observations?.length
                || auditoryObservations.strengths?.length
                || auditoryObservations.areas_to_explore?.length));
        // Ruteo del análisis: usa el proveedor configurado por el usuario
        // (localStorage/chip → 'gemini' | 'groq' | 'openrouter'). Antes
        // forzábamos Groq para MIDI "porque es texto puro"; se revirtió porque
        // en el free tier de Groq (2026-08) los chat models están capados a
        // 8K TPM y el prompt de análisis pesa ~11K → todo MIDI fallaba con 413
        // sin poder retriar. El fallback cruzado ya cubre el caso "Gemini 503"
        // que era el motivo original del ruteo especial.
        const provider = AIAnalysisEngine._getProvider('analysis');
        // Hasta 3 intentos totales cubriendo también parse/schema inválido:
        // el retry HTTP interno de _callProviderWithRetry ya se ocupa de 429/5xx,
        // pero antes cuando la respuesta era JSON malformado o le faltaba
        // un campo, íbamos directo al fallback aunque un segundo intento
        // podía salir bien. Ahora reintentamos también esos casos.
        const MAX_CONTENT_ATTEMPTS = 3;
        let lastReason = null;
        let lastParsed = null;
        let networkError = null;
        for (let attempt = 0; attempt < MAX_CONTENT_ATTEMPTS; attempt++) {
            try {
                // Ruteo explícito por proveedor — antes el ternario tenía solo
                // dos ramas y openrouter caía silenciosamente a Gemini. El log
                // decía "openrouter no disponible" pero el error venía de Gemini,
                // rompiendo el A/B y confundiendo el debug.
                rawText = provider === 'groq'
                    ? await this.callGroq(userPrompt, systemPrompt, options)
                    : provider === 'openrouter'
                        ? await this.callOpenRouter(userPrompt, systemPrompt, options)
                        : await this.callGemini(userPrompt, systemPrompt, options);
                providerUsed = provider;
                const parsed = this.parseAIResponse(rawText);
                const validation = this.validateAnalysisSchema(parsed);
                if (validation.ok) {
                    const baseSource = `ai-${provider}`;
                    validation.value.source = hasAudioLayer ? `${baseSource}+audio` : baseSource;
                    return validation.value;
                }
                lastReason = validation.reason;
                lastParsed = parsed;
                console.warn(`AI response invalid (intento ${attempt + 1}/${MAX_CONTENT_ATTEMPTS}):`, validation.reason, '\nRaw:', rawText.slice(0, 500));
                // Early exit: si el modelo devuelve texto plano (parseAIResponse
                // devolvió no-objeto — típicamente chain-of-thought o markdown),
                // reintentar NO va a mejorar: el modelo elige no respetar JSON
                // mode. Cortar acá evita 30s de espera inútil para caer al
                // fallback igual. Si vino un objeto malformado (falta un campo),
                // el reintento SÍ puede rescatarlo, así que solo cortamos cuando
                // el parse mismo falló.
                if (validation.reason === 'not-an-object') {
                    console.warn(`${provider}: chain-of-thought en vez de JSON — no reintento, el modelo no respeta JSON mode`);
                    break;
                }
            } catch (error) {
                networkError = error;
                console.error(`${provider} no disponible (intento ${attempt + 1}/${MAX_CONTENT_ATTEMPTS}):`, error);
                break; // el retry HTTP ya se hizo dentro; no reintentar acá.
            }
        }
        // Sin fallback cruzado: el pianista elige explícitamente el proveedor
        // con el chip "Motor de IA" y esperamos que respete su elección
        // (importante para A/B de calidad — cambiar el modelo por atrás
        // enmascara qué proveedor funciona bien). Si el elegido falla, cae al
        // fallback local (heurístico) y el badge del panel lo muestra como
        // "fallback-network"/"fallback-schema-invalid" para que veas qué pasó.
        const fallback = this.getFallbackAnalysis(audioAnalysis);
        if (networkError) {
            fallback.source = 'fallback-network';
        } else {
            fallback.source = lastParsed ? 'fallback-schema-invalid' : 'fallback-parse-error';
        }
        return fallback;
    }

    // Fase B3 del reposicionamiento SRL — delimitador de objetivos vagos.
    // Cuando el usuario escribe algo como "mejorar mi fraseo bebop", esta
    // función pide a Groq/Gemini 3-4 preguntas cortas que lo ayuden a delimitar
    // qué tune / tempo / mano / aspecto quiere trabajar antes de grabar.
    //
    // Devuelve array de strings (2-4 preguntas). Si el proveedor falla, devuelve
    // [] — la UI simplemente no muestra chips y el usuario sigue con su objetivo
    // original sin bloqueo.
    async delimitObjective(objective, contextHint = {}) {
        const obj = String(objective || '').trim();
        if (!obj) return [];

        const styleHint = String(contextHint.style || '').trim();
        const levelHint = String(contextHint.level || '').trim();

        const systemPrompt = `Sos un profesor de piano de jazz. Tu tarea única es ayudar al pianista a delimitar un objetivo vago antes de que grabe.
Devolvés SOLO un objeto JSON con la forma: { "questions": ["...", "...", "...", "..."] }
Reglas:
- Entre 3 y 4 preguntas, cortas (máx 90 chars c/u), específicas, en voseo rioplatense.
- Cada una debe apuntar a UN eje concreto: qué pieza/lick, qué tempo/BPM, qué mano, qué aspecto específico (timing/dinámica/voicing/articulación), qué compás/sección.
- No repetir preguntas equivalentes. No preguntar cosas obvias ("¿qué querés mejorar?"). No motivacionales.
- Si el objetivo ya es específico (menciona BPM, compás, tune, mano concreta), devolvé preguntas de MAYOR precisión, no de delimitación básica.
- Prohibido: preguntar por estilo si ya vino en el contexto; preguntar por nivel si ya vino.
- Responde ÚNICAMENTE el JSON, sin fences ni texto extra.`;

        const contextLines = [];
        if (styleHint) contextLines.push(`Estilo declarado: ${styleHint}`);
        if (levelHint) contextLines.push(`Nivel declarado: ${levelHint}`);
        const contextBlock = contextLines.length ? `CONTEXTO:\n${contextLines.join('\n')}\n\n` : '';

        const userPrompt = `${contextBlock}OBJETIVO A DELIMITAR:\n"${obj.slice(0, 300)}"\n\nDevolvé el JSON con las 3-4 preguntas.`;

        try {
            const raw = await this.callAI(userPrompt, systemPrompt, { temperature: 0.5, responseFormat: 'json_object' });
            const parsed = this.parseAIResponse(raw);
            const questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
            return questions
                .filter(q => typeof q === 'string' && q.trim())
                .map(q => q.trim().slice(0, 120))
                .slice(0, 4);
        } catch (err) {
            console.warn('delimitObjective: proveedores no disponibles, salteando:', err?.message || err);
            return [];
        }
    }

    // ctx (opcional): { metadata, reliability, studentMemory }.
    //   metadata: estilo/nivel/objetivo/notas declarados por el pianista.
    //   reliability: salida de assessAnalysis — el chat aplica el mismo hedge
    //     que el análisis (no afirmar tonalidad si key.reliability es low, etc.).
    //   studentMemory: salida de buildStudentMemory — para dar continuidad con
    //     sesiones previas ("como te vengo comentando desde hace 3 sesiones...").
    async answerQuestion(audioAnalysis, aiAnalysis, question, chatHistory = [], focusRegion = null, ctx = {}) {
        const q = String(question || '').trim();
        if (!q) return 'Escribí una pregunta para poder ayudarte.';

        const { systemPrompt, userPrompt } = this.buildQuestionPrompt(audioAnalysis, aiAnalysis, q, chatHistory, focusRegion, ctx);
        // Cap de respuesta: 500 tokens = 2-4 párrafos cortos, suficiente para
        // el formato pedido en el systemPrompt. Antes era 800 pero Groq factura
        // el max contra TPM aunque el modelo no lo use → con 8K TPM en free
        // tier (2026-08) sumaba innecesariamente al total. Si un chat pide más,
        // el pianista puede pedirlo con "explayate más" (nueva request, otro
        // minuto de ventana TPM).
        const options = { temperature: 0.6, maxOutputTokens: 500 };
        // Sin fallback cruzado: si el pianista eligió Groq (o cualquier otro
        // via chip), respetamos su elección. Cambiar de proveedor por atrás
        // enmascara el problema real y arruina el A/B. Si falla, mostramos
        // fallback heurístico y logueamos el error para debug.
        const provider = AIAnalysisEngine._getProvider('chat');
        try {
            const text = provider === 'gemini'
                ? await this.callGemini(userPrompt, systemPrompt, options)
                : provider === 'openrouter'
                    ? await this.callOpenRouter(userPrompt, systemPrompt, options)
                    : await this.callGroq(userPrompt, systemPrompt, options);
            if (text) return text;
            console.warn(`Chat ${provider}: respuesta vacía`);
        } catch (err) {
            console.error(`Chat ${provider} falló:`, err?.message || err);
        }
        return this.getFallbackAnswer(audioAnalysis, aiAnalysis, q, true);
    }

    // Valida que el objeto parseado tenga la forma esperada por displayAnalysisResults.
    // Devuelve { ok: true, value } o { ok: false, reason }. No modifica el input;
    // devuelve una copia normalizada con defaults seguros.
    validateAnalysisSchema(parsed) {
        if (!parsed || typeof parsed !== 'object') {
            return { ok: false, reason: 'not-an-object' };
        }
        const score = Number(parsed.overallScore);
        if (!Number.isFinite(score) || score < 1 || score > 10) {
            return { ok: false, reason: `overallScore invalid: ${parsed.overallScore}` };
        }
        const musicalAnalysis = typeof parsed.musicalAnalysis === 'string' ? parsed.musicalAnalysis.trim() : '';
        if (!musicalAnalysis) {
            return { ok: false, reason: 'musicalAnalysis missing or empty' };
        }
        // Warning (no bloqueo): el prompt pide 2-3 párrafos separados por \n\n.
        // Log solo para vigilancia — el renderer tolera cualquier cantidad;
        // endurecer el schema rompería casos válidos.
        const paragraphCount = musicalAnalysis.split(/\n{2,}/).map(p => p.trim()).filter(Boolean).length;
        if (paragraphCount < 2 || paragraphCount > 3) {
            console.warn(`[AIAnalysis] musicalAnalysis vino con ${paragraphCount} párrafo(s), esperados 2-3. Modelo ignoró la cuota.`);
        }
        // Warning si contiene "densidad" u otra jerga que el prompt prohíbe.
        // El feedback pierde valor pedagógico cuando estos patrones aparecen.
        const jergaPatterns = /\b(densidad|actividad muy alta|muchas notas|concentración de eventos|gran cantidad de notas)\b/i;
        if (jergaPatterns.test(musicalAnalysis)) {
            console.warn('[AIAnalysis] musicalAnalysis usa "densidad" u otra palabra prohibida por REGLA 2/6. Prompt ignorado.');
        }
        const exercise = parsed.practiceExercise && typeof parsed.practiceExercise === 'object'
            ? parsed.practiceExercise : {};
        const exerciseTitle = typeof exercise.title === 'string' ? exercise.title.trim() : '';
        const exerciseDesc = typeof exercise.description === 'string' ? exercise.description.trim() : '';
        // Nuevo schema (2026-08): steps[] + checkQuestion. Compat total con
        // description prosa histórica — si vienen steps válidos, ellos priman;
        // si no, description sigue siendo válida. Necesita título Y alguno de
        // los dos formatos (nuevo o viejo).
        const exerciseStepsSrc = Array.isArray(exercise.steps) ? exercise.steps : [];
        const exerciseSteps = exerciseStepsSrc
            .map(s => typeof s === 'string' ? s.trim() : '')
            .filter(Boolean)
            .slice(0, 4);
        const exerciseCheck = typeof exercise.checkQuestion === 'string' ? exercise.checkQuestion.trim() : '';
        const hasNewFormat = exerciseSteps.length >= 2;   // 2-4 steps requerido en el nuevo formato
        if (!exerciseTitle || (!hasNewFormat && !exerciseDesc)) {
            return { ok: false, reason: 'practiceExercise missing title and either steps[] or description' };
        }
        const durationMin = Number(exercise.durationMin);
        const momentsSrc = Array.isArray(parsed.moments) ? parsed.moments : [];
        const moments = momentsSrc
            .filter(m => m && typeof m === 'object')
            .map(m => ({
                timeStart: Number(m.timeStart) || 0,
                timeEnd: Number(m.timeEnd) || 0,
                kind: ['good', 'improve', 'neutral'].includes(m.kind) ? m.kind : 'neutral',
                note: typeof m.note === 'string' ? m.note.slice(0, 160) : '',
            }))
            .filter(m => m.note);
        const nextGoal = typeof parsed.nextGoal === 'string' ? parsed.nextGoal.trim() : '';

        // observations: opcional, cap 3 (era 4 antes de REGLA 8 — reducir).
        // Cada obs necesita las tres capas completas para ser aceptada (REGLA 7).
        const observationsSrc = Array.isArray(parsed.observations) ? parsed.observations : [];
        const validConfidences = new Set(['high', 'medium', 'low']);
        const observations = observationsSrc
            .filter(o => o && typeof o === 'object')
            .map(o => ({
                fact: typeof o.fact === 'string' ? o.fact.trim() : '',
                interpretation: typeof o.interpretation === 'string' ? o.interpretation.trim() : '',
                recommendation: typeof o.recommendation === 'string' ? o.recommendation.trim() : '',
                confidence: validConfidences.has(o.confidence) ? o.confidence : 'medium',
            }))
            .filter(o => o.fact && o.interpretation && o.recommendation)
            .slice(0, 3);

        // strengths: opcional (soft-required inicialmente), cap 2, sin duplicados.
        const strengthsSrc = Array.isArray(parsed.strengths) ? parsed.strengths : [];
        const strengths = strengthsSrc
            .map(s => typeof s === 'string' ? s.trim() : '')
            .filter(Boolean)
            .filter((s, i, arr) => arr.indexOf(s) === i)   // dedup exacto
            .slice(0, 2);

        // primaryFocus: opcional (soft-required inicialmente). El pianista lo
        // ve como "🎯 Tu principal foco" — si el modelo no lo devuelve, la UI
        // simplemente oculta la sección. NO endurecemos por ahora.
        const primaryFocus = typeof parsed.primaryFocus === 'string' ? parsed.primaryFocus.trim() : '';

        // beliefVsDetection (Fase A): opcional, solo llega si vino AUTOEVALUACIÓN.
        // Cap a 400 chars para evitar que el modelo lo use como segundo análisis.
        const beliefRaw = typeof parsed.beliefVsDetection === 'string' ? parsed.beliefVsDetection.trim() : '';
        const beliefVsDetection = beliefRaw.slice(0, 400);

        // metacognitiveQuestion (Fase A): opcional. Cap 200 chars por seguridad
        // aunque REGLA 11 pida 120 — dejamos margen para el modelo.
        const mqRaw = typeof parsed.metacognitiveQuestion === 'string' ? parsed.metacognitiveQuestion.trim() : '';
        const metacognitiveQuestion = mqRaw.slice(0, 200);

        return {
            ok: true,
            value: {
                overallScore: Math.round(score),
                musicalAnalysis,
                strengths,
                primaryFocus: primaryFocus || null,
                practiceExercise: {
                    title: exerciseTitle,
                    // Nuevo formato: steps + checkQuestion. Compat: description.
                    // Ambos coexisten en la respuesta validada — el renderer
                    // prefiere steps si están, cae a description si no.
                    steps: exerciseSteps,
                    checkQuestion: exerciseCheck || null,
                    description: exerciseDesc,
                    durationMin: Number.isFinite(durationMin) && durationMin > 0
                        ? Math.min(60, Math.round(durationMin))
                        : null,
                },
                moments,
                observations,
                nextGoal: nextGoal || null,
                beliefVsDetection: beliefVsDetection || null,
                metacognitiveQuestion: metacognitiveQuestion || null,
            },
        };
    }

    // Guía específica por estilo — se inyecta en el prompt cuando el usuario
    // declaró un estilo (metadata.style, mismos valores que el selector de
    // licks en la UI: blues, bebop, hardbop, latinjazz, soncubano, bolero,
    // jazzcolombiano). Mejora la especificidad del análisis mucho más que
    // una lista genérica de referentes — le da al modelo criterios concretos
    // de qué escuchar según el estilo real de la grabación.
    static STYLE_GUIDANCE = {
        soncubano: `ENFOQUE — Son cubano: el groove nace del patrón de clave (3-2 o 2-3) y el montuno en la mano derecha con acentos sincopados sobre el tumbao. Evalúa si el fraseo "cae" naturalmente en la clave (no contra ella) y si el montuno mantiene independencia rítmica clara entre las manos. Referentes: Rubén González, Bebo Valdés, Chucho Valdés, Irakere.`,
        bebop: `ENFOQUE — Bebop: prioriza precisión en escalas bebop (con nota cromática de paso para que los tiempos fuertes caigan en notas del acorde), progresiones ii-V-I encadenadas, sustitución de tritono y encierres cromáticos (enclosures) alrededor de las notas objetivo. Evalúa articulación característica (staccato ligero, acentos en contratiempo), swing feel y fluidez en cambios de acorde rápidos. Referentes: Bud Powell, Thelonious Monk, McCoy Tyner, Charlie Parker (fraseo, aunque sea saxofonista).`,
        hardbop: `ENFOQUE — Hard bop: bebop con influencia directa de gospel y blues, grooves más terrenales. Evalúa uso de blue notes, licks de blues integrados en frases bebop, y energía rítmica funky en el comping de la mano izquierda. Referentes: Horace Silver, Art Blakey, Lee Morgan.`,
        latinjazz: `ENFOQUE — Latin jazz: fusión de armonía de jazz (voicings extendidos con tensiones 9/11/13, reharmonización) con ritmos afrocubanos (clave, tumbao, montuno). Evalúa si el pianista balancea la complejidad armónica del jazz con el groove rítmico latino sin perder ninguno de los dos — es el error más común en este estilo (o suena "muy jazz, poco latino" o al revés). Referentes: Gonzalo Rubalcaba, Michel Camilo, Chucho Valdés.`,
        jazzcolombiano: `ENFOQUE — Jazz colombiano: fusión de ritmos tradicionales colombianos (bambuco y currulao en compases de 6/8 o 3/4, cumbia, porro) con armonía e improvisación de jazz. Evalúa si hay coherencia entre el fraseo melódico jazzístico y las células rítmicas tradicionales (por ejemplo, acentos de bambuco bien ubicados dentro del compás, no forzados). Este es un estilo con poca cobertura pedagógica fuera de Colombia — sé especialmente concreto acá. Referentes: Edy Martínez, Antonio Arnedo, Alejandro Rivas.`,
        bolero: `ENFOQUE — Bolero: prioriza fraseo rubato, expresividad melódica y voicings románticos (acordes con novena y sexta añadida, movimiento de voces suave). Evalúa control dinámico fino y la capacidad de "cantar" la melodía al piano más que la precisión rítmica estricta. Referentes: Ernesto Lecuona, Armando Manzanero, Consuelo Velázquez.`,
        blues: `ENFOQUE — Blues: evalúa uso de la escala blues, frases de llamada-respuesta (call and response), inflexiones expresivas (bends emulados con grace notes o appoggiaturas) y el feel característico "atrasado" respecto al tiempo. Referentes: Oscar Peterson, Bill Evans, Herbie Hancock.`
    };

    // Construye una memoria compacta del estudiante a partir de sus análisis
    // previos, para dar CONTINUIDAD entre sesiones. Se pasa al prompt como
    // "CONTEXTO DEL ESTUDIANTE" para que la IA hable como profesor que se
    // acuerda de vos entre clases, no como si te viera por primera vez.
    //
    // Estrategia: pura agregación client-side desde analysisHistory (que ya
    // vive en localStorage por usuario). Sin llamadas extra a la IA, sin DB.
    //
    // opts.rejections (Fase B2): lista de observations que el usuario marcó
    // como "no aplica". Se incluye en la memoria para que el prompt las evite
    // en las próximas grabaciones.
    static buildStudentMemory(analysisHistory, opts = {}) {
        // Default bajado de 8 → 5 sesiones para achicar el bloque de memoria
        // en el prompt (~150 tokens ahorrados en escenario típico). El caller
        // puede pasar un valor mayor si lo necesita explícitamente.
        const maxEntries = Number(opts.maxEntries || 5);
        const list = Array.isArray(analysisHistory) ? analysisHistory : [];
        if (list.length === 0) return null;

        // Los análisis pueden venir en cualquier orden — ordenamos por timestamp desc.
        const sorted = [...list]
            .filter(a => a && typeof a === 'object')
            .sort((a, b) => (Number(b?.timestamp) || 0) - (Number(a?.timestamp) || 0))
            .slice(0, maxEntries);

        // Score promedio y tendencia (últimos 3 vs anteriores).
        const scores = sorted
            .map(a => Number(a?.aiAnalysis?.overallScore))
            .filter(Number.isFinite);
        const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
        const trend = (() => {
            if (scores.length < 4) return 'sin tendencia suficiente';
            const recent = scores.slice(0, 3);
            const older = scores.slice(3);
            const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
            const avgOlder = older.reduce((a, b) => a + b, 0) / older.length;
            const delta = avgRecent - avgOlder;
            if (delta > 0.5) return `mejorando (${avgOlder.toFixed(1)} → ${avgRecent.toFixed(1)})`;
            if (delta < -0.5) return `bajando (${avgOlder.toFixed(1)} → ${avgRecent.toFixed(1)})`;
            return 'estable';
        })();

        // "Improve moments" recurrentes: agarramos las últimas notas de tipo improve
        // de todos los análisis previos. La IA leerá esto y evitará repetir la misma
        // observación en cada sesión.
        const recentImprove = [];
        for (const a of sorted) {
            const moments = Array.isArray(a?.aiAnalysis?.moments) ? a.aiAnalysis.moments : [];
            for (const m of moments) {
                if (m?.kind === 'improve' && typeof m?.note === 'string' && m.note.trim()) {
                    recentImprove.push(m.note.trim());
                }
                if (recentImprove.length >= 6) break;
            }
            if (recentImprove.length >= 6) break;
        }

        // Ejercicios recomendados en sesiones previas (para dar continuidad y evitar repetir).
        const recentExercises = sorted
            .map(a => {
                const ex = a?.aiAnalysis?.practiceExercise?.title
                    || (Array.isArray(a?.aiAnalysis?.practiceSuggestions) ? a.aiAnalysis.practiceSuggestions[0]?.title : null);
                return typeof ex === 'string' && ex.trim() ? ex.trim() : null;
            })
            .filter(Boolean)
            .slice(0, 4);

        // Estilos declarados o inferidos que ha practicado.
        const styles = new Set();
        for (const a of sorted) {
            const declared = a?.metadata?.style;
            if (typeof declared === 'string' && declared.trim()) styles.add(declared.trim().toLowerCase());
        }

        // Rango de fechas y frecuencia.
        const latestTs = Number(sorted[0]?.timestamp);
        const oldestTs = Number(sorted[sorted.length - 1]?.timestamp);
        const daysSpan = (Number.isFinite(latestTs) && Number.isFinite(oldestTs))
            ? Math.max(1, Math.round((latestTs - oldestTs) / (1000 * 60 * 60 * 24)))
            : null;

        // Log de calibración (Fase B1 SRL): mide cuánto acierta la autoevaluación
        // del pianista contra lo que detectó el sistema, sesión a sesión. Es la
        // señal de si su oído está mejorando con el uso de la app. Solo cuenta
        // sesiones donde vino selfEvaluation — las que se saltaron no aportan.
        const calibrationHistory = sorted
            .filter(a => a?.selfEvaluation && typeof a.selfEvaluation === 'object')
            .map(a => AIAnalysisEngine._computeCalibrationEntry(a))
            .filter(Boolean);

        // Rejections del usuario (Fase B2). Vienen desde opts porque viven en
        // otro key de localStorage — lo maneja el caller (app-audio-flow.js).
        // Filtramos entradas malformadas; cap 12 más recientes al prompt para
        // no inflar el contexto (el storage ya guarda hasta 40).
        const rejectionsSrc = Array.isArray(opts.rejections) ? opts.rejections : [];
        // Cap bajado 12 → 6: cada rejection son ~30 tokens en el prompt; 12
        // llegaban a ~360 tokens sin agregar mucho valor (los más recientes
        // suelen ser suficientes para que el modelo evite repetir).
        const rejections = rejectionsSrc
            .filter(r => r && typeof r === 'object' && (r.fact || r.interpretation))
            .slice(0, 6);

        return {
            totalSessions: list.length,
            recentSessions: sorted.length,
            averageScore: avgScore ? Number(avgScore.toFixed(1)) : null,
            scoreTrend: trend,
            recurringImproveNotes: recentImprove.slice(0, 5),
            recentExercises,
            stylesPracticed: [...styles],
            daysSpan,
            lastSessionAgeDays: Number.isFinite(latestTs)
                ? Math.max(0, Math.round((Date.now() - latestTs) / (1000 * 60 * 60 * 24)))
                : null,
            rejections,
            calibrationHistory,
        };
    }

    // Fase B1: mapea una entrada del historial a un registro de calibración
    // (self-eval vs detection). Devuelve null si no hay data suficiente.
    static _computeCalibrationEntry(entry) {
        const self = entry?.selfEvaluation;
        const ai = entry?.aiAnalysis;
        if (!self || !ai) return null;
        const ratingSelf = Number(self.rating);            // 1-5 escala usuario
        const overall = Number(ai.overallScore);           // 1-10 escala AI
        const ratingDetected = Number.isFinite(overall) ? Math.round(overall / 2) : null;

        // Convergencia general de rating: high (diff <=0), partial (1), low (>=2).
        let ratingConvergence = 'unknown';
        if (Number.isFinite(ratingSelf) && Number.isFinite(ratingDetected)) {
            const diff = Math.abs(ratingSelf - ratingDetected);
            ratingConvergence = diff <= 0 ? 'high' : diff === 1 ? 'partial' : 'low';
        }

        // Convergencia del área floja: match textual del weakArea vs palabras
        // clave del primaryFocus. No es ciencia exacta — es una aproximación
        // útil para la gráfica de tendencia.
        const weakSelf = typeof self.weakArea === 'string' ? self.weakArea.toLowerCase() : '';
        const primary = typeof ai.primaryFocus === 'string' ? ai.primaryFocus.toLowerCase() : '';
        const areaKeywords = {
            timing: ['timing', 'tempo', 'pulso', 'rushing', 'dragging', 'swing feel'],
            dinamica: ['dinámica', 'dinamica', 'volumen', 'intensidad', 'acento', 'contraste'],
            notas: ['nota', 'escala', 'digitación', 'armonía', 'voicing', 'acorde', 'error'],
            fraseo: ['fraseo', 'línea', 'articulación', 'legato', 'staccato', 'contorno', 'melodía'],
        };
        let areaConvergence = 'unknown';
        if (weakSelf && primary) {
            const keywords = areaKeywords[weakSelf] || [];
            const matched = keywords.some(k => primary.includes(k));
            areaConvergence = matched ? 'high' : 'low';
        }

        return {
            timestamp: Number(entry.timestamp) || Date.now(),
            ratingSelf: Number.isFinite(ratingSelf) ? ratingSelf : null,
            ratingDetected,
            ratingConvergence,
            weakAreaSelf: weakSelf || null,
            primaryFocus: typeof ai.primaryFocus === 'string' ? ai.primaryFocus.slice(0, 160) : null,
            areaConvergence,
            prediction: typeof self.prediction === 'string' ? self.prediction.slice(0, 200) : null,
        };
    }

    // Fase B1: resumen agregado de la calibración para la vista "Cómo mejora
    // tu oído". Devuelve summary listo para renderizar. Requiere >=2 sesiones
    // con self-eval para tener algo pedagógicamente útil.
    static computeCalibrationSummary(calibrationHistory) {
        const list = Array.isArray(calibrationHistory) ? calibrationHistory : [];
        if (list.length < 2) {
            return { hasData: false, totalSessions: list.length, needsMore: 2 - list.length };
        }
        const sorted = [...list].sort((a, b) => a.timestamp - b.timestamp); // cronológico asc
        const total = sorted.length;
        const highCount = sorted.filter(e => e.ratingConvergence === 'high').length;
        const partialCount = sorted.filter(e => e.ratingConvergence === 'partial').length;
        const areaMatchCount = sorted.filter(e => e.areaConvergence === 'high').length;

        // Tendencia: comparar primera mitad vs segunda mitad.
        const half = Math.floor(sorted.length / 2);
        const older = sorted.slice(0, half);
        const recent = sorted.slice(half);
        const olderHigh = older.filter(e => e.ratingConvergence === 'high').length / Math.max(1, older.length);
        const recentHigh = recent.filter(e => e.ratingConvergence === 'high').length / Math.max(1, recent.length);
        const delta = recentHigh - olderHigh;
        let trend = 'estable';
        if (delta > 0.15) trend = 'mejorando';
        else if (delta < -0.15) trend = 'bajando';

        return {
            hasData: true,
            totalSessions: total,
            highConvergencePct: Math.round((highCount / total) * 100),
            partialConvergencePct: Math.round((partialCount / total) * 100),
            areaMatchPct: Math.round((areaMatchCount / total) * 100),
            trend,
            deltaPct: Math.round(delta * 100),
            recentEntries: sorted.slice(-8),   // últimas 8 para la mini-gráfica
        };
    }

    // Formatea la memoria del estudiante como texto listo para el prompt.
    // Se lee al comienzo del prompt para que la IA "recuerde" al estudiante
    // antes de escribir el análisis nuevo.
    formatStudentMemory(memory) {
        if (!memory || memory.totalSessions === 0) return '';
        const lines = ['CONTEXTO DEL ESTUDIANTE (sesiones previas — usá para dar CONTINUIDAD, no repetir lo mismo cada vez):'];
        lines.push(`- Total de análisis previos: ${memory.totalSessions}${memory.daysSpan ? ` a lo largo de ~${memory.daysSpan} días` : ''}.`);
        if (memory.averageScore != null) {
            lines.push(`- Score promedio (últimos ${memory.recentSessions}): ${memory.averageScore}/10 (tendencia: ${memory.scoreTrend}).`);
        }
        if (memory.lastSessionAgeDays != null) {
            const ago = memory.lastSessionAgeDays === 0
                ? 'hoy mismo'
                : memory.lastSessionAgeDays === 1
                    ? 'ayer'
                    : `hace ${memory.lastSessionAgeDays} días`;
            lines.push(`- Última sesión: ${ago}.`);
        }
        if (memory.stylesPracticed?.length) {
            lines.push(`- Estilos que ha declarado practicar: ${memory.stylesPracticed.join(', ')}.`);
        }
        if (memory.recurringImproveNotes?.length) {
            lines.push('- Observaciones recurrentes a mejorar (de análisis pasados — si volvés a ver algo similar, mencioná que ya lo habías notado; si esta vez no aparece, celebralo):');
            for (const n of memory.recurringImproveNotes) {
                lines.push(`  · "${n}"`);
            }
        }
        if (memory.recentExercises?.length) {
            lines.push('- Ejercicios que le recomendaste antes (no repitas el mismo; construí sobre ellos o cambiá de foco):');
            for (const ex of memory.recentExercises) {
                lines.push(`  · ${ex}`);
            }
        }
        // Rejections del usuario (Fase B2): el pianista marcó explícitamente
        // que ciertas observations no aplican. El modelo DEBE evitar repetirlas
        // ni sacar variantes del mismo tema. Si el usuario dio un motivo, el
        // modelo puede usarlo para entender POR QUÉ no aplicaba y ajustar
        // (por ejemplo si dijo "mi piano tiene el grave apagado", no volver a
        // interpretar la ausencia de graves como decisión musical).
        if (memory.rejections?.length) {
            lines.push('- ⚠️ OBSERVATIONS QUE EL PIANISTA RECHAZÓ EXPLÍCITAMENTE (no las repitas ni saques variantes del mismo tema en este análisis — usá los motivos para entender el contexto real del pianista):');
            for (const r of memory.rejections) {
                const factSnippet = String(r.fact || '').slice(0, 160);
                const reasonSnippet = r.reason ? ` — motivo: "${String(r.reason).slice(0, 140)}"` : '';
                lines.push(`  · "${factSnippet}"${reasonSnippet}`);
            }
        }
        return lines.join('\n');
    }

    // Formatea la CAPA DE CONFIABILIDAD que sale de AnalysisReliability.
    // Se inyecta ARRIBA de los datos objetivos en el userPrompt — regula qué
    // puede afirmar el modelo. Si no viene reliability, no aparece nada y el
    // pipeline anterior queda idéntico (compat total).
    formatReliabilityBlock(reliability) {
        if (!reliability || typeof reliability !== 'object') return '';
        const lines = ['CAPA DE CONFIABILIDAD (leé esto ANTES que los datos — regula qué podés afirmar y qué no):'];

        const t = reliability.tempo;
        if (t) {
            const bpmTxt = t.value ? `${t.value} BPM` : 'no detectado';
            lines.push(`- tempo: reliability=${t.reliability} (${bpmTxt}, confidence ${t.confidence})`);
        }

        const k = reliability.key;
        if (k) {
            const label = k.value ? `${k.value}${k.mode ? ' ' + k.mode : ''}` : 'no determinada';
            const reasonsTxt = (k.reasons_for_hedge?.length)
                ? `; motivos del hedge: ${k.reasons_for_hedge.join(', ')}`
                : '';
            lines.push(`- key: reliability=${k.reliability} (${label}, confidence ${k.confidence}${reasonsTxt})`);
        }

        const tr = reliability.transcription;
        if (tr) {
            const warnTxt = (tr.warnings?.length)
                ? `; warnings: ${tr.warnings.join(' · ')}`
                : '';
            lines.push(`- transcription: level=${tr.level} (available=${tr.available}, score=${tr.score}${warnTxt})`);
        }

        if (reliability.melody) {
            lines.push(`- melody: status=${reliability.melody.status}. ${reliability.melody.note || ''}`.trim());
        }

        if (Array.isArray(reliability.reliable_signals) && reliability.reliable_signals.length) {
            lines.push(`- Señales confiables para esta sesión: ${reliability.reliable_signals.join(', ')}`);
        }
        if (Array.isArray(reliability.unreliable_signals) && reliability.unreliable_signals.length) {
            lines.push(`- Señales inconfiables para esta sesión: ${reliability.unreliable_signals.join(', ')}`);
        }
        if (reliability.overall_data_quality) {
            const guide = reliability.overall_data_quality === 'low'
                ? ' → priorizá MENOS observaciones pero MÁS SÓLIDAS, sostenidas por datos reliable. No sugieras cambiar el equipo de grabación.'
                : reliability.overall_data_quality === 'high'
                    ? ' → todos los datos son consistentes, podés ser específico.'
                    : ' → hay señales mixtas, apoyate en las reliable y hedgeá las otras.';
            lines.push(`- overall_data_quality: ${reliability.overall_data_quality}${guide}`);
        }

        return lines.join('\n');
    }

    // Formatea la capa de percepción auditiva de Gemini (si existe). Se inyecta
    // en el userPrompt como bloque separado del análisis objetivo, con reglas
    // explícitas de cómo combinar ambas fuentes. Si no hay observaciones, no
    // aparece nada — el flujo actual queda idéntico.
    formatAuditoryObservations(auditory) {
        if (!auditory || typeof auditory !== 'object') return '';
        // Caps de qué INYECTAR AL PROMPT (independiente del cap del schema en
        // GeminiAudioAnalyzer, que valida hasta 4). El objetivo acá es ahorrar
        // tokens: las obs más allá de las 3 top rara vez cambian el análisis.
        const obs = (Array.isArray(auditory.auditory_observations) ? auditory.auditory_observations : []).slice(0, 3);
        const strengths = (Array.isArray(auditory.strengths) ? auditory.strengths : []).slice(0, 2);
        const areas = (Array.isArray(auditory.areas_to_explore) ? auditory.areas_to_explore : []).slice(0, 2);
        const uncertainties = (Array.isArray(auditory.uncertainties) ? auditory.uncertainties : []).slice(0, 1);
        if (!obs.length && !strengths.length && !areas.length && !uncertainties.length) return '';

        const lines = ['PERCEPCIÓN AUDITIVA (Gemini escuchó fragmentos específicos de esta grabación — NO son datos objetivos, son observaciones de escucha musical con nivel de confianza):'];
        if (obs.length) {
            lines.push('Observaciones auditivas:');
            for (const o of obs) {
                const t0 = Number(o.timestamp_start ?? 0).toFixed(1);
                const t1 = Number(o.timestamp_end ?? 0).toFixed(1);
                const conf = Number(o.confidence ?? 0).toFixed(2);
                lines.push(`  · [${o.type || 'character'} · conf ${conf}] "${o.observation}" (t=${t0}s→${t1}s)`);
            }
        }
        if (strengths.length) {
            lines.push('Fortalezas percibidas:');
            for (const s of strengths) lines.push(`  · ${s}`);
        }
        if (areas.length) {
            lines.push('Áreas a explorar (según escucha):');
            for (const a of areas) lines.push(`  · ${a}`);
        }
        if (uncertainties.length) {
            lines.push('No se pudo determinar con claridad (según escucha):');
            for (const u of uncertainties) lines.push(`  · ${u}`);
        }
        lines.push('');
        lines.push('COMBINAR OBJETIVO+AUDITIVO: si convergen, integrá en una obs; si divergen, mencioná la discrepancia con lenguaje tentativo (los datos son promedios; la escucha es local). Es complemento — no cites la observación literal, transformala en pedagogía.');
        return lines.join('\n');
    }

    // Formatea el banco de vocabulario musical seleccionado para esta sesión.
    // El selector (assets/js/data/musicalTerms.js) ya filtra por reliability +
    // estilo + evidencia — acá solo lo convertimos a texto compacto para el
    // prompt.
    //
    // Formato pensado para reducir consumo de tokens: NO enviamos aliases,
    // category, relatedTerms, level, pedagogicalUse completo ni allowedWhen.
    // Las reglas GENERALES de uso (usar solo cuando la evidencia respalde,
    // preferir términos sencillos, no usar terminología avanzada para
    // aparentar profundidad) viven en REGLA 12 del systemPrompt — se
    // escriben UNA SOLA VEZ ahí, no se repiten por término.
    //
    // Por término emitimos: "- Término: definición. [regla-dura-opcional]"
    // La regla dura opcional aparece SOLO si:
    //   (a) forbiddenWhen tiene una restricción operativa específica
    //       (empieza con "solo", "sin", "transcription" — no genéricos).
    // Máx ~90 chars la regla, cortada con "…" si excede.
    //
    // Costo estimado por término: ~25-40 tokens (vs ~85 del formato anterior).
    formatMusicalTermsForPrompt(terms) {
        if (!Array.isArray(terms) || terms.length === 0) return '';
        const lines = ['VOCABULARIO MUSICAL DISPONIBLE PARA ESTA SESIÓN (uso regulado por REGLA 12):'];
        for (const t of terms) {
            const defRaw = String(t.definition || '').trim();
            // Recortar la definición si es muy larga — algunas del banco pasan
            // los 140 chars y no aportan pedagogía adicional al modelo.
            const def = defRaw.length > 140 ? defRaw.slice(0, 137).trimEnd() + '…' : defRaw;
            const rule = this._compactRuleForTerm(t);
            const suffix = rule ? ` ${rule}` : '';
            lines.push(`- ${t.term}: ${def}${suffix}`);
        }
        return lines.join('\n');
    }

    // Extrae UNA restricción operativa corta del término, solo si aporta info
    // que no está ya cubierta por REGLA 12 del systemPrompt. Devuelve string
    // vacío si no hay nada específico que valga la pena mandar.
    _compactRuleForTerm(t) {
        const forbid = Array.isArray(t.forbiddenWhen) ? t.forbiddenWhen : [];
        // Genéricos ya cubiertos por REGLA 6 o REGLA 12 — no vale la pena
        // repetirlos por término.
        const isGeneric = (s) => {
            const low = String(s || '').toLowerCase();
            return !low
                || low.includes('sin escucha')
                || low.includes('sin contexto')
                || low === 'sin estilo declarado'
                || low.startsWith('transcription unreliable')
                || low.startsWith('key.reliability');
        };
        const specific = forbid.find(f => !isGeneric(f));
        if (!specific) return '';
        const trimmed = String(specific).trim();
        const clipped = trimmed.length > 90 ? trimmed.slice(0, 87).trimEnd() + '…' : trimmed;
        return `NO: ${clipped}.`;
    }

    // Alias de compatibilidad — call sites viejos y tests que aún referencian
    // el nombre anterior siguen funcionando. Nuevos call sites deben usar
    // formatMusicalTermsForPrompt directamente.
    formatMusicalTermsBlock(terms) {
        return this.formatMusicalTermsForPrompt(terms);
    }

    // Formatea la AUTOEVALUACIÓN previa del pianista (Fase A del reposicionamiento
    // SRL). Se inyecta al userPrompt para que el modelo la lea ANTES de escribir
    // el análisis y después la contraste en beliefVsDetection (REGLA 10). Es
    // opcional — si el usuario saltó el modal, no aparece y todo funciona igual.
    formatSelfEvaluation(selfEval) {
        if (!selfEval || typeof selfEval !== 'object') return '';
        const rating = Number(selfEval.rating);
        const weakArea = typeof selfEval.weakArea === 'string' ? selfEval.weakArea.trim() : '';
        const prediction = typeof selfEval.prediction === 'string' ? selfEval.prediction.trim().slice(0, 300) : '';
        if (!Number.isFinite(rating) && !weakArea && !prediction) return '';

        const lines = ['AUTOEVALUACIÓN DEL PIANISTA (leelo ANTES de escribir tu análisis — al final vas a compararla con lo que detectás):'];
        if (Number.isFinite(rating)) {
            lines.push(`- Autoevaluación general: ${rating}/5`);
        }
        if (weakArea) {
            lines.push(`- Área que el pianista siente más floja: ${weakArea}`);
        }
        if (prediction) {
            lines.push(`- Predicción del pianista: "${prediction}"`);
        }
        lines.push('IMPORTANTE: la comparación creencia-vs-detección va en el campo beliefVsDetection del JSON (REGLA 10). No adelantes esa comparación en musicalAnalysis.');
        return lines.join('\n');
    }

    // Helpers de categorización: convierten features numéricos en bandas
    // cualitativas para que el modelo no tenga números crudos que parrotear.
    // Los números crudos se ocultan salvo cuando son accionables (BPM real,
    // tiempo en segundos, nombre de tonalidad — cosas que un músico puede usar).
    static _band(value, thresholds, labels) {
        const v = Number(value);
        if (!Number.isFinite(v)) return null;
        for (let i = 0; i < thresholds.length; i++) {
            if (v < thresholds[i]) return labels[i];
        }
        return labels[labels.length - 1];
    }

    static _densityBand(notesPerSec) {
        return AIAnalysisEngine._band(notesPerSec, [1.5, 4, 7, 10], ['muy baja', 'baja', 'media', 'alta', 'muy alta']);
    }
    static _articulationBand(meanMs) {
        return AIAnalysisEngine._band(meanMs, [120, 250, 500], ['muy breve', 'breve', 'media', 'sostenida']);
    }
    static _dynamicSpreadBand(cv) {
        return AIAnalysisEngine._band(cv, [0.15, 0.30, 0.50], ['plana', 'poco variada', 'variada', 'muy variada']);
    }
    static _confidenceBand(conf) {
        return AIAnalysisEngine._band(conf, [0.4, 0.6, 0.8], ['baja', 'media', 'alta', 'muy alta']);
    }
    static _timbreBand(centroidHz) {
        return AIAnalysisEngine._band(centroidHz, [1500, 3000], ['oscuro/grave', 'equilibrado', 'brillante/agudo']);
    }
    static _silenceBand(ratio) {
        return AIAnalysisEngine._band(ratio, [0.1, 0.25, 0.5], ['casi sin silencios', 'pocos silencios', 'silencios frecuentes', 'muchos silencios']);
    }

    // Formatea las features derivadas para el prompt, en lenguaje YA categórico:
    // el modelo recibe "densidad alta" en vez de "10.57 notas/seg". Esto elimina
    // la tentación de parrotear números que no existen en su input.
    formatDerivedFeatures(derived, audioAnalysis = {}) {
        if (!derived || typeof derived !== 'object') return '';
        const lines = ['OBSERVACIONES DEL AUDIO (ya interpretadas — usalas para contar la historia musical, no las repitas literal):'];

        const { beat, rushDrag, notes, pitchClass, silence, sections } = derived;

        const failedProviders = Array.isArray(audioAnalysis.providersFailed) ? audioAnalysis.providersFailed : [];
        const hasMidi = notes !== null && notes !== undefined;
        const essentiaFoundSignal =
            (audioAnalysis?.tempo?.bpm > 0) ||
            (audioAnalysis?.key?.strength > 0) ||
            (Number(audioAnalysis?.loudness?.dynamicComplexity || 0) > 0);
        if (!hasMidi && essentiaFoundSignal) {
            lines.push(`- AVISO: la transcripción de notas (basic-pitch) NO devolvió notas${failedProviders.some(p => p.includes('basic-pitch')) ? ' (falla técnica, no silencio del audio)' : ''}. Trabajá solo con tempo/tonalidad/loudness. NO digas que el audio está en silencio. Si el score es bajo por esto, aclará que es limitación técnica.`);
        }

        if (beat) {
            lines.push(`- Pulso: ${beat.stability}.`);
        }
        if (rushDrag) {
            const delta = Number(rushDrag.deltaFirstToLast) || 0;
            const changeDesc = Math.abs(delta) < 3
                ? 'estable de principio a fin'
                : `${rushDrag.tendency} (arranca ~${rushDrag.firstThirdBpm} BPM, termina ~${rushDrag.lastThirdBpm} BPM)`;
            lines.push(`- Tempo a lo largo de la toma: ${changeDesc}.`);
        }
        if (notes) {
            const density = AIAnalysisEngine._densityBand(notes.notesPerSecond);
            const articulation = AIAnalysisEngine._articulationBand(notes.meanNoteDurationMs);
            const dynSpread = AIAnalysisEngine._dynamicSpreadBand(notes.dynamicVariationCV);
            // Densidad: para piano solo, "alta" y "muy alta" son la norma —
            // reportarla como observación destacable aparece en casi todas las
            // grabaciones y no aporta pedagogía (REGLA 6 · bullet piano solo).
            // Marcamos explícitamente que esa densidad es normal para que el modelo
            // NO la use como característica de la interpretación. Densidades bajas
            // sí se destacan porque son interpretativamente interesantes (rubato,
            // pasaje sostenido).
            const densityIsNormal = density === 'alta' || density === 'muy alta';
            const densityNote = densityIsNormal
                ? ' (NORMAL para piano solo — melodía+armonía+bajo simultáneos + escalísticos + arpegios; NO reportar como observación destacable salvo corroboración con otra señal reliable)'
                : density === 'baja' || density === 'muy baja'
                    ? ' (poco frecuente para piano — puede indicar pasaje sostenido, rubato o textura melódica interesante; SÍ es reportable)'
                    : '';
            lines.push(`- Densidad de notas: ${density}${densityNote}. Rango tocado: ${notes.lowestName}–${notes.highestName} (${notes.spanOctaves} octavas — rango amplio también es normal en piano, mencionar solo si es muy chico o relevante al estilo).`);
            lines.push(`- Duración de las notas transcritas: ${articulation}. (Ojo: es estimación de basic-pitch, no necesariamente articulación intencional — describir como "notas breves/sostenidas", no como "articulación staccato/legato del intérprete".)`);
            lines.push(`- Variedad de intensidad entre notas: ${dynSpread}.`);
        }
        if (pitchClass) {
            const top = pitchClass.top3.map(x => x.note).join(', ');
            lines.push(`- Notas más recurrentes: ${top}. (${pitchClass.pitchClassesUsed}/12 clases distintas${pitchClass.unusedNotes.length ? `; ausentes: ${pitchClass.unusedNotes.slice(0, 4).join(', ')}` : ''}.)`);
        }
        if (silence) {
            const band = AIAnalysisEngine._silenceBand(silence.silenceRatio);
            lines.push(`- Espacios sin notas: ${band}.`);
        }
        if (Array.isArray(sections) && sections.length) {
            lines.push('- Perfil por tramos (usá los TIEMPOS EN SEGUNDOS cuando anclás observaciones — no digas "sección 1", decí "entre X y Y segundos". Densidad alta/muy alta por tramo es normal para piano: usá el perfil para detectar CAMBIOS entre tramos (dónde crece/baja la energía), no para reportar cada valor absoluto):');
            for (const s of sections) {
                const density = AIAnalysisEngine._densityBand(s.notesPerSecond);
                lines.push(`  · ${s.startSec}s → ${s.endSec}s: densidad ${density}, rango ${s.lowestName}–${s.highestName}.`);
            }
        }

        // Reparto por registro pianístico — CONVENCIÓN de la app:
        // grave = acompañamiento/bajo (mano izq), agudo = melodía (mano der),
        // zona A3–A4 = puede ser cualquiera. La IA no puede inferir esto solo
        // del pitch, así que se lo damos explícito (aplica a MIDI directo y a
        // audio→MIDI vía basic-pitch).
        const handRoles = derived.handRoles;
        if (handRoles && handRoles.totalNotes > 0) {
            const pct = (v) => `${Math.round(v * 100)}%`;
            const b = handRoles.bass, t = handRoles.transition, m = handRoles.melody;
            lines.push('- REPARTO POR REGISTRO (convención piano — usá esto para hablar de MANOS y ROLES musicales):');
            lines.push(`  · Registro grave (hasta Ab3 · MANO IZQUIERDA típica — bajo/acompañamiento/comping): ${b.count} notas (${pct(b.share)}), ${b.perSecond}/s, simultaneidad ${pct(b.simultaneity)} ${b.simultaneity > 0.25 ? '→ hay acordes/comping' : '→ notas separadas, línea de bajo o walking'}.`);
            lines.push(`  · Zona intermedia (A3–A4, alrededor del do central · CUALQUIERA — izquierda extendida O melodía que baja): ${t.count} notas (${pct(t.share)}), ${t.perSecond}/s, simultaneidad ${pct(t.simultaneity)}. Mirá contexto: si acompaña al grave = izquierda extendida; si es rápido con notas sueltas = melodía bajando.`);
            lines.push(`  · Registro agudo (desde Bb4 · MANO DERECHA típica — melodía/improvisación/solo): ${m.count} notas (${pct(m.share)}), ${m.perSecond}/s, simultaneidad ${pct(m.simultaneity)} ${m.simultaneity > 0.15 ? '→ hay voicings/bloques melódicos' : '→ línea melódica de una sola voz'}.`);
        }

        if (lines.length === 1) return '';
        return lines.join('\n');
    }

    // Devuelve { systemPrompt, userPrompt }.
    // systemPrompt: persona, reglas, rúbrica, few-shot, schema (estable, cacheable).
    // userPrompt: datos concretos de ESTA grabación (dinámico).
    buildAnalysisPrompt(audioAnalysis, metadata, studentMemory = null, auditoryObservations = null, reliability = null, selfEvaluation = null) {
        const tempo = audioAnalysis?.tempo || {};
        const key = audioAnalysis?.key || {};
        const loudness = audioAnalysis?.loudness || {};
        const mfcc = Array.isArray(audioAnalysis?.mfcc) ? audioAnalysis.mfcc : [];
        const spectralCentroid = Number(audioAnalysis?.spectralCentroid || 0);
        const rhythmicComplexity = Number(audioAnalysis?.rhythmicComplexity || 0);
        const duration = Number(audioAnalysis?.duration || 0);

        const styleKey = String(metadata?.style || '').toLowerCase().replace(/[\s_-]/g, '');
        const styleGuidance = AIAnalysisEngine.STYLE_GUIDANCE[styleKey] || '';
        const level = String(metadata?.level || '').trim();
        const objective = String(metadata?.objective || '').trim();
        const targetTempo = Number(metadata?.targetTempo);
        const notes = String(metadata?.notes || '').trim();

        const derived = deriveFeatures(audioAnalysis);
        const derivedBlock = this.formatDerivedFeatures(derived, audioAnalysis);
        const memoryBlock = this.formatStudentMemory(studentMemory);
        const auditoryBlock = this.formatAuditoryObservations(auditoryObservations);
        const reliabilityBlock = this.formatReliabilityBlock(reliability);
        const selfEvalBlock = this.formatSelfEvaluation(selfEvaluation);
        // Vocabulario musical relevante para esta sesión (selector filtra por
        // reliability + estilo + evidencia — cap 10 términos). Formato compacto
        // ~25-40 tokens/término; reglas generales viven en REGLA 12 del system.
        const relevantTerms = getRelevantMusicalTerms(audioAnalysis, metadata, reliability, auditoryObservations);
        const musicalTermsBlock = this.formatMusicalTermsForPrompt(relevantTerms);

        const systemPrompt = `Sos profesor de piano de jazz (mainstream: bebop, cool, modal, post-bop, hard bop, standards; también afrocubano, latin jazz, jazz colombiano y bolero). Voseo rioplatense, cálido y específico, sin frases motivacionales vacías.

REGLA 0 — DATOS RESERVADOS (SOBRE TODAS LAS OTRAS):
Los siguientes datos son SOLO para tu razonamiento interno. NUNCA los menciones en tu respuesta al usuario, ni en musicalAnalysis, ni en strengths, ni en observations, ni en primaryFocus, ni en el ejercicio, ni en nextGoal, ni en beliefVsDetection, ni en metacognitiveQuestion:
- El tempo en BPM (ningún número seguido de "BPM", ni "beats por minuto", ni "pulsaciones por minuto").
- El nombre concreto de la tonalidad (nada de "Do mayor", "F# menor", "A Mixolydian", "Bb dorio", etc.).
- La puntuación / score (nada de "7/10", "una sesión de 8", "puntuación media", "score bajo", ni referencias a que hay una nota numérica).
- Los porcentajes de confianza o fuerza detectados.
Si necesitás hablar de ritmo, tonalidad o calidad global, usá lenguaje cualitativo neutro: "un pulso estable", "el centro tonal se mantiene", "hay pasajes más seguros y otros más dudosos". El schema JSON sigue incluyendo overallScore como campo, pero NO lo verbalices en ningún texto humano. Si te descubrís mencionando cualquiera de esos datos, reescribí la frase.

ARQUITECTURA (3 capas): (1) análisis local — Essentia/basic-pitch. (2) PERCEPCIÓN AUDITIVA — Gemini, cuando aparece en el userPrompt. (3) VOS — combinás capas + memoria en pedagogía útil. Nunca digas "escuché"; decí "los datos muestran" o hablá musicalmente. Si un dato no da para interpretación honesta, mejor "no se puede evaluar con estos datos" que inventar.

LAS 12 REGLAS (aplican todas, subordinadas a la REGLA 0):

R1. MÉTRICA SOLO SI SIRVE PARA UNA DECISIÓN MUSICAL (elegir metrónomo, cambiar dinámica, qué practicar). Si no, omitila.

R2. NADA DE JERGA. Prohibido: "amplitud", "variación relativa", "MFCC", "centroide", "complejidad dinámica", "confianza del X%", "fuerza del X%", "notas por segundo", "densidad de X.XX". En musicalAnalysis, PROHIBIDO además: la palabra "densidad" y sinónimos ("actividad muy alta", "muchas notas", "concentración de eventos", "gran cantidad de notas"), y listar nombres de notas MIDI (C#2, F#3). Los nombres de nota van en observations/ejercicio. Usá lenguaje musical pedagógico ("mantenés el pulso"), no la etiqueta ("estabilidad del pulso: alta").

R3. HECHO / INTERPRETACIÓN / HIPÓTESIS — nunca mezclar. HIPÓTESIS lleva marcadores obligatorios ("podría", "parece", "sugiere"). Duras: fuerza de tonalidad baja/media → NO afirmes tonalidad, decí "sugiere un centro alrededor de X". Duraciones MIDI cortas ≠ articulación staccato intencional. Etiquetas de estilo (bebop/bolero/son cubano) SOLO si el usuario las declaró o el patrón es inequívoco. Cifrado (Dm7, sustituciones, voicings extendidos) SOLO con MIDI que lo respalde.

R4. ANCLAJE TEMPORAL: siempre segundos ("entre los 18 y 27 segundos"), no "primera parte" ni "en el medio".

R5. SCORE = CALIDAD DE LA SESIÓN, no del pianista. Rúbrica: 9-10 excelente, 7-8 sólida, 5-6 irregular, 3-4 con dificultades, 1-2 no se sostuvo. Si faltan datos, score al centro y aclarás que es tentativo — nunca castigues por un fallo técnico de la plataforma.

R6. CAPA DE CONFIABILIDAD MANDA. Si aparece "CAPA DE CONFIABILIDAD" en el userPrompt:
- \`unreliable_signals\`: NO construyas conclusiones sobre ellas.
- \`key.reliability\` low/unreliable: NO recomendaciones armónicas basadas en tonalidad.
- \`transcription.level\` low/unreliable: NO uses densidad, articulación estimada, rango, silencio MIDI, ni perfil por secciones.
- \`melody.status: unknown\`: la nota más aguda NO es la melodía, la más grave NO es el bajo. No separes roles.
- Densidad "alta"/"muy alta" es NORMA en piano solo. PROHIBIDO reportarla como característica destacable. Solo entra si: (a) es baja/muy baja, (b) el pianista declaró trabajar pasajes de menor densidad, o (c) EN observations, 2+ señales reliable la corroboran como problema.
- "Rango amplio de notas": normal en piano. No lo destaques salvo <2 octavas o relevante al estilo.
- \`overall_data_quality: low\`: menos observaciones, más sólidas. NO pidas mejorar equipo de grabación.

R7. OBSERVATIONS EN 3 CAPAS. Cada elemento: \`fact\` (dato concreto con timestamp si aporta) → \`interpretation\` (verbo tentativo obligatorio) → \`recommendation\` (invitación a experimentar: "probá X y escuchá si...") → \`confidence\` ('high'|'medium'|'low'). PROHIBIDO saltar fact→recommendation sin interpretation. PROHIBIDO diagnosticar "estás haciendo X mal" desde un solo dato. Entre 0 y 3, sin llenar cupo. NO dupliques verbatim con musicalAnalysis. Si la obs viene de ESCUCHA (Gemini), el fact debe decir "En la escucha del fragmento entre X y Y segundos se percibe...".

R8. CADA SECCIÓN CUMPLE UNA FUNCIÓN DISTINTA (colapsá si aparece la misma idea en 2+):
- musicalAnalysis: QUÉ pasó musicalmente (narrativa).
- strengths: QUÉ anduvo bien (concreto, distinto de musicalAnalysis).
- observations: QUÉ señales apoyan la lectura (triadas).
- primaryFocus: LA cosa a trabajar (1 línea, UNA sola vez).
- practiceExercise: QUÉ HACER.
- nextGoal: CÓMO SÉ que mejoró (verificable, distinto de la acción).

R9. MODO PRUDENTE SIN PERCEPCIÓN AUDITIVA. Interpretations siempre tentativas. Prohibido convertir: densidad alta ≠ "falta de claridad"; actividad continua ≠ "abrumadora"; ausencia de nota ≠ "decisión musical"; regularidad ≠ "control motriz"; muchas notas ≠ "confuso". primaryFocus como INVITACIÓN, no diagnóstico. Recomendaciones = EXPERIMENTOS. Si NO podés articular interpretation tentativa honesta, la obs no va. Con PERCEPCIÓN AUDITIVA: más directo cuando datos + escucha convergen.

R10. beliefVsDetection (SOLO si vino AUTOEVALUACIÓN). UNA oración contrastando creencia vs datos: si convergen, reconocelo específico; si divergen, nombralo sin juzgar; si convergen parcial, aclará qué acertó y qué no; calibrá en ambas direcciones. Si los datos son inconfiables para lo que predijo, decilo. NO lo repitas en musicalAnalysis/primaryFocus/observations. Sin autoevaluación → omití el campo.

R11. metacognitiveQuestion — pregunta abierta final, máx 120 chars. UNA de tres formas: reflexión sobre proceso, verificación futura, exploración lateral. Prohibido: "¿te gustó?", "¿te sentiste bien?", "¿tenés dudas?", preguntas sobre datos ya en el análisis.

R12. VOCABULARIO MUSICAL. Cuando aparece "VOCABULARIO MUSICAL DISPONIBLE" en el userPrompt, esa lista es lo que el sistema considera aplicable (filtrado por reliability + estilo + evidencia). NO es obligatoria — usá SOLO lo que la evidencia de ESTA sesión respalde. Preferí término sencillo antes que especializado sin justificar. NO uses terminología avanzada para aparentar profundidad. Respetá "NO: ..." (restricción dura). Si un concepto no está en la lista, el sistema no lo respaldó — no lo uses. Prohibido definir términos al pianista (no es un glosario); si el nivel es 'principiante'/'básico', usá sinónimos accesibles.

R13. REGISTRO Y ROLES DE MANO (convención del piano). El teclado se parte alrededor del Do central (C4).
- Grave (hasta Ab3, MIDI ≤ 56): territorio de la MANO IZQUIERDA — bajo, walking bass, tumbao/montuno, comping, acordes de acompañamiento.
- Agudo (desde Bb4, MIDI ≥ 70): territorio de la MANO DERECHA — melodía, improvisación, líneas de solo.
- Zona intermedia (A3–A4, MIDI 57–69): AMBIGUA — la izquierda puede subir con acordes extendidos y la derecha puede bajar con frases melódicas. NO fuerces un rol: mirá simultaneidad (varias notas al mismo tiempo → probable acompañamiento extendido) y patrón temporal (notas sueltas y rápidas → probable melodía bajando).
Cuando el userPrompt trae "REPARTO POR REGISTRO", usalo literalmente para hablar de MANOS y roles: "en el bajo el groove se afloja" vs "en la línea melódica la digitación se traba". Prohibido tratar una nota aislada aguda como acompañamiento o una nota aislada grave como melodía sin evidencia rítmica. Aplica igual con MIDI directo o con audio→MIDI (basic-pitch): la convención es del piano, no del captor.

CONOCIMIENTO DE DOMINIO — Jazz: bebop scales, ii-V-I, tritone sub, modal, cool, post-bop, standards, compases irregulares (5/4, 7/4, 3/4 con swing), reharmonización, voicings (drop 2, rootless, quartal), walking bass. Referentes: Evans, Powell, Monk, Herbie, McCoy, Chick, Keith Jarrett, Oscar, Mehldau, Brubeck. Estilos afines: son cubano/clave, latin jazz, bolero, jazz colombiano. Reglas: 5/4 con swing → jazz experimental, NUNCA bolero. 7/4 o 6/8 con swing → jazz/prog, NO afrocubano. Etiquetas de estilo solo si el usuario lo declaró o hay ENFOQUE por estilo. Ante duda: técnico sin etiqueta.

AUTO-PODA ANTES DE EMITIR — releé y corregí:
- "densidad"/sinónimos en musicalAnalysis → reescribí sin esa palabra (usá dinámica, silencios, contornos, decisiones formales) o acortá.
- Notas MIDI (C#2, F#3) en musicalAnalysis → sacalas; decí "registro grave/medio/agudo" o no menciones.
- musicalAnalysis con 1 párrafo o >3 párrafos, o algún párrafo >3 oraciones → ajustá a 2-3 párrafos de 2-3 oraciones (60-90 palabras c/u).
- "rango amplio"/"varias octavas" destacado sin ser <2 octavas → sacalo.
- primaryFocus repetido en musicalAnalysis o título del ejercicio → reformulá musicalAnalysis.
- nextGoal describe la acción del ejercicio → nextGoal es CRITERIO OBSERVABLE ("comprobar si..."), no acción.
- observations que empiezan con la misma frase/métrica → colapsalas.
- strengths/observations que solo repiten musicalAnalysis → sacalas. Menos y sólido gana.

═══ SCHEMA JSON (respuesta ÚNICA, sin fences, sin comentarios) ═══
{
  "overallScore": <entero 1-10>,
  "musicalAnalysis": "<2 párrafos separados por \\n\\n (máx 3, NUNCA 4). Cada uno 2-3 oraciones (60-90 palabras). Accesible al pianista intermedio, sin jerga, SIN 'densidad', SIN listar notas MIDI. Estructura sugerida: P1 QUÉ PASÓ (hechos anclados en segundos), P2 QUÉ SIGNIFICA (lectura tentativa), P3 opcional tendencia. Sin frases-relleno tipo 'fluye con naturalidad', 'buen control técnico', 'mostrás musicalidad'.>",
  "strengths": [ "<punto concreto, 0-2, distintos entre sí, no repite musicalAnalysis>" ],
  "observations": [
    { "fact": "<dato concreto>", "interpretation": "<qué sugiere, verbo tentativo>", "recommendation": "<qué experimentar, invitación>", "confidence": "high"|"medium"|"low" }
  ],
  "primaryFocus": "<1 línea, oportunidad de exploración/verificación (verbos: explorar, comprobar, probar) — NO diagnóstico. Se dice UNA sola vez>",
  "practiceExercise": {
    "title": "<nombre corto y musical>",
    "steps": [ "<instrucción con verbo directo>", "<...>", "<opcional>", "<opcional>" ],
    "checkQuestion": "<UNA pregunta que el pianista responda al terminar>",
    "durationMin": <entero 5-15>
  },
  "moments": [ { "timeStart": <seg>, "timeEnd": <seg>, "kind": "good"|"improve"|"neutral", "note": "<frase corta, máx 80 chars>" } ],
  "nextGoal": "<condición VERIFICABLE en la próxima grabación, distinta de la acción del ejercicio>",
  "beliefVsDetection": "<SOLO si vino AUTOEVALUACIÓN: UNA oración contrastando creencia vs datos (REGLA 10). Formato: '<qué creyó> · Los datos muestran <qué detectó> · <convergen / difieren en X>'. Si NO vino, omití o dejá vacío>",
  "metacognitiveQuestion": "<UNA pregunta abierta al pianista, máx 120 chars (REGLA 11)>"
}

Reglas finales de emisión: 2-4 steps por ejercicio; 2-5 moments distribuidos en el tiempo dentro de [0, duración real]; sin observations antes que inventar. Responde ÚNICAMENTE el objeto JSON.`;

        // Contexto declarado por el usuario — bloque compacto solo si algo se declaró.
        const declaredLines = [];
        if (metadata?.style) declaredLines.push(`- Estilo declarado: ${metadata.style}`);
        if (level) declaredLines.push(`- Nivel declarado: ${level}`);
        if (objective) declaredLines.push(`- Objetivo de esta práctica: ${objective}`);
        if (Number.isFinite(targetTempo) && targetTempo > 0) {
            declaredLines.push(`- Tempo objetivo: ${targetTempo} BPM (comparar con el detectado real y comentar la diferencia)`);
        }
        if (notes) declaredLines.push(`- Notas del músico: ${notes}`);
        const declaredBlock = declaredLines.length
            ? `CONTEXTO DECLARADO POR EL MÚSICO:\n${declaredLines.join('\n')}`
            : 'CONTEXTO DECLARADO POR EL MÚSICO: (ninguno — la IA infiere del audio; no le pongas etiqueta de género si no hay señales fuertes)';

        // Métricas presentadas ya categorizadas — el modelo NO ve el número crudo
        // salvo cuando es accionable (BPM, tonalidad, duración). El resto se
        // convierte en bandas cualitativas para evitar parroteo numérico.
        const tempoConfBand = AIAnalysisEngine._confidenceBand(Number(tempo.confidence || 0));
        const keyStrengthBand = AIAnalysisEngine._confidenceBand(Number(key.strength || 0));
        const dynBand = AIAnalysisEngine._dynamicSpreadBand(Number(loudness.dynamicComplexity || 0));
        const timbreBand = AIAnalysisEngine._timbreBand(spectralCentroid);
        const bpm = Math.round(Number(tempo.bpm || 0));
        const keyLabel = key.key ? `${key.key}${key.scale ? ` ${key.scale}` : ''}` : 'no determinada';

        // La tonalidad se muestra con marcador de certeza para que el modelo
        // aplique la regla de hedge correctamente.
        const keyStatement = key.key
            ? `${keyLabel} (certeza detectada: ${keyStrengthBand}${
                (Number(key.strength) || 0) < 0.6
                    ? ' — REGLA DURA: no la afirmes; usá "el análisis sugiere un centro alrededor de ' + keyLabel + '"'
                    : ''
              })`
            : 'no determinada por el análisis — no menciones tonalidad ni cifrado';

        const tempoStatement = bpm > 0
            ? `${bpm} BPM (estabilidad detectada: ${tempoConfBand}${
                (Number(tempo.confidence) || 0) < 0.5
                    ? ' — usá lenguaje tentativo, "el pulso parece rondar los ' + bpm + ' BPM"'
                    : ''
              })`
            : 'no detectado';

        // Bloque especial cuando la grabación vino de un teclado MIDI directo:
        // las notas son EXACTAS (no transcripción de audio), no hay dinámica de
        // amplitud ni color de timbre. Se lo aclaramos al modelo para que no
        // hable de "articulación estimada" ni "timbre percibido".
        const midiSource = audioAnalysis?.source === 'midi-input';
        const midiBlock = midiSource
            ? `FUENTE DE LA GRABACIÓN: MIDI directo (teclado). Las notas y velocidades son EXACTAS (no transcritas de audio). Como consecuencia:
- NO hay información de timbre ni de dinámica global de amplitud (no menciones "color", "timbre" ni "loudness").
- La articulación real (staccato/legato pedaleado) NO se puede afirmar sin pedal — reservate al hecho MIDI.
- Podés hablar libremente de notas, patrones, densidad, fraseo, timing.
`
            : '';

        const userPrompt = `${midiBlock}${reliabilityBlock ? reliabilityBlock + '\n\n' : ''}DATOS DE LA GRABACIÓN (ya en lenguaje musical — usalos así, NO los reconviertas a números):
- Duración total: ${duration.toFixed(1)} segundos
- Tempo: ${tempoStatement}
- Tonalidad: ${keyStatement}
- Rango dinámico global: ${dynBand}
- Color del timbre: ${timbreBand}

${declaredBlock}
${styleGuidance ? `\n${styleGuidance}\n` : ''}
${memoryBlock ? `\n${memoryBlock}\n` : ''}
${derivedBlock}
${auditoryBlock ? `\n${auditoryBlock}\n` : ''}
${selfEvalBlock ? `\n${selfEvalBlock}\n` : ''}
${musicalTermsBlock ? `\n${musicalTermsBlock}\n` : ''}
Devolvé el objeto JSON según el schema del system. Los moments deben caer dentro de [0, ${duration.toFixed(1)}] segundos.`;

        return { systemPrompt, userPrompt };
    }

    // Ceiling de tokens del userPrompt del chat. Groq compound-mini en free tier
    // rechaza inputs grandes con 413; medido empíricamente los 6-7k tokens de
    // userPrompt disparan el error. Este ceiling deja margen para el
    // systemPrompt (~400) y la respuesta (800), quedando bajo el TPM del free
    // tier (12k). Si buildQuestionPrompt supera esto, va tirando bloques
    // opcionales por orden inverso hasta caber.
    static CHAT_PROMPT_TOKEN_CEILING = 3500;

    // Detección por keywords en la pregunta del pianista. Retrieval liviano:
    // en vez de dumpear TODO el análisis siempre (lo que causó el 413), solo
    // incluimos los bloques cuya categoría la pregunta menciona. Regex simples,
    // en español (voseo/tuteo), tolerantes a variaciones.
    static _chatKeywordFlags(question) {
        const q = String(question || '').toLowerCase();
        return {
            wantsObservations: /observ|coment|eso que|lo que dijist|por qu[eé]|dijist|marcast|se[ñn]al/.test(q),
            wantsMoments:      /segund|minut|d[oó]nde|cu[aá]ndo|en qu[eé]\s+(part|moment)|timestamp/.test(q),
            wantsMemory:       /antes|[uú]ltim|vengo|sesi[oó]n\s+(pasad|anterior)|siempre|repetid|hist[oó]ric|progres/.test(q),
            wantsReliability:  /tempo|bpm|pulso|ritm|tonalid|clave|escala|modo|arm[oó]n/.test(q),
            wantsExercise:     /ejercic|practic|c[oó]mo\s+(lo\s+)?(trabaj|estudi)|rutina/.test(q),
            wantsMusicalContext: /an[aá]lisis|resum|qu[eé]\s+(pas[oó]|hice|toqu[eé])|c[oó]mo\s+me\s+fue/.test(q),
        };
    }

    buildQuestionPrompt(audioAnalysis, aiAnalysis, question, chatHistory = [], focusRegion = null, ctx = {}) {
        const safeAi = aiAnalysis && typeof aiAnalysis === 'object' ? aiAnalysis : {};
        const musicalAnalysisFull = String(safeAi.musicalAnalysis || '').trim();
        const exerciseTitle = safeAi.practiceExercise?.title
            || (Array.isArray(safeAi.practiceSuggestions) ? safeAi.practiceSuggestions[0]?.title : '')
            || '';
        const exerciseSteps = Array.isArray(safeAi.practiceExercise?.steps)
            ? safeAi.practiceExercise.steps.filter(s => typeof s === 'string' && s.trim()).slice(0, 4)
            : [];
        const primaryFocus = String(safeAi.primaryFocus || '').trim();
        const nextGoal = String(safeAi.nextGoal || '').trim();
        const beliefVsDetection = String(safeAi.beliefVsDetection || '').trim();
        const strengths = Array.isArray(safeAi.strengths)
            ? safeAi.strengths.filter(s => typeof s === 'string' && s.trim()).slice(0, 2)
            : [];
        const observations = Array.isArray(safeAi.observations)
            ? safeAi.observations
                .filter(o => o && typeof o === 'object' && (o.fact || o.interpretation))
                .slice(0, 3)
            : [];
        const moments = Array.isArray(safeAi.moments)
            ? safeAi.moments
                .filter(m => m && typeof m === 'object' && m.note)
                .slice(0, 5)
            : [];

        // Bandas cualitativas — mismas que buildAnalysisPrompt usa para no leakear
        // BPM/tonalidad/score. La REGLA 0 le pide al modelo no exponer los números;
        // ahora el prompt tampoco se los pone en bandeja.
        const tempo = audioAnalysis?.tempo || {};
        const key = audioAnalysis?.key || {};
        const loudness = audioAnalysis?.loudness || {};
        const tempoConfBand = AIAnalysisEngine._confidenceBand(Number(tempo.confidence || 0));
        const keyStrengthBand = AIAnalysisEngine._confidenceBand(Number(key.strength || 0));
        const dynBand = AIAnalysisEngine._dynamicSpreadBand(Number(loudness.dynamicComplexity || 0));
        const timbreBand = AIAnalysisEngine._timbreBand(Number(audioAnalysis?.spectralCentroid || 0));

        // Contexto extra opcional (metadata declarada por el pianista, capa de
        // reliability, memoria del estudiante). Todos safe-null: si el caller
        // no los pasa, los bloques no aparecen y el prompt vuelve al comportamiento
        // anterior salvo por las bandas cualitativas.
        const metadata = (ctx && typeof ctx === 'object' && ctx.metadata) ? ctx.metadata : null;
        const reliability = (ctx && typeof ctx === 'object' && ctx.reliability) ? ctx.reliability : null;
        const studentMemory = (ctx && typeof ctx === 'object' && ctx.studentMemory) ? ctx.studentMemory : null;

        const styleKey = String(metadata?.style || '').toLowerCase().replace(/[\s_-]/g, '');
        const styleGuidance = AIAnalysisEngine.STYLE_GUIDANCE[styleKey] || '';

        // Retrieval por keywords: solo incluimos los bloques que la pregunta pide.
        // Esto es lo que evita el 413 del chat — antes dumpeábamos todo siempre.
        const flags = AIAnalysisEngine._chatKeywordFlags(question);
        const hasFocus = focusRegion && Number.isFinite(focusRegion.start) && Number.isFinite(focusRegion.end)
            && focusRegion.end > focusRegion.start;

        // Reliability solo si la pregunta menciona algo que se pueda hedgear.
        const reliabilityBlock = (reliability && flags.wantsReliability)
            ? this.formatReliabilityBlock(reliability) : '';

        // Memoria solo si la pregunta refiere a continuidad. El caller le pasó
        // buildStudentMemory() ya, pero no tiene sentido gastar 300 tokens en cada
        // pregunta cuando la mayoría no van sobre progresión histórica.
        const memoryBlock = (studentMemory && flags.wantsMemory)
            ? this.formatStudentMemory(studentMemory) : '';

        // Notas MIDI del fragmento en foco. Si NO hay región marcada esto queda
        // vacío. Si hay, cap 15 (era 40 — con 40 solo esto ya son ~1500 tokens).
        let focusNotesBlock = '';
        if (hasFocus) {
            const allNotes = Array.isArray(audioAnalysis?.midiNotes) ? audioAnalysis.midiNotes : [];
            const noteName = (m) => {
                const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
                const midi = Math.round(Number(m) || 0);
                if (midi < 12 || midi > 127) return '?';
                return `${names[midi % 12]}${Math.floor(midi / 12) - 1}`;
            };
            const inRange = allNotes
                .filter(n => {
                    const start = Number(n?.startTimeSeconds ?? n?.start ?? 0);
                    return start >= focusRegion.start && start <= focusRegion.end;
                })
                .slice(0, 15)
                // Formato densísimo: t=X.XXs d=Y.YY N amp=Z.ZZ en UNA línea.
                .map(n => {
                    const start = Number(n?.startTimeSeconds ?? n?.start ?? 0);
                    const dur = Number(n?.durationSeconds ?? n?.duration ?? 0);
                    const pitchMidi = Number(n?.pitchMidi ?? n?.pitch ?? 0);
                    const amp = Number(n?.amplitude ?? 0);
                    return `t=${start.toFixed(2)} d=${dur.toFixed(2)} ${noteName(pitchMidi)} a=${amp.toFixed(2)}`;
                });
            if (inRange.length) {
                focusNotesBlock = `NOTAS MIDI EN EL FRAGMENTO EN FOCO (${inRange.length}):\n${inRange.join(' | ')}\n`;
            }
        }

        // Moments solo si la pregunta refiere a timestamps. Cap 4, formato una línea.
        const momentsBlock = (moments.length && flags.wantsMoments)
            ? `MOMENTOS ANOTADOS:\n${moments.slice(0, 4).map(m => {
                const s = Number(m.timeStart) || 0;
                const e = Number(m.timeEnd) || s;
                return `- ${s.toFixed(1)}→${e.toFixed(1)}s [${m.kind}] ${String(m.note || '').slice(0, 100)}`;
            }).join('\n')}\n`
            : '';

        // Observations en formato compacto (una línea por capa, cap 100 chars c/u)
        // y solo si la pregunta las referencia. Al pianista le importan cuando
        // pregunta por lo que ve en pantalla, no en cada consulta.
        const observationsBlock = (observations.length && flags.wantsObservations)
            ? `OBSERVACIONES:\n${observations.map((o, i) => {
                const fact = String(o.fact || '').slice(0, 100);
                const interp = String(o.interpretation || '').slice(0, 100);
                const reco = String(o.recommendation || '').slice(0, 100);
                return `${i + 1}. ${fact} → ${interp} → ${reco} (${o.confidence || 'medium'})`;
            }).join('\n')}\n`
            : '';

        // Ejercicio solo si la pregunta refiere a práctica.
        const exerciseBlock = (exerciseTitle && flags.wantsExercise)
            ? `EJERCICIO RECOMENDADO: "${exerciseTitle}"${exerciseSteps.length ? ` — pasos: ${exerciseSteps.map((s, i) => `(${i + 1}) ${s}`).join(' ')}` : ''}\n`
            : '';

        // Musical analysis: incluir SIEMPRE pero cortado. Sirve como narrativa
        // base y el pianista lo tiene en pantalla. Con wantsMusicalContext=true
        // le damos más margen.
        const musicalAnalysisMax = flags.wantsMusicalContext ? 700 : 300;
        const musicalAnalysis = musicalAnalysisFull.slice(0, musicalAnalysisMax);

        // Contexto declarado — siempre chico (5-15 tokens), va siempre.
        const declaredLines = [];
        if (metadata?.style) declaredLines.push(`estilo=${metadata.style}`);
        if (metadata?.level) declaredLines.push(`nivel=${metadata.level}`);
        if (metadata?.objective) declaredLines.push(`objetivo=${String(metadata.objective).slice(0, 120)}`);
        const declaredBlock = declaredLines.length
            ? `DECLARADO: ${declaredLines.join(' · ')}\n`
            : '';

        // Strengths — chico, va siempre si existe (dos líneas máx).
        const strengthsBlock = strengths.length
            ? `FORTALEZAS: ${strengths.slice(0, 2).join(' · ')}\n`
            : '';

        const systemPrompt = `Sos NeuralJam, el asistente conversacional de PianoStudy. Este canal es el chat de análisis: el pianista acaba de grabarse y quiere entender/mejorar su interpretación. Actuás como profesor de piano de jazz con 20 años de experiencia (bebop, cool, modal, post-bop, hard bop, standards; también son cubano, latin jazz, jazz colombiano, bolero). Si te preguntan quién sos, decís "NeuralJam".

REGLA 0 — DATOS RESERVADOS: NUNCA menciones al pianista BPM en cifras, nombres de tonalidad (Do mayor, F# menor, A Mixolydian…), score numérico, ni porcentajes de confianza. Usá lenguaje cualitativo ("pulso estable", "centro tonal claro", "pasajes más seguros"). Si te preguntan por esos datos directamente, decí que no los exponés y ofrecé una lectura cualitativa.

TONO: reflexivo, honesto, directo, voseo rioplatense. Sin motivacional vacío, sin "¡Excelente pregunta!", sin "espero haberte ayudado". Empezá por la respuesta. Si no sabés o los datos son ambiguos, decilo. Corregí al pianista con respeto cuando esté equivocado.

USO DEL CONTEXTO: te paso solo los bloques relevantes a esta pregunta (retrieval). Si aparece OBSERVACIONES/MOMENTOS/EJERCICIO son los que el pianista está viendo en su pantalla — identificalos por el fact/nota, referencialos en segundos. Si aparecen NOTAS MIDI EN EL FRAGMENTO EN FOCO, basá tu respuesta EN esas notas (patrón, dirección, saltos, disonancias) — no hables en general del pasaje. Si aparece CAPA DE CONFIABILIDAD y algo es unreliable, aclará que no es afirmable y no recomiendes cosas que dependan de eso (nada de cifrado/armonía con key unreliable).

REGISTRO Y ROLES DE MANO (convención del piano): grave (hasta Ab3) = MANO IZQUIERDA (bajo/comping/tumbao), agudo (desde Bb4) = MANO DERECHA (melodía/solo), zona A3–A4 = ambigua (izquierda extendida o melodía bajando). Cuando el bloque REPARTO viene en el contexto, usalo para nombrar los roles al pianista ("en el bajo…", "en la línea melódica…") — no atribuyas mano por una nota aislada.

FORMATO: 2-4 párrafos cortos, prosa. Sin bullets salvo pasos de ejercicio. Grado del acorde relativo (ii-V-I) salvo que el pianista ya haya dicho la tonalidad. Voicings concretos (qué grado, qué tensiones). Si falta contexto, pedí una aclaración antes que consejo vago. Al cierre, si aporta, UNA idea para probar.`;

        // Historia recortada — 3 turnos, cap 200 chars c/u. Era 6×500 = 3000
        // chars solo por el history (750 tokens); ahora ~600 chars (~150 tokens).
        const historyBlock = Array.isArray(chatHistory) && chatHistory.length
            ? `CONV PREVIA:\n${chatHistory
                .slice(-3)
                .map(m => `${m.role === 'user' ? 'E' : 'N'}: ${String(m.text || '').slice(0, 200)}`)
                .join('\n')}\n`
            : '';

        let focusBlock = '';
        if (hasFocus) {
            const s = Number(focusRegion.start).toFixed(1);
            const e = Number(focusRegion.end).toFixed(1);
            focusBlock = `FOCO: el pianista marcó el fragmento ${s}s→${e}s. Enfocá la respuesta ahí.\n\n`;
        }

        const durationText = Number(audioAnalysis?.duration || 0).toFixed(1);

        // Reparto por registro pianístico — usá los midiNotes disponibles.
        // Se computa acá (no pedimos que el caller lo pase) porque es chico y
        // no todos los callers computan deriveFeatures antes del chat. Aplica a
        // MIDI directo Y a audio→MIDI (basic-pitch).
        const midiNotesForRoles = Array.isArray(audioAnalysis?.midiNotes) ? audioAnalysis.midiNotes : [];
        let handRolesBlock = '';
        if (midiNotesForRoles.length) {
            const hr = handRoleZones(midiNotesForRoles, Number(audioAnalysis?.duration || 0));
            if (hr && hr.totalNotes > 0) {
                const pct = (v) => `${Math.round(v * 100)}%`;
                handRolesBlock = `REPARTO_MANOS: bajo/comping (grave hasta Ab3)=${pct(hr.bass.share)} sim=${pct(hr.bass.simultaneity)} · mixto (A3-A4)=${pct(hr.transition.share)} · melodía (agudo desde Bb4)=${pct(hr.melody.share)} sim=${pct(hr.melody.simultaneity)}\n`;
            }
        }

        // Núcleo siempre-in — chico, estable, cachea bien.
        const coreBlock = `CONTEXTO (uso interno — REGLA 0):
dur=${durationText}s · pulso=${tempoConfBand} · tonalidad=${keyStrengthBand} · dinámica=${dynBand} · timbre=${timbreBand}
${handRolesBlock}${declaredBlock}${strengthsBlock}${primaryFocus ? `PRIMARY_FOCUS: ${primaryFocus}\n` : ''}${nextGoal ? `NEXT_GOAL: ${nextGoal}\n` : ''}${beliefVsDetection ? `BELIEF_VS_DETECTION: ${beliefVsDetection}\n` : ''}MUSICAL_ANALYSIS: ${musicalAnalysis || '(no disponible)'}
`;

        // Bloques opcionales ordenados por prioridad de trim (los últimos se
        // tiran primero si nos pasamos del ceiling). Focus notes son las más
        // caras pero también las de mayor valor cuando hay región marcada, así
        // que van primero (no se tiran salvo que también sobre core).
        const optionalBlocks = {
            focusNotes:     focusNotesBlock,
            observations:   observationsBlock,
            moments:        momentsBlock,
            exercise:       exerciseBlock,
            reliability:    reliabilityBlock ? reliabilityBlock + '\n' : '',
            memory:         memoryBlock ? memoryBlock + '\n' : '',
            styleGuidance:  styleGuidance ? styleGuidance + '\n' : '',
            history:        historyBlock,
        };
        // Orden de descarte (los últimos son los MÁS descartables).
        const trimOrder = ['history', 'styleGuidance', 'memory', 'reliability', 'exercise', 'moments', 'observations', 'focusNotes'];

        const composeUserPrompt = () => {
            const parts = [focusBlock, coreBlock];
            for (const key of trimOrder.slice().reverse()) {
                if (optionalBlocks[key]) parts.push(optionalBlocks[key]);
            }
            parts.push(`\nPREGUNTA:\n${question}`);
            return parts.filter(Boolean).join('\n');
        };

        let userPrompt = composeUserPrompt();
        // Guard: si nos pasamos del ceiling, vamos descartando bloques por orden
        // (empezando por history, terminando por focusNotes). Si aun así se pasa,
        // recortamos musical_analysis a 150 chars y history a 100.
        const ceiling = AIAnalysisEngine.CHAT_PROMPT_TOKEN_CEILING;
        for (const key of trimOrder) {
            if (AIAnalysisEngine._estimateTokens(userPrompt) <= ceiling) break;
            if (optionalBlocks[key]) {
                optionalBlocks[key] = '';
                userPrompt = composeUserPrompt();
            }
        }
        // Ultimísimo recurso: acortar el core (musical_analysis).
        if (AIAnalysisEngine._estimateTokens(userPrompt) > ceiling && musicalAnalysis.length > 150) {
            userPrompt = userPrompt.replace(
                `MUSICAL_ANALYSIS: ${musicalAnalysis}`,
                `MUSICAL_ANALYSIS: ${musicalAnalysis.slice(0, 150)}`,
            );
        }

        return { systemPrompt, userPrompt };
    }

    // aiUnavailable: true cuando esta función se llama porque callAI tiró error o
    // devolvió vacío — importante decirle al usuario que no fue una respuesta
    // real del modelo, no una canned respuesta disfrazada.
    getFallbackAnswer(audioAnalysis, aiAnalysis, question, aiUnavailable = false) {
        if (aiUnavailable) {
            return 'No pude conectar con la IA para responder tu pregunta ahora. Reintentá en unos segundos — si el error persiste puede ser cupo del proveedor o problema de red.';
        }
        const q = String(question || '').toLowerCase();
        const tempo = Number(audioAnalysis?.tempo?.bpm || audioAnalysis?.tempo || 0);
        const level = Number(audioAnalysis?.loudness?.dynamicComplexity || 0);
        const score = aiAnalysis?.overallScore;

        if (q.includes('tempo') || q.includes('ritmo') || q.includes('metrónomo') || q.includes('metronomo')) {
            return `Sobre el tempo: te detecté aprox. ${tempo} BPM.\n\nProbá esto:\n1) Metrónomo en negras a ${Math.round(tempo * 0.8)} BPM (80%) y tocá sin parar 2 minutos.\n2) Subí a ${tempo} BPM y repetí.\n3) Si te acelerás, cambiá el metrónomo a corcheas (subdividí) por 1 minuto.\n\nSi me decís qué parte se te va (inicio/medio/final), te propongo un ejercicio más específico.`;
        }

        if (q.includes('dinam') || q.includes('volumen') || q.includes('fuerte') || q.includes('suave')) {
            const dynHint = level < 0.3
                ? 'La interpretación parece algo plana en dinámicas.'
                : 'Hay variación dinámica aprovechable.';
            return `Sobre dinámica/volumen: ${dynHint}\n\nEjercicio rápido:\n- Tocá una misma frase 5 veces: pp, p, mf, f, ff.\n- Mantené el tempo fijo y cambiá solo el peso del brazo y la velocidad del ataque.\n\nSi querés, decime qué estilo estás tocando (blues/bebop/bolero/latin) y ajusto la sugerencia.`;
        }

        return `Puedo ayudarte con esa pregunta.\n\nCon lo que tengo (sin audio), sé que tu grabación dura ${audioAnalysis.duration?.toFixed?.(1) ?? 'N/A'}s, tempo aprox. ${tempo} BPM y score ${score ?? 'N/A'}/10.\n\nPara afinar la respuesta, decime:\n- ¿Qué estabas practicando (tema/lick/estilo)?\n- ¿Qué te salió mal exactamente (tempo, notas, coordinación, swing, voicings, mano izquierda)?`;
    }

    parseAIResponse(text) {
        // Delegado en el util compartido — maneja fences, texto extra alrededor
        // del objeto, y control chars sin escapar dentro de strings (el bug
        // más frecuente: el modelo escribe \n literal en musicalAnalysis y
        // JSON.parse lo rechaza). Ver tests/jsonRepair.test.js.
        return parseLlmJson(text);
    }

    getFallbackAnalysis(audioAnalysis) {
        const tempoBpm = Number(audioAnalysis?.tempo?.bpm || audioAnalysis?.tempo || 0);
        const dynamic = Number(audioAnalysis?.loudness?.dynamicComplexity || 0);
        const duration = Number(audioAnalysis?.duration || 0);
        const loudnessFeedback = dynamic < 0.3
            ? 'La dinámica suena relativamente plana; conviene ampliar contrastes.'
            : 'Se aprecia una dinámica con cierto movimiento.';
        const tempoFeedback = this.getTempoFeedback(tempoBpm);

        return {
            overallScore: 7,
            musicalAnalysis: `Interpretación de ${duration.toFixed(1)} segundos. ${tempoFeedback} ${loudnessFeedback} Sin un análisis con IA no puedo darte detalles específicos sobre voicings, fraseo o articulación — solo lo que las métricas técnicas me indican. Cuando la IA vuelva a estar disponible, volvé a analizar la misma grabación para obtener retroalimentación específica sobre tu interpretación. (Análisis genérico — la IA no estaba disponible cuando se procesó esta grabación.)`,
            practiceExercise: {
                title: 'Metrónomo escalonado',
                description: `Tomá un fragmento de 8 compases de lo que grabaste. Tocalo con metrónomo a ${Math.max(40, Math.round(tempoBpm * 0.8))} BPM (80% del tempo real), después a ${tempoBpm} BPM, después a ${Math.round(tempoBpm * 1.15)} BPM. Grabá cada pasada y escuchá dónde el pulso se te va: al inicio de la frase, en el medio, o al final. Ese es el punto donde tenés que subdividir mentalmente en corcheas.`,
                durationMin: 10,
            },
            moments: [],
            nextGoal: 'Volver a grabar el mismo fragmento con la IA disponible para obtener un análisis específico.',
        };
    }

    getTempoFeedback(tempo) {
        if (tempo < 60) return 'El tempo es bastante lento, apropiado para baladas.';
        if (tempo < 90) return 'Tempo moderado, bueno para piezas expresivas.';
        if (tempo < 120) return 'Tempo medio, versátil para varios estilos.';
        if (tempo < 150) return 'Tempo animado, adecuado para piezas energéticas.';
        return 'Tempo rápido, desafiante para mantener precisión.';
    }

    getLoudnessFeedback(level) {
        const feedbacks = {
            'Muy fuerte': 'Nivel de volumen muy alto - considera más variación dinámica.',
            'Fuerte': 'Buen nivel de proyección sonora.',
            'Moderado': 'Nivel de volumen equilibrado.',
            'Suave': 'Nivel suave - considera usar más proyección en secciones climáticas.',
            'Muy suave': 'Nivel muy bajo - verifica tu técnica y la grabación.'
        };
        return feedbacks[level] || '';
    }
}
