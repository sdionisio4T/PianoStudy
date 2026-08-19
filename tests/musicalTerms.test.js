import { describe, it, expect } from 'vitest';
import { MUSICAL_TERMS, getRelevantMusicalTerms, groupTermsByCategory } from '../assets/js/data/musicalTerms.js';
import { AIAnalysisEngine } from '../assets/js/modules/AIAnalysisEngine.js';

// Helper: auditory observations plausibles para tests que necesitan escucha.
const baseAuditory = () => ({
    auditory_observations: [
        { type: 'articulation', observation: 'notas conectadas', confidence: 0.7, timestamp_start: 5, timestamp_end: 12 },
    ],
});

// Helpers para armar audioAnalysis / reliability plausibles con overrides.
const baseAudio = (over = {}) => ({
    tempo: { bpm: 120, confidence: 0.85 },
    key: { key: 'C', scale: 'major', strength: 0.7 },
    loudness: { average: -18, dynamicComplexity: 0.35 },
    duration: 42,
    midiNotes: Array.from({ length: 60 }, (_, i) => ({
        pitchMidi: 60 + (i % 12), startTimeSeconds: i * 0.4, durationSeconds: 0.35, amplitude: 0.5,
    })),
    ...over,
});

const baseReliability = (over = {}) => ({
    tempo: { value: 120, reliability: 'high', confidence: 0.85 },
    key: { value: 'C', mode: 'major', reliability: 'high', confidence: 0.7, reasons_for_hedge: [] },
    transcription: { level: 'high', available: true, score: 0.8, warnings: [] },
    melody: { status: 'estimated', note: '' },
    reliable_signals: ['tempo', 'key'],
    unreliable_signals: [],
    overall_data_quality: 'high',
    ...over,
});

describe('MUSICAL_TERMS bank shape', () => {
    it('each term has required fields', () => {
        const required = ['id', 'term', 'category', 'level', 'definition', 'evidenceRequired', 'pedagogicalUse', 'styles', 'relatedTerms'];
        for (const [id, t] of Object.entries(MUSICAL_TERMS)) {
            expect(t.id, `${id} has id`).toBe(id);
            for (const key of required) {
                expect(t[key], `${id} has ${key}`).toBeDefined();
            }
            expect(['observable', 'interpretative', 'advanced']).toContain(t.level);
        }
    });
});

describe('getRelevantMusicalTerms — filtros por reliability', () => {
    it('con tempo estable + reliability high → selecciona tempo, pulso, estabilidad_del_pulso', () => {
        const terms = getRelevantMusicalTerms(baseAudio(), {}, baseReliability(), null);
        const ids = terms.map(t => t.id);
        expect(ids).toContain('tempo');
        expect(ids).toContain('pulso');
        expect(ids).toContain('estabilidad_del_pulso');
    });

    it('con transcription unreliable → NO incluye armonía advanced (voicing, ii_V_I, guide_tones)', () => {
        const terms = getRelevantMusicalTerms(
            baseAudio(),
            { style: 'bebop' },
            baseReliability({ transcription: { level: 'unreliable', available: false, score: 0.1, warnings: ['fallo transcripción'] } }),
            null,
        );
        const ids = terms.map(t => t.id);
        expect(ids).not.toContain('voicing');
        expect(ids).not.toContain('ii_V_I');
        expect(ids).not.toContain('guide_tones');
        expect(ids).not.toContain('bebop_scale');
        expect(ids).not.toContain('enclosure');
    });

    it('con melody.status = unknown → NO incluye términos que asumen melodía separada', () => {
        const terms = getRelevantMusicalTerms(
            baseAudio(),
            { style: 'bebop' },
            baseReliability({ melody: { status: 'unknown', note: 'no separada' } }),
            null,
        );
        const ids = terms.map(t => t.id);
        expect(ids).not.toContain('contorno_melodico');
        expect(ids).not.toContain('walking_bass');
        expect(ids).not.toContain('tumbao_bajo');
        expect(ids).not.toContain('playing_the_changes');
    });

    it('con key.reliability low → NO incluye armonía funcional (tónica, dominante, ii_V_I)', () => {
        const terms = getRelevantMusicalTerms(
            baseAudio(),
            { style: 'bebop' },
            baseReliability({ key: { value: null, reliability: 'low', confidence: 0.3, reasons_for_hedge: ['confianza baja'] } }),
            null,
        );
        const ids = terms.map(t => t.id);
        expect(ids).not.toContain('tonalidad');
        expect(ids).not.toContain('tonica');
        expect(ids).not.toContain('dominante');
        expect(ids).not.toContain('ii_V_I');
        expect(ids).not.toContain('guide_tones');
        expect(ids).not.toContain('sustitucion_tritono');
    });

    it('sin auditoryObservations → NO incluye articulacion / ataque / swing_feel (requieren escucha)', () => {
        const terms = getRelevantMusicalTerms(
            baseAudio(),
            { style: 'bebop' },
            baseReliability(),
            null,
        );
        const ids = terms.map(t => t.id);
        expect(ids).not.toContain('articulacion');
        expect(ids).not.toContain('ataque');
        expect(ids).not.toContain('swing_feel');
        expect(ids).not.toContain('interlocking');
    });

    it('con auditoryObservations disponibles + SIN estilo → SÍ incluye articulacion + ataque', () => {
        // Con el cap 10 + boost por estilo, cuando hay estilo declarado el cupo se llena
        // primero con términos específicos del estilo. Verificamos la habilitación en el
        // caso sin estilo, donde los auditory-dependent tienen cupo garantizado.
        const auditory = {
            auditory_observations: [
                { type: 'articulation', observation: 'notas conectadas', confidence: 0.7, timestamp_start: 5, timestamp_end: 12 },
            ],
        };
        const terms = getRelevantMusicalTerms(baseAudio(), {}, baseReliability(), auditory);
        const ids = terms.map(t => t.id);
        expect(ids).toContain('articulacion');
        expect(ids).toContain('ataque');
    });
});

describe('getRelevantMusicalTerms — estilos', () => {
    it('estilo bebop + reliability alta + escucha → habilita vocabulario bebop (bebop_scale, chord_tone)', () => {
        // NUEVO: los avanzados bebop ahora requieren transcription + escucha (doble corroboración).
        // Sin escucha, se quedan afuera aunque el estilo esté declarado (ver test más abajo).
        const terms = getRelevantMusicalTerms(baseAudio(), { style: 'bebop' }, baseReliability(), baseAuditory());
        const ids = terms.map(t => t.id);
        expect(ids).toContain('bebop_scale');
        expect(ids).toContain('chord_tone');
        expect(ids).toContain('ii_V_I'); // habilitado porque keyHigh + transcriptionReliable + hasAuditory
    });

    it('estilo bebop declarado NO obliga a mencionar ii_V_I (solo lo HABILITA en el vocabulario)', () => {
        // Verifica que el término aparezca en la lista cuando hay evidencia, no que sea obligatorio.
        // La obligatoriedad la controla el prompt (REGLA 12).
        const terms = getRelevantMusicalTerms(baseAudio(), { style: 'bebop' }, baseReliability(), baseAuditory());
        const ids = terms.map(t => t.id);
        expect(ids).toContain('ii_V_I');
        // Con transcription unreliable, se saca — la habilitación es condicionada.
        const terms2 = getRelevantMusicalTerms(
            baseAudio(),
            { style: 'bebop' },
            baseReliability({ transcription: { level: 'unreliable', available: false, score: 0.1, warnings: [] } }),
            baseAuditory(),
        );
        expect(terms2.map(t => t.id)).not.toContain('ii_V_I');
    });

    it('estilo soncubano + reliability alta + escucha → habilita núcleo estilístico afrocubano', () => {
        // Con cap 10 y muchos términos específicos afrocubanos, algunos de los muy
        // específicos (guajeo, tumbao_bajo, clave_2_3, clave_3_2) pueden quedar afuera
        // por prioridad de ordenamiento — lo importante es que el NÚCLEO llegue al prompt.
        const auditory = { auditory_observations: [{ type: 'rhythm', observation: 'clave presente', confidence: 0.8, timestamp_start: 0, timestamp_end: 8 }] };
        const terms = getRelevantMusicalTerms(baseAudio(), { style: 'soncubano' }, baseReliability(), auditory);
        const ids = terms.map(t => t.id);
        expect(ids).toContain('clave');
        expect(ids).toContain('montuno');
        expect(ids).toContain('tresillo');
        expect(ids).toContain('independencia_ritmica');
    });

    it('estilo soncubano NO trata montuno, guajeo y piano_tumbao como sinónimos (los 3 tienen entradas separadas)', () => {
        expect(MUSICAL_TERMS.montuno.id).toBe('montuno');
        expect(MUSICAL_TERMS.guajeo.id).toBe('guajeo');
        expect(MUSICAL_TERMS.piano_tumbao.id).toBe('piano_tumbao');
        expect(MUSICAL_TERMS.montuno.definition).not.toBe(MUSICAL_TERMS.guajeo.definition);
        expect(MUSICAL_TERMS.montuno.definition).not.toBe(MUSICAL_TERMS.piano_tumbao.definition);
    });

    it('estilo jazzcolombiano no habilita bambuco/cumbia/porro automáticamente (requiere hint en objective/notes)', () => {
        const terms = getRelevantMusicalTerms(baseAudio(), { style: 'jazzcolombiano', objective: 'trabajar improvisación' }, baseReliability(), null);
        const ids = terms.map(t => t.id);
        expect(ids).toContain('fusion_jazz_colombiano');
        expect(ids).not.toContain('bambuco');
        expect(ids).not.toContain('cumbia');
        expect(ids).not.toContain('porro');
    });

    it('estilo jazzcolombiano CON hint "bambuco" en objective habilita bambuco', () => {
        const terms = getRelevantMusicalTerms(baseAudio(), { style: 'jazzcolombiano', objective: 'mejorar mi bambuco en 3/4' }, baseReliability(), null);
        expect(terms.map(t => t.id)).toContain('bambuco');
    });
});

describe('getRelevantMusicalTerms — límites y edge cases', () => {
    it('siempre devuelve <= 10 términos (techo duro para ahorrar tokens del cupo TPM)', () => {
        const auditory = { auditory_observations: [{ type: 'x', observation: 'y', confidence: 0.8, timestamp_start: 0, timestamp_end: 1 }] };
        const terms = getRelevantMusicalTerms(baseAudio(), { style: 'bebop' }, baseReliability(), auditory);
        expect(terms.length).toBeLessThanOrEqual(10);
    });

    it('con evidencia intermedia (solo una capa fuerte) devuelve <= 8', () => {
        // Solo transcripción reliable, sin auditory ni key high — evidencia intermedia.
        const terms = getRelevantMusicalTerms(
            baseAudio(),
            { style: 'bebop' },
            baseReliability({
                key: { value: null, reliability: 'low', confidence: 0.3, reasons_for_hedge: [] },
            }),
            null,
        );
        expect(terms.length).toBeLessThanOrEqual(8);
    });

    it('con evidencia base (sin auditory, sin transcripción reliable, sin key high) devuelve <= 6', () => {
        const terms = getRelevantMusicalTerms(
            baseAudio(),
            {},
            baseReliability({
                key: { value: null, reliability: 'low', confidence: 0.3, reasons_for_hedge: [] },
                transcription: { level: 'unreliable', available: false, score: 0.1, warnings: [] },
            }),
            null,
        );
        expect(terms.length).toBeLessThanOrEqual(6);
    });

    it('cuando NO hay estilo declarado, ordena por nivel: observable → interpretative → advanced', () => {
        // Sin style, el boost de estilo no aplica y el ordering es puro por nivel.
        const terms = getRelevantMusicalTerms(baseAudio(), {}, baseReliability(), null);
        const levels = terms.map(t => t.level);
        const levelOrder = { observable: 0, interpretative: 1, advanced: 2 };
        for (let i = 1; i < levels.length; i++) {
            expect(levelOrder[levels[i]]).toBeGreaterThanOrEqual(levelOrder[levels[i - 1]]);
        }
    });

    it('con estilo declarado + escucha, los términos ESPECÍFICOS del estilo van primero (aunque sean advanced)', () => {
        // Confirmamos que el boost por estilo funciona — al menos un advanced del estilo aparece
        // antes que algún observable/interpretative genérico. Requiere auditory ahora porque los
        // advanced bebop pasaron a exigir escucha para habilitarse.
        const terms = getRelevantMusicalTerms(baseAudio(), { style: 'bebop' }, baseReliability(), baseAuditory());
        const ids = terms.map(t => t.id);
        const bebopScaleIdx = ids.indexOf('bebop_scale');
        const respIdx = ids.indexOf('respiracion_musical');
        expect(bebopScaleIdx).toBeGreaterThanOrEqual(0);
        // bebop_scale es advanced específico de bebop — debería aparecer antes que respiracion_musical (interpretative genérico)
        if (respIdx >= 0) expect(bebopScaleIdx).toBeLessThan(respIdx);
    });

    it('audioAnalysis vacío no rompe — devuelve al menos términos base sin datos específicos', () => {
        // Sin notas, sin loudness, sin nada — al menos "pulso" y "estabilidad_del_pulso" siguen siendo agregados
        // porque no requieren MIDI. Este test verifica que el selector no explota con inputs mínimos.
        const terms = getRelevantMusicalTerms({}, {}, null, null);
        expect(Array.isArray(terms)).toBe(true);
        // Puede ser cortísimo pero no debe romper
        for (const t of terms) {
            expect(MUSICAL_TERMS[t.id]).toBeDefined();
        }
    });

    it('metadata sin style no rompe — devuelve solo términos base generales', () => {
        const terms = getRelevantMusicalTerms(baseAudio(), {}, baseReliability(), null);
        const ids = terms.map(t => t.id);
        // Ningún término específico de estilo
        expect(ids).not.toContain('bebop_scale');
        expect(ids).not.toContain('clave');
        expect(ids).not.toContain('fraseo_bolero');
        expect(ids).not.toContain('bambuco');
        // Pero sí los base
        expect(ids).toContain('tempo');
        expect(ids).toContain('pulso');
    });
});

describe('getRelevantMusicalTerms — gates apretados (fase de reducción de tokens)', () => {
    it('estilo bebop SIN escucha NO habilita ii_V_I, guide_tones, bebop_scale, chord_tone, playing_the_changes', () => {
        // Regla clave: el estilo declarado por sí solo NO habilita vocabulario avanzado.
        // Sin auditory (Gemini no escuchó), estos advanced quedan afuera aunque la
        // transcripción y la tonalidad sean reliable.
        const terms = getRelevantMusicalTerms(baseAudio(), { style: 'bebop' }, baseReliability(), null);
        const ids = terms.map(t => t.id);
        expect(ids).not.toContain('ii_V_I');
        expect(ids).not.toContain('guide_tones');
        expect(ids).not.toContain('bebop_scale');
        expect(ids).not.toContain('chord_tone');
        expect(ids).not.toContain('playing_the_changes');
        expect(ids).not.toContain('enclosure');
        expect(ids).not.toContain('approach_note');
    });

    it('estilo bebop SIN escucha SÍ mantiene el núcleo estilístico observable (swing, comping)', () => {
        // Aunque los advanced queden afuera, el núcleo estilístico (concepto general del estilo)
        // sigue disponible para que el modelo pueda hablar del estilo.
        const terms = getRelevantMusicalTerms(baseAudio(), { style: 'bebop' }, baseReliability(), null);
        const ids = terms.map(t => t.id);
        expect(ids).toContain('swing');
        expect(ids).toContain('comping');
    });

    it('estilo soncubano SIN escucha NO habilita montuno, piano_tumbao, guajeo', () => {
        // Mismo criterio: patrones pianísticos específicos requieren corroboración auditiva,
        // no solo la declaración del estilo.
        const terms = getRelevantMusicalTerms(baseAudio(), { style: 'soncubano' }, baseReliability(), null);
        const ids = terms.map(t => t.id);
        expect(ids).not.toContain('montuno');
        expect(ids).not.toContain('piano_tumbao');
        expect(ids).not.toContain('guajeo');
        // Pero el núcleo estilístico se mantiene
        expect(ids).toContain('clave');
        expect(ids).toContain('independencia_ritmica');
    });

    it('con evidencia mínima (sin notas, sin loudness, sin auditory, sin estilo) devuelve MENOS de 10 términos', () => {
        // No rellena artificialmente hasta el cap. Con poca evidencia, la lista se queda corta.
        const poorAudio = { tempo: {}, key: {}, loudness: {}, midiNotes: [], duration: 10 };
        const terms = getRelevantMusicalTerms(
            poorAudio,
            {},
            baseReliability({
                transcription: { level: 'unreliable', available: false, score: 0.1, warnings: [] },
                key: { value: null, reliability: 'low', confidence: 0.3, reasons_for_hedge: ['baja'] },
                melody: { status: 'unknown', note: 'no separada' },
            }),
            null,
        );
        expect(terms.length).toBeLessThan(10);
    });

    it('hint explícito "playing the changes" en objective habilita playing_the_changes (más señal que el estilo)', () => {
        const terms = getRelevantMusicalTerms(
            baseAudio(),
            { style: 'bebop', objective: 'quiero mejorar mi playing the changes' },
            baseReliability(),
            null,
        );
        expect(terms.map(t => t.id)).toContain('playing_the_changes');
    });
});

describe('formatMusicalTermsForPrompt — representación compacta', () => {
    const engine = new AIAnalysisEngine();

    it('string vacío si no hay términos', () => {
        expect(engine.formatMusicalTermsForPrompt([])).toBe('');
        expect(engine.formatMusicalTermsForPrompt(null)).toBe('');
    });

    it('emite header con referencia a REGLA 12 UNA sola vez', () => {
        const terms = getRelevantMusicalTerms(baseAudio(), { style: 'bebop' }, baseReliability(), baseAuditory());
        const block = engine.formatMusicalTermsForPrompt(terms);
        const headerMatches = (block.match(/VOCABULARIO MUSICAL DISPONIBLE/g) || []).length;
        expect(headerMatches).toBe(1);
        expect(block).toMatch(/REGLA 12/);
    });

    it('NO incluye metadata interna: aliases, category, relatedTerms, nivel entre paréntesis, "Uso:"', () => {
        // Elegimos densidad_ritmica que tiene aliases ['densidad'] y relatedTerms conocidos para
        // asegurarnos de que no se filtren al prompt.
        const terms = [MUSICAL_TERMS.densidad_ritmica, MUSICAL_TERMS.pulso, MUSICAL_TERMS.fraseo];
        const block = engine.formatMusicalTermsForPrompt(terms);
        // Metadata que NO debería aparecer:
        expect(block).not.toMatch(/aliases/i);
        expect(block).not.toMatch(/relatedTerms/i);
        expect(block).not.toMatch(/category/i);
        expect(block).not.toMatch(/allowedWhen/i);
        expect(block).not.toMatch(/evidenceRequired/i);
        // Ya no emitimos "(observable)" / "(interpretative)" / "(advanced)" ni prefijo "Uso:".
        expect(block).not.toMatch(/\(observable\)/);
        expect(block).not.toMatch(/\(interpretative\)/);
        expect(block).not.toMatch(/\(advanced\)/);
        expect(block).not.toMatch(/Uso:/);
    });

    it('cada término ocupa UNA línea con formato "- Term: definition[ NO: restriccion.]"', () => {
        const terms = [MUSICAL_TERMS.pulso, MUSICAL_TERMS.densidad_ritmica];
        const block = engine.formatMusicalTermsForPrompt(terms);
        const lines = block.split('\n').filter(Boolean);
        // 1 header + N términos
        expect(lines.length).toBe(1 + terms.length);
        for (const term of terms) {
            const line = lines.find(l => l.startsWith(`- ${term.term}:`));
            expect(line, `hay línea para ${term.term}`).toBeTruthy();
        }
    });

    it('el formato compacto es mucho más chico que el anterior (ahorro de tokens)', () => {
        // Comparamos la longitud del bloque nuevo contra una reconstrucción del formato viejo
        // sobre los mismos términos. Debería ser al menos 50% más corto.
        const terms = getRelevantMusicalTerms(baseAudio(), { style: 'bebop' }, baseReliability(), baseAuditory());
        const nuevo = engine.formatMusicalTermsForPrompt(terms);
        const viejo = terms.map(t => {
            const levelTag = t.level ? ` (${t.level})` : '';
            const use = t.pedagogicalUse ? ` Uso: ${t.pedagogicalUse}` : '';
            const forbid = Array.isArray(t.forbiddenWhen) && t.forbiddenWhen.length
                ? ` NO usar cuando: ${t.forbiddenWhen.slice(0, 2).join('; ')}.`
                : '';
            return `- ${t.term}${levelTag}: ${t.definition}${use}${forbid}`;
        }).join('\n');
        expect(nuevo.length).toBeLessThan(viejo.length * 0.5);
    });

    it('alias formatMusicalTermsBlock sigue funcionando (compatibilidad hacia atrás)', () => {
        const terms = [MUSICAL_TERMS.pulso];
        expect(engine.formatMusicalTermsBlock(terms)).toBe(engine.formatMusicalTermsForPrompt(terms));
    });
});

describe('buildAnalysisPrompt — deduplicación de reglas y schema estable', () => {
    const engine = new AIAnalysisEngine();

    const baseAudioForPrompt = () => ({
        tempo: { bpm: 120, confidence: 0.85 },
        key: { key: 'C', scale: 'major', strength: 0.75 },
        loudness: { average: -18, dynamicComplexity: 0.35 },
        duration: 42,
        midiNotes: Array.from({ length: 60 }, (_, i) => ({
            pitchMidi: 60 + (i % 12), startTimeSeconds: i * 0.4, durationSeconds: 0.35, amplitude: 0.5,
        })),
    });

    it('reglas generales del vocabulario aparecen UNA sola vez (no se repiten por término ni por sección)', () => {
        const { systemPrompt, userPrompt } = engine.buildAnalysisPrompt(
            baseAudioForPrompt(), { style: 'bebop' }, null, baseAuditory(), baseReliability(), null,
        );
        // La regla "usá solo lo que la evidencia respalde" debe aparecer una sola vez en el system
        // (en R12). El userPrompt puede mencionar "VOCABULARIO MUSICAL DISPONIBLE" pero no repetir
        // la regla completa.
        const evidenceRulePattern = /usá\s+(?:s[oó]lo|solo)\s+lo\s+que\s+la\s+evidencia\s+.*respalde/gi;
        const systemMatches = (systemPrompt.match(evidenceRulePattern) || []).length;
        expect(systemMatches).toBeLessThanOrEqual(1);
        const userMatches = (userPrompt.match(evidenceRulePattern) || []).length;
        expect(userMatches).toBe(0);
    });

    it('prohibición de "densidad" en musicalAnalysis se declara sin duplicación excesiva', () => {
        const { systemPrompt } = engine.buildAnalysisPrompt(
            baseAudioForPrompt(), { style: 'bebop' }, null, baseAuditory(), baseReliability(), null,
        );
        // Antes aparecía 5 veces (R2, R6, ESTRUCTURA, AUTO-PODA, REGLAS FINALES). El objetivo tras
        // consolidar es ≤ 3 menciones (regla + poda + schema). Más de eso indica regresión.
        const densidadProhibida = (systemPrompt.match(/[Pp]rohibido[^\n]*densidad|"densidad"[^\n]*(prohibido|sin|reescrib)|SIN\s+la\s+palabra\s+['"]densidad['"]/g) || []).length;
        expect(densidadProhibida).toBeLessThanOrEqual(3);
    });

    it('el bloque de vocabulario solo aparece si hay términos y no repite la regla general por término', () => {
        const { userPrompt } = engine.buildAnalysisPrompt(
            baseAudioForPrompt(), { style: 'bebop' }, null, baseAuditory(), baseReliability(), null,
        );
        // El header del vocabulario debe salir 1 sola vez si hay términos
        const vocabHeaders = (userPrompt.match(/VOCABULARIO MUSICAL DISPONIBLE/g) || []).length;
        expect(vocabHeaders).toBeLessThanOrEqual(1);
        // Y no debe repetir "REGLA 12" en cada término (solo una referencia al header)
        const regla12Refs = (userPrompt.match(/REGLA 12/g) || []).length;
        expect(regla12Refs).toBeLessThanOrEqual(1);
    });

    it('el schema JSON expone los mismos campos top-level (no cambia con esta reducción)', () => {
        const { systemPrompt } = engine.buildAnalysisPrompt(
            baseAudioForPrompt(), { style: 'bebop' }, null, baseAuditory(), baseReliability(), null,
        );
        const expectedFields = [
            'overallScore', 'musicalAnalysis', 'strengths', 'observations',
            'primaryFocus', 'practiceExercise', 'moments', 'nextGoal',
            'beliefVsDetection', 'metacognitiveQuestion',
        ];
        for (const field of expectedFields) {
            expect(systemPrompt).toContain(`"${field}"`);
        }
    });

    it('melody.status = unknown mantiene bloqueo de afirmaciones sobre melodía en el vocabulario', () => {
        // La restricción del vocabulario no cambia con la reducción — sin melodía separable,
        // contorno_melodico / walking_bass / tumbao_bajo / playing_the_changes no entran.
        const terms = getRelevantMusicalTerms(
            baseAudioForPrompt(),
            { style: 'bebop' },
            baseReliability({ melody: { status: 'unknown', note: 'no separada' } }),
            baseAuditory(),
        );
        const ids = terms.map(t => t.id);
        expect(ids).not.toContain('contorno_melodico');
        expect(ids).not.toContain('walking_bass');
        expect(ids).not.toContain('tumbao_bajo');
        expect(ids).not.toContain('playing_the_changes');
    });

    it('articulación sigue requiriendo evidencia auditiva tras la reducción', () => {
        // Sin auditory, articulación NO entra aunque haya transcripción reliable.
        const withoutAuditory = getRelevantMusicalTerms(baseAudioForPrompt(), {}, baseReliability(), null);
        expect(withoutAuditory.map(t => t.id)).not.toContain('articulacion');
        // Con auditory + sin estilo, sí entra.
        const withAuditory = getRelevantMusicalTerms(baseAudioForPrompt(), {}, baseReliability(), baseAuditory());
        expect(withAuditory.map(t => t.id)).toContain('articulacion');
    });

    it('el pipeline sigue siendo Groq → fallback local (no cambia con esta reducción)', () => {
        // Contrato de la clase: callAI delega solamente en callGroq; no hay callGemini en la ruta
        // de texto (el fallback local es la única red de seguridad). Este test protege el pipeline.
        expect(engine.callAI).toBeTypeOf('function');
        expect(engine.callGroq).toBeTypeOf('function');
        // callAI y callGroq deberían apuntar al mismo mecanismo (callAI llama a callGroq).
        const groqSource = engine.callAI.toString();
        expect(groqSource).toMatch(/callGroq/);
    });
});

describe('groupTermsByCategory', () => {
    it('agrupa correctamente por category', () => {
        const terms = getRelevantMusicalTerms(baseAudio(), { style: 'bebop' }, baseReliability(), null);
        const groups = groupTermsByCategory(terms);
        expect(typeof groups).toBe('object');
        for (const [cat, ids] of Object.entries(groups)) {
            expect(Array.isArray(ids)).toBe(true);
            for (const id of ids) {
                expect(MUSICAL_TERMS[id].category).toBe(cat);
            }
        }
    });
});
