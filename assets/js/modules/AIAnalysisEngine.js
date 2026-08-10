import { db } from './supabase-client.js';

export class AIAnalysisEngine {
    // NOTA (Fase 0 seguridad): esta clase ya no recibe ni usa una API key del
    // cliente. Las llamadas a Gemini pasan por el edge function 'gemini-proxy',
    // que lee la key desde Deno.env y valida el JWT del usuario autenticado.
    async callGemini(prompt, systemPrompt = null) {
        const { data, error } = await db.functions.invoke('gemini-proxy', {
            body: { prompt, systemPrompt: systemPrompt || undefined }
        });

        if (error) {
            throw new Error(`API error: ${error.message || error}`);
        }
        if (!data || typeof data.status !== 'number' || data.status >= 400) {
            throw new Error(`API error: ${data?.status ?? 'unknown'}`);
        }

        return data.body;
    }

    async analyzePerformance(audioAnalysis, recordingMetadata = {}) {
        const prompt = this.buildAnalysisPrompt(audioAnalysis, recordingMetadata);
        try {
            const data = await this.callGemini(prompt);
            const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            const analysis = this.parseAIResponse(text);
            return analysis || this.getFallbackAnalysis(audioAnalysis);
        } catch (error) {
            console.error('Error calling Gemini API:', error);
            return this.getFallbackAnalysis(audioAnalysis);
        }
    }

    async answerQuestion(audioAnalysis, aiAnalysis, question) {
        const q = String(question || '').trim();
        if (!q) return 'Escribe una pregunta para poder ayudarte.';

        const prompt = this.buildQuestionPrompt(audioAnalysis, aiAnalysis, q);
        try {
            const data = await this.callGemini(prompt);
            const text = String(data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
            return text || this.getFallbackAnswer(audioAnalysis, aiAnalysis, q);
        } catch (error) {
            console.error('Error calling Gemini API (Q&A):', error);
            return this.getFallbackAnswer(audioAnalysis, aiAnalysis, q);
        }
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

    buildAnalysisPrompt(audioAnalysis, metadata) {
        const tempo = audioAnalysis?.tempo || {};
        const key = audioAnalysis?.key || {};
        const loudness = audioAnalysis?.loudness || {};
        const mfcc = Array.isArray(audioAnalysis?.mfcc) ? audioAnalysis.mfcc : [];
        const spectralCentroid = Number(audioAnalysis?.spectralCentroid || 0);
        const rhythmicComplexity = Number(audioAnalysis?.rhythmicComplexity || 0);

        const styleKey = String(metadata?.style || '').toLowerCase().replace(/[\s_-]/g, '');
        const styleGuidance = AIAnalysisEngine.STYLE_GUIDANCE[styleKey] || '';

        return `Eres un profesor de piano jazz y música afrocubana con 20 años de experiencia docente, especializado también en jazz colombiano — un área donde hay muy poco material pedagógico disponible, así que tu criterio ahí vale especialmente.
Tienes conocimiento profundo de:
- Estilos: son cubano, mambo, chachachá, guaguancó, bolero, jazz latino, bebop, hard bop, blues, jazz colombiano (bambuco/currulao fusionados con jazz)
- Técnicas pianísticas: montuno, tumbao, voicings de jazz (drop 2, rootless), clave 3-2 y 2-3, comping, encierres cromáticos (enclosures), walking bass en piano
- Teoría aplicada: modos (dórico, frigio, lidio), escalas bebop, progresiones ii-V-I, sustitución de tritono, tensiones y reharmonización
- Referentes: Chucho Valdés, Gonzalo Rubalcaba, Irakere, Benny Moré, Oscar Peterson, Bill Evans, Bud Powell, Thelonious Monk, Michel Camilo, Edy Martínez, Antonio Arnedo
- Pedagogía: método progresivo, ejercicios técnicos específicos por nivel

MÉTRICAS REALES DEL AUDIO:
- Duración: ${Number(audioAnalysis?.duration || 0).toFixed(1)} segundos
- Tempo: ${Math.round(Number(tempo.bpm || 0))} BPM (confianza: ${(Number(tempo.confidence || 0) * 100).toFixed(0)}%)
- Tonalidad detectada: ${key.key || 'Desconocida'} ${key.scale || ''} (fuerza: ${(Number(key.strength || 0) * 100).toFixed(0)}%)
- Loudness promedio: ${Number(loudness.average || 0).toFixed(2)} dB
- Complejidad dinámica: ${Number(loudness.dynamicComplexity || 0).toFixed(2)} (0=plano, 1=muy dinámico)
- Centroide espectral: ${spectralCentroid.toFixed(0)} Hz
- Variabilidad rítmica: ${rhythmicComplexity.toFixed(2)}
- Coeficientes MFCC (timbre): ${mfcc.slice(0, 5).map(v => Number(v).toFixed(2)).join(', ')}

${metadata.style ? `Estilo musical declarado por el músico: ${metadata.style}` : 'El músico no declaró un estilo — infiere el más probable a partir del tempo y las métricas, y decilo explícitamente en tu análisis.'}
${metadata.notes ? `Notas del músico: ${metadata.notes}` : ''}
${styleGuidance ? `\n${styleGuidance}\n` : ''}

REGLAS DE INTERPRETACIÓN MUSICAL:
- Tempo 50-70 BPM: apropiado para bolero o balada jazz, sugiere trabajar expresión y fraseo cantabile
- Tempo 80-110 BPM: zona de mambo, chachachá o jazz medio, evalúa estabilidad del pulso
- Tempo 120-160 BPM: zona de son cubano animado o bebop, evalúa precisión técnica
- Tempo >160 BPM: territorio rápido, comenta sobre control y claridad de notas
- Si complejidad dinámica < 0.3: la interpretación suena plana, sugiere trabajo en contrastes pp/ff
- Si variabilidad rítmica > 0.4: hay inconsistencia en el pulso, recomienda metrónomo y subdivisión
- Si confianza del tempo < 0.5: no hagas afirmaciones fuertes sobre el ritmo
- Si tonalidad es menor: menciona posibilidades de escala dórica o frigia según el estilo
- Si centroide espectral > 3000 Hz: el sonido es brillante, puede indicar mucho uso del registro agudo
- Si centroide espectral < 1500 Hz: predomina el registro grave, evalúa balance entre manos
- Si hay guía de ENFOQUE por estilo arriba: priorizala sobre las reglas genéricas de tempo — es más específica y relevante que las bandas de BPM.

Responde estrictamente en JSON con esta estructura:
{
  "overallScore": número 1-10,
  "musicalAnalysis": "párrafo interpretando las métricas en términos musicales humanos y concretos, mencionando estilo y contexto afrocubano/jazz/colombiano cuando aplique",
  "positiveAspects": ["aspecto específico 1", "aspecto específico 2", "aspecto específico 3"],
  "areasToImprove": ["mejora concreta 1 con ejercicio sugerido", "mejora concreta 2", "mejora concreta 3"],
  "practiceSuggestions": [
    { "title": "nombre del ejercicio", "description": "descripción detallada con BPM, compás y técnica específica" },
    { "title": "nombre del ejercicio", "description": "descripción detallada" }
  ]
}

Reglas de respuesta:
- Sé específico: no digas "practica más" sino "practica el montuno en Fa mayor a 80 BPM"
- Usa vocabulario musical real y preciso: articulación, fraseo, voicing, clave, swing, enclosure, ii-V-I, etc. — evita generalidades vagas tipo "suena bien" o "necesita mejorar"
- Adapta el feedback al ENFOQUE de estilo si está presente arriba; si no, al estilo detectado por tempo/métricas
- Cada practiceSuggestion tiene que incluir un BPM o rango de BPM concreto y, si aplica, tonalidad o compás
- Responde ÚNICAMENTE con el objeto JSON. Sin explicación antes o después, sin \`\`\`json ni ningún otro bloque de código, sin comentarios — el texto completo de tu respuesta debe poder pasarse directo a JSON.parse()`;
    }

    buildQuestionPrompt(audioAnalysis, aiAnalysis, question) {
        const safeAi = aiAnalysis && typeof aiAnalysis === 'object' ? aiAnalysis : {};
        const positives = Array.isArray(safeAi.positiveAspects) ? safeAi.positiveAspects : [];
        const improve = Array.isArray(safeAi.areasToImprove) ? safeAi.areasToImprove : [];
        const suggestions = Array.isArray(safeAi.practiceSuggestions) ? safeAi.practiceSuggestions : [];
        const tempo = Number(audioAnalysis?.tempo?.bpm || audioAnalysis?.tempo || 0);
        const keyName = audioAnalysis?.key?.key || audioAnalysis?.pitch || 'Desconocida';
        const keyScale = audioAnalysis?.key?.scale || '';
        const loudnessAvg = Number(audioAnalysis?.loudness?.average || audioAnalysis?.loudness?.db || 0);
        const dynamic = Number(audioAnalysis?.loudness?.dynamicComplexity || 0);

        return `Eres un profesor de piano jazz y música afrocubana con 20 años de experiencia, especializado también en jazz colombiano.
Tu conocimiento incluye:
- Técnicas: montuno, tumbao, voicings (drop 2, rootless), clave 3-2 y 2-3, comping, walking bass en piano, encierres cromáticos (enclosures)
- Teoría: modos, escalas bebop, progresiones ii-V-I, sustitución de tritono, tensiones, armonía funcional y reharmonización
- Estilos con enfoque particular: son cubano y montuno (clave), bebop (líneas cromáticas y ii-V-I), latin jazz (fusión armonía jazz + ritmo afrocubano), jazz colombiano (bambuco/currulao + jazz), bolero (fraseo rubato)
- Pedagogía: ejercicios graduales, práctica con metrónomo, análisis de grabaciones
- Referentes: Chucho Valdés, Gonzalo Rubalcaba, Oscar Peterson, Herbie Hancock, Benny Moré, Bud Powell, Michel Camilo, Edy Martínez, Antonio Arnedo

CONTEXTO DE LA SESIÓN:
- Duración grabación: ${(audioAnalysis?.duration ?? 0).toFixed(1)}s
- Tempo detectado: ${tempo} BPM
- Tonalidad estimada: ${keyName} ${keyScale}
- Loudness promedio: ${loudnessAvg.toFixed(1)} dB
- Complejidad dinámica: ${dynamic.toFixed(2)} (0=plano, 1=muy dinámico)

ANÁLISIS PREVIO:
- Puntuación: ${safeAi.overallScore ?? 'N/A'}/10
- Puntos positivos: ${positives.slice(0, 3).join(' | ')}
- Áreas de mejora: ${improve.slice(0, 3).join(' | ')}
- Ejercicios sugeridos: ${suggestions.slice(0, 3).map(s => s?.title).filter(Boolean).join(' | ')}

PREGUNTA DEL ESTUDIANTE:
${question}

INSTRUCCIONES DE RESPUESTA:
- Responde en español, de forma clara y motivadora, sin relleno ni frases genéricas de ánimo vacías
- Da pasos concretos y específicos: BPM exacto o rango, compás, nombre de escala/modo, grado del acorde (ej. "ii-V-I en Do mayor: Dm7 - G7 - Cmaj7")
- Si la pregunta es sobre ritmo o groove, identificá primero de qué estilo se trata (son cubano, bebop, latin jazz, jazz colombiano, bolero, etc.) antes de responder, y mencioná la clave o célula rítmica tradicional correspondiente si aplica — si no está claro, preguntá el estilo en vez de asumir uno genérico
- Si es sobre armonía, sugerí voicings concretos (qué notas, no solo el nombre del acorde) o la progresión completa
- Si es sobre técnica, describí posición de manos, digitación o movimiento específico
- Formato: 2-4 párrafos cortos, sin encabezados ni bullets salvo que ayuden a un ejercicio paso a paso
- Si no tenés suficiente contexto para una respuesta específica, pedí al estudiante que aclare el estilo, la tonalidad o el compás antes de dar una respuesta genérica — es mejor preguntar que dar un consejo vago`;
    }

    getFallbackAnswer(audioAnalysis, aiAnalysis, question) {
        const q = String(question || '').toLowerCase();
        const tempo = Number(audioAnalysis?.tempo?.bpm || audioAnalysis?.tempo || 0);
        const level = Number(audioAnalysis?.loudness?.dynamicComplexity || 0);
        const score = aiAnalysis?.overallScore;

        if (q.includes('tempo') || q.includes('ritmo') || q.includes('metrónomo') || q.includes('metronomo')) {
            return `Sobre el tempo: te detecté aprox. ${tempo} BPM.\n\nPrueba esto:\n1) Metrónomo en negras a ${Math.round(tempo * 0.8)} BPM (80%) y toca sin parar 2 minutos.\n2) Sube a ${tempo} BPM y repite.\n3) Si te aceleras, cambia el metrónomo a corcheas (subdivide) por 1 minuto.\n\nSi me dices qué parte se te va (inicio/medio/final), te propongo un ejercicio más específico.`;
        }

        if (q.includes('dinam') || q.includes('volumen') || q.includes('fuerte') || q.includes('suave')) {
            const dynHint = level < 0.3
                ? 'La interpretación parece algo plana en dinámicas.'
                : 'Hay variación dinámica aprovechable.';
            return `Sobre dinámica/volumen: ${dynHint}\n\nEjercicio rápido:\n- Toca una misma frase 5 veces: pp, p, mf, f, ff.\n- Mantén el tempo fijo y cambia solo el peso del brazo y la velocidad del ataque.\n\nSi quieres, dime qué estilo estás tocando (blues/bebop/bolero/latin) y ajusto la sugerencia.`;
        }

        return `Puedo ayudarte con esa pregunta.\n\nCon lo que tengo (sin audio), sé que tu grabación dura ${audioAnalysis.duration?.toFixed?.(1) ?? 'N/A'}s, tempo aprox. ${tempo} BPM y score ${score ?? 'N/A'}/10.\n\nPara afinar la respuesta, dime:\n- ¿Qué estabas practicando (tema/lick/estilo)?\n- ¿Qué te salió mal exactamente (tempo, notas, coordinación, swing, voicings, mano izquierda)?`;
    }

    parseAIResponse(text) {
        try {
            const jsonMatch = String(text || '').match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
            return JSON.parse(text);
        } catch (error) {
            console.error('Error parsing AI response:', error);
            return null;
        }
    }

    getFallbackAnalysis(audioAnalysis) {
        const tempoBpm = Number(audioAnalysis?.tempo?.bpm || audioAnalysis?.tempo || 0);
        const dynamic = Number(audioAnalysis?.loudness?.dynamicComplexity || 0);
        const loudnessFeedback = dynamic < 0.3
            ? 'La dinámica suena relativamente plana; conviene ampliar contrastes.'
            : 'Se aprecia una dinámica con cierto movimiento.';
        const tempoFeedback = this.getTempoFeedback(tempoBpm);

        return {
            overallScore: 7,
            musicalAnalysis: `Interpretación de ${audioAnalysis.duration.toFixed(1)} segundos. ${tempoFeedback} ${loudnessFeedback} La grabación muestra elementos técnicos sólidos con espacio para desarrollo expresivo.`,
            positiveAspects: [
                'Mantuviste un tempo relativamente estable durante la interpretación',
                'La claridad en la ejecución de las notas es evidente',
                'Hay control básico de la dinámica'
            ],
            areasToImprove: [
                'Trabajar en mayor variación dinámica para expresividad',
                'Explorar diferentes articulaciones y fraseos',
                'Desarrollar más confianza en el manejo del tempo'
            ],
            practiceSuggestions: [
                {
                    title: 'Practica con metrónomo',
                    description: `Tu tempo de ${tempoBpm} BPM es un buen punto de partida. Practica a diferentes velocidades: 80%, 100% y 120% de este tempo.`
                },
                {
                    title: 'Ejercicios de dinámica',
                    description: 'Toca la misma frase a diferentes volúmenes (pp, p, mf, f, ff) para desarrollar control dinámico.'
                },
                {
                    title: 'Graba y compara',
                    description: 'Graba la misma pieza múltiples veces y compara las interpretaciones para identificar áreas de mejora.'
                }
            ]
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
