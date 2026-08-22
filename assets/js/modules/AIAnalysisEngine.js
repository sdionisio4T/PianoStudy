import { db } from './supabase-client.js';
import { deriveFeatures } from './AudioFeatures.js';
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

    // Estimador rápido de tokens: ~4 chars/token en español (conservador —
    // el ratio real es cercano a 3.5, así que sobreestimamos un poco, lo
    // que hace el guard más cauto). Suficiente para evitar 413.
    static _estimateTokens(text) {
        if (!text) return 0;
        return Math.ceil(String(text).length / 4);
    }

    // Status transitorios donde vale la pena reintentar antes de caer al fallback.
    // 429 = rate limit (Groq free tier o proxy), 503 = high demand (Gemini),
    // 500/502/504 = errores de gateway/upstream. Un 400/401/403 NO se reintenta:
    // son problemas del request o de la key.
    static TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

    // Backoff diferenciado por status del intento anterior.
    // - 429: la ventana de rate limit se rellena por MINUTO (tanto en el proxy
    //   —10 req/min por usuario— como en el free tier de Groq —TPM/RPM—). Se
    //   respeta primero el "try again in Ns" que viene en el body del error;
    //   si no viene o es muy largo (>15s) directamente NO reintentamos y
    //   dejamos que el caller vaya al fallback local. La tabla queda como red
    //   de seguridad para 429 sin retry-after (rate del proxy propio).
    // - 5xx: picos transitorios del upstream, típicamente se resuelven en 1-3s.
    // Índice = número de intento (0 = original, sin espera).
    static BACKOFFS_MS_BY_STATUS = {
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
                    // Para 429, respetar el retry-after que viene en el body.
                    // Si Groq pide esperar más que RETRY_AFTER_HARD_LIMIT_MS,
                    // abandonamos: reintentar cuando la ventana aún no se liberó
                    // solo bloquea al usuario para probablemente fallar igual.
                    if (status === 429) {
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

    // Provider por defecto: Groq. El usuario puede cambiarlo a Gemini como modo
    // experimental seteando localStorage['pianoStudy.aiProvider'] = 'gemini'.
    //
    // Cuidado: Gemini para texto CONSUME el mismo cupo diario que la escucha
    // de audio (GeminiAudioAnalyzer). En sesiones con mucha grabación puede
    // agotar cupo antes de tiempo. Está pensado como A/B experimental para
    // comparar calidad, no como default.
    //
    // Valores válidos: 'groq' (default) | 'gemini'.
    static _getProvider() {
        try {
            const stored = typeof localStorage !== 'undefined'
                ? localStorage.getItem('pianoStudy.aiProvider')
                : null;
            return stored === 'gemini' ? 'gemini' : 'groq';
        } catch { return 'groq'; }
    }

    // Enruta al proveedor activo. Si Groq falla NO cae a Gemini (y viceversa)
    // — cada modo es explícito, para que el A/B sea limpio. El caller decide
    // qué hacer con el error (fallback local o mensaje al usuario).
    async callAI(prompt, systemPrompt = null, options = {}) {
        const provider = AIAnalysisEngine._getProvider();
        if (provider === 'gemini') {
            return await this.callGemini(prompt, systemPrompt, options);
        }
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
        const provider = AIAnalysisEngine._getProvider();
        try {
            rawText = await this.callAI(userPrompt, systemPrompt, options);
            providerUsed = provider;
            const parsed = this.parseAIResponse(rawText);
            const validation = this.validateAnalysisSchema(parsed);
            if (validation.ok) {
                const baseSource = `ai-${provider}`;
                validation.value.source = hasAudioLayer ? `${baseSource}+audio` : baseSource;
                return validation.value;
            }
            console.warn('AI response invalid schema:', validation.reason, '\nRaw:', rawText.slice(0, 500));
            const fallback = this.getFallbackAnalysis(audioAnalysis);
            fallback.source = parsed ? 'fallback-schema-invalid' : 'fallback-parse-error';
            return fallback;
        } catch (error) {
            // Ningún fallback cruzado entre proveedores: si el activo falla, va
            // directo al fallback local. Groq y Gemini son modos explícitos y
            // se comparan limpios en el A/B.
            console.error(`${provider} no disponible → fallback local:`, error);
            const fallback = this.getFallbackAnalysis(audioAnalysis);
            fallback.source = 'fallback-network';
            return fallback;
        }
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

    async answerQuestion(audioAnalysis, aiAnalysis, question, chatHistory = []) {
        const q = String(question || '').trim();
        if (!q) return 'Escribí una pregunta para poder ayudarte.';

        const { systemPrompt, userPrompt } = this.buildQuestionPrompt(audioAnalysis, aiAnalysis, q, chatHistory);
        try {
            const text = await this.callAI(userPrompt, systemPrompt, { temperature: 0.6 });
            return text || this.getFallbackAnswer(audioAnalysis, aiAnalysis, q, true);
        } catch (error) {
            console.error(`AI Q&A no disponible (${AIAnalysisEngine._getProvider()} falló, sin fallback cruzado):`, error);
            return this.getFallbackAnswer(audioAnalysis, aiAnalysis, q, true);
        }
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

ARQUITECTURA (3 capas): (1) análisis local — Essentia/basic-pitch. (2) PERCEPCIÓN AUDITIVA — Gemini, cuando aparece en el userPrompt. (3) VOS — combinás capas + memoria en pedagogía útil. Nunca digas "escuché"; decí "los datos muestran" o hablá musicalmente. Si un dato no da para interpretación honesta, mejor "no se puede evaluar con estos datos" que inventar.

LAS 12 REGLAS (aplican todas):

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

        const userPrompt = `${reliabilityBlock ? reliabilityBlock + '\n\n' : ''}DATOS DE LA GRABACIÓN (ya en lenguaje musical — usalos así, NO los reconviertas a números):
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

    buildQuestionPrompt(audioAnalysis, aiAnalysis, question, chatHistory = []) {
        const safeAi = aiAnalysis && typeof aiAnalysis === 'object' ? aiAnalysis : {};
        const musicalAnalysis = String(safeAi.musicalAnalysis || '').slice(0, 800);
        const exerciseTitle = safeAi.practiceExercise?.title
            || (Array.isArray(safeAi.practiceSuggestions) ? safeAi.practiceSuggestions[0]?.title : '')
            || '';
        const nextGoal = String(safeAi.nextGoal || '').trim();
        const tempo = Number(audioAnalysis?.tempo?.bpm || audioAnalysis?.tempo || 0);
        const keyName = audioAnalysis?.key?.key || audioAnalysis?.pitch || 'Desconocida';
        const keyScale = audioAnalysis?.key?.scale || '';
        const keyStrength = Number(audioAnalysis?.key?.strength || 0);
        const tempoConfidence = Number(audioAnalysis?.tempo?.confidence || 0);
        const loudnessAvg = Number(audioAnalysis?.loudness?.average || audioAnalysis?.loudness?.db || 0);
        const dynamic = Number(audioAnalysis?.loudness?.dynamicComplexity || 0);

        const systemPrompt = `Sos NeuralJam, el asistente conversacional de PianoStudy. Cuando el usuario te pregunta acá, actuás como profesor de piano de JAZZ con 20 años de experiencia. Tu área principal es el jazz mainstream (bebop, cool, modal, post-bop, hard bop, standards, straight-ahead). También sabés de música afrocubana, latin jazz, jazz colombiano y bolero, pero NO son tu default. Si te preguntan quién sos, decís "NeuralJam" — sin describir tu apariencia.

TONO: reflexivo, honesto, directo. Voseo rioplatense, profesor guiando a un colega. Sin frases motivacionales vacías, sin relleno, sin "¡Excelente pregunta!" ni "¡Con gusto!". Empezá por la respuesta. Si no sabés algo o los datos son ambiguos, decilo. Si el estudiante está equivocado, corregilo con respeto, no le des la razón para no incomodar.

CONOCIMIENTO:
- Jazz: bebop y escalas bebop, ii-V-I y sustitución de tritono, modal, cool, post-bop, standards, compases irregulares (5/4, 7/4, 3/4 con swing), reharmonización, voicings (drop 2, rootless, quartal), walking bass en piano.
- Referentes: Bill Evans, Bud Powell, Monk, Herbie Hancock, McCoy Tyner, Chick Corea, Keith Jarrett, Oscar Peterson, Brad Mehldau, Dave Brubeck.
- Estilos afines: son cubano y clave, latin jazz, bolero, jazz colombiano.

REGLAS DE ESTILO Y CERTEZA:
- Si el estudiante no declaró estilo y las señales no son claras, NO le pongas etiqueta de género. Hablá técnico. Ante la duda: jazz.
- Si la confianza del tempo o la fuerza de tonalidad detectadas fueron bajas, aclará explícitamente que los datos son inciertos antes de afirmar cifrado o modo.

FORMATO DE RESPUESTA:
- 2-4 párrafos cortos, prosa. Sin encabezados ni bullets salvo que ayuden a describir un ejercicio paso a paso.
- Pasos concretos: BPM exacto o rango, compás, nombre de escala/modo, grado del acorde (ej. "ii-V-I en Do mayor: Dm7 → G7 → Cmaj7").
- Armonía: sugerí voicings concretos (qué notas, no solo el nombre del acorde) o la progresión completa.
- Técnica: posición de manos, digitación o movimiento específico.
- Si no tenés contexto suficiente, pedí que aclaren estilo/tonalidad/compás — es mejor preguntar que dar consejo vago.
- Referenciá el análisis previo, el ejercicio o el nextGoal cuando la pregunta se conecte con eso.`;

        // Últimos 6 turnos de conversación previa (excluyendo la pregunta actual que
        // se agrega abajo). Esto le permite al modelo entender "el ejercicio anterior"
        // o "y para eso último que me dijiste..." sin que se sienta perdido.
        const historyBlock = Array.isArray(chatHistory) && chatHistory.length
            ? `CONVERSACIÓN PREVIA (últimos turnos, orden cronológico):\n${chatHistory
                .slice(-6)
                .map(m => `${m.role === 'user' ? 'ESTUDIANTE' : 'NEURALJAM'}: ${String(m.text || '').slice(0, 500)}`)
                .join('\n')}\n`
            : '';

        const userPrompt = `CONTEXTO DE LA GRABACIÓN:
- Duración: ${(audioAnalysis?.duration ?? 0).toFixed(1)}s
- Tempo detectado: ${tempo} BPM (confianza ${(tempoConfidence * 100).toFixed(0)}%)
- Tonalidad estimada: ${keyName} ${keyScale} (fuerza ${(keyStrength * 100).toFixed(0)}%)
- Loudness promedio: ${loudnessAvg.toFixed(1)} dB
- Complejidad dinámica: ${dynamic.toFixed(2)} (0=plano, 1=muy dinámico)

ANÁLISIS PREVIO:
- Puntuación: ${safeAi.overallScore ?? 'N/A'}/10
- Análisis: ${musicalAnalysis}
${exerciseTitle ? `- Ejercicio recomendado: ${exerciseTitle}\n` : ''}${nextGoal ? `- Objetivo próxima sesión: ${nextGoal}\n` : ''}
${historyBlock}
PREGUNTA ACTUAL DEL ESTUDIANTE:
${question}`;

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
