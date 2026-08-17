import { describe, it, expect } from 'vitest';
import { MUSICAL_TERMS, getRelevantMusicalTerms, groupTermsByCategory } from '../assets/js/data/musicalTerms.js';

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

    it('con auditoryObservations disponibles → SÍ incluye articulacion + swing_feel (si estilo aplica)', () => {
        const auditory = {
            auditory_observations: [
                { type: 'articulation', observation: 'notas conectadas', confidence: 0.7, timestamp_start: 5, timestamp_end: 12 },
            ],
        };
        const terms = getRelevantMusicalTerms(baseAudio(), { style: 'bebop' }, baseReliability(), auditory);
        const ids = terms.map(t => t.id);
        expect(ids).toContain('articulacion');
        expect(ids).toContain('swing_feel');
    });
});

describe('getRelevantMusicalTerms — estilos', () => {
    it('estilo bebop + reliability alta → habilita vocabulario bebop (bebop_scale, approach_note, chord_tone)', () => {
        const terms = getRelevantMusicalTerms(baseAudio(), { style: 'bebop' }, baseReliability(), null);
        const ids = terms.map(t => t.id);
        expect(ids).toContain('bebop_scale');
        expect(ids).toContain('approach_note');
        expect(ids).toContain('chord_tone');
        expect(ids).toContain('ii_V_I'); // habilitado porque keyOk + transcriptionReliable + style bebop
    });

    it('estilo bebop declarado NO obliga a mencionar ii_V_I (solo lo HABILITA en el vocabulario)', () => {
        // Este test verifica que el término aparezca en la lista, no que sea obligatorio.
        // La obligatoriedad la controla el prompt (REGLA 12) — acá solo verificamos que
        // el selector no lo saque cuando el estilo lo justifica y la reliability lo permite.
        const terms = getRelevantMusicalTerms(baseAudio(), { style: 'bebop' }, baseReliability(), null);
        const ids = terms.map(t => t.id);
        expect(ids).toContain('ii_V_I');
        // Y con transcription unreliable, se saca — probando que la habilitación es condicionada.
        const terms2 = getRelevantMusicalTerms(
            baseAudio(),
            { style: 'bebop' },
            baseReliability({ transcription: { level: 'unreliable', available: false, score: 0.1, warnings: [] } }),
            null,
        );
        expect(terms2.map(t => t.id)).not.toContain('ii_V_I');
    });

    it('estilo soncubano + reliability alta + escucha → habilita clave, montuno, piano_tumbao, guajeo', () => {
        const auditory = { auditory_observations: [{ type: 'rhythm', observation: 'clave presente', confidence: 0.8, timestamp_start: 0, timestamp_end: 8 }] };
        const terms = getRelevantMusicalTerms(baseAudio(), { style: 'soncubano' }, baseReliability(), auditory);
        const ids = terms.map(t => t.id);
        expect(ids).toContain('clave');
        expect(ids).toContain('montuno');
        expect(ids).toContain('piano_tumbao');
        expect(ids).toContain('guajeo');
        expect(ids).toContain('tresillo');
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
    it('siempre devuelve <= 25 términos (cap del selector)', () => {
        const auditory = { auditory_observations: [{ type: 'x', observation: 'y', confidence: 0.8, timestamp_start: 0, timestamp_end: 1 }] };
        const terms = getRelevantMusicalTerms(baseAudio(), { style: 'bebop' }, baseReliability(), auditory);
        expect(terms.length).toBeLessThanOrEqual(25);
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

    it('con estilo declarado, los términos ESPECÍFICOS del estilo van primero (aunque sean advanced)', () => {
        // Confirmamos que el boost por estilo funciona — al menos un advanced del estilo aparece
        // antes que algún observable/interpretative genérico.
        const terms = getRelevantMusicalTerms(baseAudio(), { style: 'bebop' }, baseReliability(), null);
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
