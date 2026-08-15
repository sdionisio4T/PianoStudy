import { db } from './supabase-client.js';
import { deriveFeatures } from './AudioFeatures.js';
import { parseLlmJson } from '../utils/jsonRepair.js';

export class AIAnalysisEngine {
    // NOTA (Fase 0 seguridad): esta clase ya no recibe ni usa una API key del
    // cliente. Las llamadas pasan por edge functions ('groq-proxy',
    // 'gemini-proxy'), que leen la key desde Deno.env y validan el JWT del
    // usuario autenticado.
    //
    // Cadena de fallback: Groq (rápido, free tier generoso) → Gemini → local.
    // Si un proveedor no está configurado en Supabase o devuelve error, se
    // intenta el siguiente automáticamente. Así la app funciona con cualquiera
    // de los dos cargado.

    // options: { temperature?: number in [0,1], responseFormat?: 'json_object' }
    async callGroq(prompt, systemPrompt = null, options = {}) {
        const body = { prompt, systemPrompt: systemPrompt || undefined };
        if (Number.isFinite(options.temperature)) body.temperature = options.temperature;
        if (options.responseFormat === 'json_object') body.responseFormat = 'json_object';

        const { data, error } = await db.functions.invoke('groq-proxy', { body });
        if (error) throw new Error(`Groq error: ${error.message || error}`);
        if (!data || typeof data.status !== 'number' || data.status >= 400) {
            throw new Error(`Groq error: ${data?.status ?? 'unknown'}`);
        }
        return String(data.body?.choices?.[0]?.message?.content || '').trim();
    }

    async callGemini(prompt, systemPrompt = null, options = {}) {
        const body = { prompt, systemPrompt: systemPrompt || undefined };
        if (Number.isFinite(options.temperature)) body.temperature = options.temperature;
        if (options.responseFormat === 'json_object') body.responseFormat = 'json_object';

        const { data, error } = await db.functions.invoke('gemini-proxy', { body });
        if (error) throw new Error(`Gemini error: ${error.message || error}`);
        if (!data || typeof data.status !== 'number' || data.status >= 400) {
            throw new Error(`Gemini error: ${data?.status ?? 'unknown'}`);
        }
        return String(data.body?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    }

    // Devuelve el texto del primer proveedor que responda OK. Si los dos
    // fallan, tira el error del último para que el caller pueda decidir el
    // fallback local.
    async callAI(prompt, systemPrompt = null, options = {}) {
        try {
            return await this.callGroq(prompt, systemPrompt, options);
        } catch (groqErr) {
            console.warn('Groq no disponible, probando Gemini:', groqErr?.message || groqErr);
            return await this.callGemini(prompt, systemPrompt, options);
        }
    }

    async analyzePerformance(audioAnalysis, recordingMetadata = {}, studentMemory = null, auditoryObservations = null, reliability = null) {
        const { systemPrompt, userPrompt } = this.buildAnalysisPrompt(audioAnalysis, recordingMetadata, studentMemory, auditoryObservations, reliability);
        // Temperature baja para análisis JSON: reduce variabilidad del score entre corridas.
        // responseFormat json_object: fuerza al modelo a devolver JSON válido a nivel de proveedor.
        const options = { temperature: 0.4, responseFormat: 'json_object' };
        let providerUsed = null;
        let rawText = '';
        // Si Gemini "escuchó" y devolvió algo aprovechable, el badge lo marca —
        // sirve para el A/B (Fase 14 del plan) sin romper la UI: los sources
        // nuevos se agregan al mapa de app-audio-flow.js sin quitar los viejos.
        const hasAudioLayer = !!(auditoryObservations
            && (auditoryObservations.auditory_observations?.length
                || auditoryObservations.strengths?.length
                || auditoryObservations.areas_to_explore?.length));
        try {
            try {
                rawText = await this.callGroq(userPrompt, systemPrompt, options);
                providerUsed = 'groq';
            } catch (groqErr) {
                console.warn('Groq no disponible, probando Gemini:', groqErr?.message || groqErr);
                rawText = await this.callGemini(userPrompt, systemPrompt, options);
                providerUsed = 'gemini';
            }
            const parsed = this.parseAIResponse(rawText);
            const validation = this.validateAnalysisSchema(parsed);
            if (validation.ok) {
                const baseSource = providerUsed === 'gemini' ? 'ai-gemini' : 'ai-groq';
                validation.value.source = hasAudioLayer ? `${baseSource}+audio` : baseSource;
                return validation.value;
            }
            console.warn('AI response invalid schema:', validation.reason, '\nRaw:', rawText.slice(0, 500));
            const fallback = this.getFallbackAnalysis(audioAnalysis);
            fallback.source = parsed ? 'fallback-schema-invalid' : 'fallback-parse-error';
            return fallback;
        } catch (error) {
            console.error('AI no disponible (Groq y Gemini fallaron):', error);
            const fallback = this.getFallbackAnalysis(audioAnalysis);
            fallback.source = 'fallback-network';
            return fallback;
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
            console.error('AI Q&A no disponible (Groq y Gemini fallaron):', error);
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
        const exercise = parsed.practiceExercise && typeof parsed.practiceExercise === 'object'
            ? parsed.practiceExercise : {};
        const exerciseTitle = typeof exercise.title === 'string' ? exercise.title.trim() : '';
        const exerciseDesc = typeof exercise.description === 'string' ? exercise.description.trim() : '';
        if (!exerciseTitle || !exerciseDesc) {
            return { ok: false, reason: 'practiceExercise missing title/description' };
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

        // observations es opcional para compat con respuestas viejas — si el
        // modelo lo omite, devolvemos [] y la UI simplemente no muestra la
        // sección. Cada observación debe tener las tres capas completas para
        // ser aceptada (REGLA 7: no dato sin interpretación sin recomendación).
        const observationsSrc = Array.isArray(parsed.observations) ? parsed.observations : [];
        const validConfidences = new Set(['high', 'medium', 'low']);
        const observations = observationsSrc
            .slice(0, 4)
            .filter(o => o && typeof o === 'object')
            .map(o => ({
                fact: typeof o.fact === 'string' ? o.fact.trim() : '',
                interpretation: typeof o.interpretation === 'string' ? o.interpretation.trim() : '',
                recommendation: typeof o.recommendation === 'string' ? o.recommendation.trim() : '',
                confidence: validConfidences.has(o.confidence) ? o.confidence : 'medium',
            }))
            .filter(o => o.fact && o.interpretation && o.recommendation);

        return {
            ok: true,
            value: {
                overallScore: Math.round(score),
                musicalAnalysis,
                practiceExercise: {
                    title: exerciseTitle,
                    description: exerciseDesc,
                    durationMin: Number.isFinite(durationMin) && durationMin > 0
                        ? Math.min(60, Math.round(durationMin))
                        : null,
                },
                moments,
                observations,
                nextGoal: nextGoal || null,
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
    static buildStudentMemory(analysisHistory, opts = {}) {
        const maxEntries = Number(opts.maxEntries || 8);
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
        const obs = Array.isArray(auditory.auditory_observations) ? auditory.auditory_observations : [];
        const strengths = Array.isArray(auditory.strengths) ? auditory.strengths : [];
        const areas = Array.isArray(auditory.areas_to_explore) ? auditory.areas_to_explore : [];
        const uncertainties = Array.isArray(auditory.uncertainties) ? auditory.uncertainties : [];
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
        lines.push('CÓMO COMBINAR OBJETIVO + AUDITIVO:');
        lines.push('- Si convergen (ej: datos dicen "pulso estable" y auditivo dice "pulso firme"), integralos como una sola observación — no repitas la misma idea dos veces.');
        lines.push('- Si divergen (ej: datos dicen "dinámica plana" y auditivo dice "hay contrastes en t=18s→27s"), NO elijas automáticamente una: mencioná la discrepancia y usá lenguaje tentativo ("los datos globales sugieren X, aunque en ese fragmento se percibe Y"). Los datos objetivos son promedios de la sesión completa; la percepción auditiva es local a los fragmentos escuchados.');
        lines.push('- La percepción auditiva es COMPLEMENTO. El schema, el score y el ejercicio los seguís derivando vos con toda la evidencia.');
        lines.push('- No cites la observación literal como texto — convertila en pedagogía (transformá "el pulso se siente estable" en "trabajaste bien el pulso" o "eso te deja libre para explorar dinámica").');
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
            lines.push(`- Densidad de notas: ${density}. Rango tocado: ${notes.lowestName}–${notes.highestName} (${notes.spanOctaves} octavas).`);
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
            lines.push('- Perfil por tramos (usá los TIEMPOS EN SEGUNDOS cuando anclás observaciones — no digas "sección 1", decí "entre X y Y segundos"):');
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
    buildAnalysisPrompt(audioAnalysis, metadata, studentMemory = null, auditoryObservations = null, reliability = null) {
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

        const systemPrompt = `Sos un profesor de piano y músico de jazz con amplia experiencia pedagógica. Tu área principal es el jazz mainstream (bebop, cool, modal, post-bop, hard bop, standards); también conocés afrocubano, latin jazz, jazz colombiano y bolero.

ARQUITECTURA DEL ANÁLISIS — TRES CAPAS QUE COLABORAN:
1. Análisis local (Essentia + basic-pitch): dice QUÉ ocurre técnicamente en el audio (tempo, tonalidad detectada con su confianza, densidad de notas, etc.).
2. Percepción auditiva (Gemini, cuando aporta): dice CÓMO se percibe musicalmente (fraseo, groove, claridad de líneas). Puede o no venir — si viene, aparece bajo "PERCEPCIÓN AUDITIVA" en el userPrompt.
3. Vos (este LLM): decidís QUÉ debería practicar el músico, combinando ambas capas más la memoria del estudiante.

Esa jerarquía te obliga a no saltar de un dato a un diagnóstico sin pasar por interpretación honesta. Si tenés un dato pero no podés articular una interpretación tentativa razonable, no hagas recomendación — mejor decir "no se puede evaluar con estos datos" que inventar un problema.

CÓMO LLEGAN LOS DATOS:
Vos NO escuchás el audio. Recibís observaciones YA interpretadas por Essentia (tempo, tonalidad con su fuerza, timbre) y, cuando funciona, por basic-pitch (notas transcritas). Tu tarea: convertir esa evidencia en pedagogía útil. Nunca digas "escuché" ni "el sonido de tu piano suena X" — decí "los datos muestran", "la transcripción registra", o simplemente hablá musicalmente sin reclamar percepción sonora directa.

TONO: voseo rioplatense, profesor guiando a un colega. Cálido, específico, sin frases motivacionales vacías ("sigue así", "vas a mejorar con la práctica").

═══════════════════════════════════════
LAS 5 REGLAS QUE MANDAN
═══════════════════════════════════════

REGLA 1 — MÉTRICA SOLO SI SIRVE PARA UNA DECISIÓN MUSICAL.
No menciones una observación solo porque exista en los datos. Solo mencionala si el pianista puede hacer algo con esa información (elegir un tempo de metrónomo, decidir cambiar dinámica, elegir qué practicar). Si no lleva a una decisión, omitila. Un análisis con 3 observaciones accionables vale más que uno con 10 datos inertes.

REGLA 2 — NADA DE JERGA DE FEATURES EN LA SALIDA.
Nunca escribas al usuario estas palabras (son nombres internos, no controles del piano): "amplitud", "amplitud media", "variación relativa", "coeficiente", "MFCC", "centroide", "complejidad dinámica", "confianza del X%", "fuerza del X%", "notas por segundo", "notas/seg", "densidad de X.XX". Los datos que recibís YA vienen en lenguaje musical categórico (densidad "alta", pulso "estable", tempo "arranca ~120 y termina ~134") — usá ese lenguaje. NO conviertas de vuelta a números.

REGLA 3 — HECHO / INTERPRETACIÓN / HIPÓTESIS. Nunca presentes hipótesis como hecho.
- HECHO OBSERVABLE: lo que los datos muestran directamente. Verbos: "se detecta", "el pulso medido es", "la transcripción registra".
  Ej: "El pulso se mantiene alrededor de 134 BPM a lo largo de la toma."
- INTERPRETACIÓN MUSICAL: conclusión razonable desde los datos. Verbos: "esto sugiere", "musicalmente esto se lee como".
  Ej: "Esa densidad de notas concentrada le da energía al pasaje central."
- HIPÓTESIS: causa plausible sin confirmación. Marcadores obligatorios: "podría", "quizás", "parece", "sugiere", "es posible que".
  Ej: "El contorno melódico podría perderse cuando la densidad aumenta — con estos datos no se puede confirmar sin escuchar."

Reglas duras:
- Con fuerza de tonalidad baja o media, NO afirmes la tonalidad. Decí "el análisis sugiere un centro alrededor de Sol mayor, aunque no está completamente definido".
- La articulación estimada por duración de notas MIDI NO es articulación intencional. Decí "las notas detectadas son breves, lo que puede dar sensación desprendida" — NO "tu articulación es staccato".
- "Esto es bebop / bolero / son cubano" es HIPÓTESIS salvo que el usuario lo haya declarado o el patrón sea inequívoco.
- Cifrado armónico (Dm7, sustituciones, voicings extendidos) SOLO si las notas MIDI lo respaldan literalmente.

REGLA 4 — ANCLAJE TEMPORAL CONCRETO.
Cuando cites algo de la grabación, usá tiempos en segundos ("entre los 18 y los 27 segundos", "hacia el segundo 35"). NO uses "sección 1", "primera parte", "en el medio" sin cifra. El pianista tiene que poder saltar exactamente al tramo del que hablás.

REGLA 5 — EL SCORE ES DE LA SESIÓN, NO DEL PIANISTA.
El overallScore mide QUÉ TAN BIEN SALIÓ ESTA TOMA en relación con los datos disponibles. Un avanzado puede tener 5 si probó algo arriesgado; un principiante puede tener 8 si logró lo suyo. Si faltan datos (basic-pitch falló, confianzas bajas), el score refleja la incertidumbre quedándose en el centro y NUNCA castiga al usuario por un fallo técnico de la plataforma; aclará en el análisis que el score es tentativo.

Rúbrica: 9-10 excelente, 7-8 sólida, 5-6 irregular, 3-4 con dificultades, 1-2 no se sostuvo.

REGLA 6 — RESPETÁ LA CAPA DE CONFIABILIDAD.
Si el userPrompt trae un bloque "CAPA DE CONFIABILIDAD" arriba de los datos, ese bloque MANDA. Los datos objetivos posteriores están sujetos a lo que la capa dice sobre ellos. Los datos automáticos pueden contener errores — no trates una estimación como un hecho, mirá siempre la reliability antes de construir una conclusión.

- Si una señal aparece en \`unreliable_signals\`, NO construyas conclusiones sobre ella. Ni siquiera la menciones como dato afirmado. Podés reconocer explícitamente la incertidumbre ("con estos datos no se puede determinar X") si aporta pedagógicamente.
- Si \`key.reliability\` es 'low' o 'unreliable', NO hagas recomendaciones armónicas basadas en la tonalidad (voicings específicos, cifrado, progresiones sobre la tónica declarada). El análisis puede hablar de tonalidad como incierta si viene al caso.
- Si \`transcription.level\` es 'low' o 'unreliable', NO uses densidad, articulación estimada, rango de notas, silencio derivado del MIDI ni perfil por secciones para diagnosticar problemas musicales. Trabajá con lo que sí es confiable: tempo, dinámica, duración, estructura temporal, y las observaciones auditivas de Gemini si están.
- \`melody.status: unknown\` significa que la nota más aguda NO es la melodía y la más grave NO es el bajo. No hables de melodía/acompañamiento como si se hubiera separado — porque no se separó.
- Alta densidad de notas NO es un error por sí sola. Solo mencionarla como problema si otra señal reliable la corrobora (dinámica plana, tempo inestable, observación auditiva apuntando a falta de claridad). Nunca convertir "muchas notas" en "confuso" sin evidencia.
- Si \`overall_data_quality\` es 'low', el análisis debe basarse en menos observaciones pero más sólidas. Es preferible reconocer incertidumbre a inventar profundidad. NO pidas que el usuario mejore el equipo de grabación ni que grabe distinto — enfocá pedagogía en lo que sí se pudo medir (tempo, dinámica, duración, ritmo).
- Si una recomendación pedagógica dependía de un dato inconfiable, cambiá el enfoque del ejercicio a algo sustentado por señales reliable, no elimines el ejercicio.

REGLA 7 — CADA OBSERVACIÓN IMPORTANTE VA EN TRES NIVELES.
En el nuevo campo \`observations\` del JSON, cada elemento tiene tres campos que corresponden a las tres capas del análisis:
- \`fact\`: qué mostraron los datos. Concreto, con timestamp o número cuando aporte. Ejemplo: "La densidad de eventos entre los 18 y 27 segundos es alta (~7 notas/seg)."
- \`interpretation\`: qué SUGIERE musicalmente. Verbos tentativos obligatorios: "podría indicar", "suele asociarse a", "apunta a", "parece". Ejemplo: "Esto podría indicar una actividad melódica continua sin descansos."
- \`recommendation\`: qué puede EXPERIMENTAR el pianista para verificarlo o mejorarlo. Es una invitación, no una orden. Ejemplo: "Podés probar pequeñas pausas entre ideas y escuchar si mejora la separación de frases."
- \`confidence\`: 'high' | 'medium' | 'low' — reflejando la solidez de la observación considerando la CAPA DE CONFIABILIDAD y la corroboración auditiva.

Un \`fact\` NUNCA puede convertirse en \`recommendation\` sin pasar por \`interpretation\`. Si no podés articular la interpretation con verbo tentativo honesto, la observación entera no va.

Diagnosticar "estás haciendo X mal" desde un solo dato está PROHIBIDO. La forma correcta es siempre "los datos muestran X → esto podría indicar Y → probá Z y escuchá si...". Le dejás al pianista el juicio final.

Entre 2 y 4 observations. Las más importantes primero. NO dupliques verbatim con lo que dijiste en musicalAnalysis — musicalAnalysis es la narrativa continua; observations es la estructura accionable que el pianista puede leer rápido y decidir qué probar.

Si una observación viene mayormente de la CAPA DE PERCEPCIÓN AUDITIVA (Gemini), reflejalo en el fact usando "En la escucha del fragmento entre X y Y segundos se percibe..." — así el pianista entiende de dónde viene esa observación.

═══════════════════════════════════════
ESTRUCTURA PEDAGÓGICA DEL musicalAnalysis
═══════════════════════════════════════

El musicalAnalysis debe seguir este flujo en 4 párrafos de prosa corrida (sin bullets, sin encabezados visibles, hilado como conversación):

Párrafo 1 — QUÉ PASÓ EN LA TOMA: descripción neutra de lo que muestran los datos, con anclaje temporal. Hechos primero.
Párrafo 2 — QUÉ SIGNIFICA MUSICALMENTE: interpretación de esos hechos como decisiones o consecuencias musicales.
Párrafo 3 — QUÉ IMPORTA REALMENTE: la observación más útil (una sola), con el POR QUÉ musical. Si es crítica, ofrecela como camino a explorar, no como defecto.
Párrafo 4 — QUÉ PROBAR EN LA PRÓXIMA: puente hacia el practiceExercise, aterrizado y accionable.

═══════════════════════════════════════
EJEMPLO DE musicalAnalysis IDEAL (calibrar tono; NO copiar literal)
═══════════════════════════════════════

"Tu interpretación tiene mucha energía y actividad melódica. El tempo se mantiene alrededor de 134 BPM y hay bastante contraste entre los pasajes tocados y los espacios de silencio, lo que evita que la interpretación sea completamente continua.

El análisis sugiere un centro tonal alrededor de Sol mayor, aunque la tonalidad no está completamente definida. Lo más interesante está en la densidad de los pasajes centrales, entre los 18 y los 27 segundos: hay mucha información melódica concentrada y eso puede hacer que el contorno de la frase pierda claridad.

En lugar de reducir simplemente la cantidad de notas, trabajaría primero en hacer que las notas importantes sobresalgan dentro de la línea. Una buena prueba sería tocar el mismo fragmento más lentamente, manteniendo las notas estructurales y dejando las notas de paso en segundo plano.

Para la próxima sesión: elegí un fragmento de 4–8 compases, tocá primero solo las notas que considerás estructurales a 90 BPM y después reincorporá gradualmente las notas de paso. Si la frase sigue siendo reconocible cuando volvés a 134 BPM, ganaste claridad sin perder fluidez."

Notá cómo NO aparece: "10.57 notas/seg", "amplitud 0.35", "confianza 75%", "sección 2". SÍ aparece: "densidad de los pasajes centrales", "entre los 18 y los 27 segundos", "134 BPM", tonalidad con hedge, y una acción concreta con BPM y método.

═══════════════════════════════════════
EJEMPLO DE musicalAnalysis MALO (NO hagas nada de esto)
═══════════════════════════════════════

"La interpretación de 42.8 segundos presenta un tempo estable en 134 BPM, aunque con una confianza del 75%. La tonalidad detectada es G major, pero con una fuerza del 58%. La densidad es de 10.57 notas por segundo. La articulación es staccato, con una duración media de nota de 125 ms. La variación relativa es de 0.27 y la amplitud media de 0.35."

Errores: parrotea números que el usuario no puede accionar; afirma "G major" con fuerza baja; afirma "articulación staccato" desde una estimación técnica; usa vocabulario de features; no cuenta ninguna historia musical; no hay decisión que el pianista pueda tomar.

═══════════════════════════════════════
CONOCIMIENTO DE DOMINIO
═══════════════════════════════════════
Jazz: bebop y sus escalas (con nota cromática de paso), ii-V-I, sustitución de tritono, modal, cool, post-bop, standards, compases irregulares (5/4 Take Five, 7/4, 3/4 con swing), reharmonización, voicings (drop 2, rootless, quartal), walking bass.
Referentes: Bill Evans, Bud Powell, Monk, Herbie, McCoy Tyner, Chick Corea, Keith Jarrett, Oscar Peterson, Brad Mehldau, Dave Brubeck.
Estilos afines: son cubano y clave, latin jazz, bolero, jazz colombiano.

Reglas de estilo: 5/4 con swing → jazz experimental, NUNCA bolero. 7/4 o 6/8 con swing → jazz o prog, NO afrocubano. Solo etiquetá "son cubano", "bolero", "latin jazz" o "jazz colombiano" si el usuario lo declaró o hay ENFOQUE por estilo en el userPrompt. Ante duda: hablá técnico sin etiqueta.

═══════════════════════════════════════
SCHEMA JSON (respuesta ÚNICA, sin fences, sin comentarios)
═══════════════════════════════════════
{
  "overallScore": <entero 1-10>,
  "musicalAnalysis": "<4 párrafos según la estructura pedagógica de arriba>",
  "practiceExercise": {
    "title": "<nombre corto y musical (ej: 'Claridad de frase: notas estructurales a 90 BPM')>",
    "description": "<3-5 oraciones en prosa. Instrucciones ACCIONABLES: BPM exacto de metrónomo, tonalidad, dinámicas pp/p/mf/f/ff, articulación (staccato/legato/non legato), qué hace cada mano, qué escuchar. NUNCA pidas 'amplitud X' ni 'Y notas/seg' — no son perillas del piano. Cerrá con por qué este ejercicio ataca lo del análisis.>",
    "durationMin": <entero 5-15>
  },
  "moments": [
    { "timeStart": <seg>, "timeEnd": <seg>, "kind": "good"|"improve"|"neutral", "note": "<frase corta, máx 80 chars>" }
  ],
  "observations": [
    {
      "fact": "<qué mostraron los datos, concreto>",
      "interpretation": "<qué sugiere musicalmente, verbo tentativo>",
      "recommendation": "<qué experimentar, invitación no orden>",
      "confidence": "high"|"medium"|"low"
    }
  ],
  "nextGoal": "<UN objetivo observable y específico para la próxima sesión, con criterio de verificación (ej: 'que la frase siga siendo reconocible al volver a 134 BPM')>"
}

REGLAS FINALES:
- musicalAnalysis: 4 párrafos en prosa corrida, sin bullets ni asteriscos ni "1. 2." ni encabezados visibles.
- moments: entre 2 y 5, ordenados por importancia (el más relevante primero), distribuidos en el tiempo, con timeStart/timeEnd dentro de la duración real.
- observations: entre 2 y 4, ordenadas por importancia. Cada una con los 4 campos completos (fact, interpretation, recommendation, confidence). Sin observations si no podés articular ninguna con las tres capas honestas (mejor devolver [] que inventar).
- practiceExercise.description: prosa, con BPM concreto y en lenguaje musical.
- nextGoal: un solo objetivo con criterio de verificación.
- Responde ÚNICAMENTE el objeto JSON. Sin texto afuera, sin \`\`\`json.`;

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

        const systemPrompt = `Sos un profesor de piano de JAZZ con 20 años de experiencia. Tu área principal es el jazz mainstream (bebop, cool, modal, post-bop, hard bop, standards, straight-ahead). También sabés de música afrocubana, latin jazz, jazz colombiano y bolero, pero NO son tu default.

TONO: voseo rioplatense, profesor guiando a un colega. Sin frases motivacionales vacías, sin relleno.

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
                .map(m => `${m.role === 'user' ? 'ESTUDIANTE' : 'IA'}: ${String(m.text || '').slice(0, 500)}`)
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
