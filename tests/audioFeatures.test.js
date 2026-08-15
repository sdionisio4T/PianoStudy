import { describe, it, expect } from 'vitest';
import {
    beatConsistency,
    rushDragThirds,
    noteStats,
    pitchClassProfile,
    silenceRatio,
    sectionProfile,
    deriveFeatures,
    midiToName,
} from '../assets/js/modules/AudioFeatures.js';

describe('midiToName', () => {
    it('convierte notas MIDI a nombre con octava', () => {
        expect(midiToName(60)).toBe('C4');
        expect(midiToName(69)).toBe('A4');
        expect(midiToName(21)).toBe('A0');
    });

    it('devuelve -- para valores inválidos', () => {
        expect(midiToName(0)).toBe('--');
        expect(midiToName(null)).toBe('--');
        expect(midiToName(undefined)).toBe('--');
        expect(midiToName(NaN)).toBe('--');
    });
});

describe('beatConsistency', () => {
    it('devuelve null con menos de 3 ticks', () => {
        expect(beatConsistency([])).toBeNull();
        expect(beatConsistency([1, 2])).toBeNull();
        expect(beatConsistency(null)).toBeNull();
    });

    it('detecta pulso muy estable con intervalos parejos', () => {
        const ticks = [0, 0.5, 1.0, 1.5, 2.0, 2.5];
        const result = beatConsistency(ticks);
        expect(result.stability).toBe('muy estable');
        expect(result.beatCount).toBe(6);
        expect(result.meanIntervalMs).toBe(500);
    });

    it('detecta pulso inestable con intervalos dispares', () => {
        const ticks = [0, 0.4, 0.9, 1.7, 2.3, 3.5];
        const result = beatConsistency(ticks);
        expect(result.stability).toMatch(/inestable/);
    });
});

describe('rushDragThirds', () => {
    it('devuelve null sin ticks suficientes', () => {
        expect(rushDragThirds([], 10)).toBeNull();
        expect(rushDragThirds([0, 1], 10)).toBeNull();
    });

    it('detecta aceleración', () => {
        // Primer tercio a 60 BPM (intervalo 1s), último a 120 BPM (0.5s)
        const ticks = [0, 1, 2, 3, 3.5, 4.0, 4.5, 5.0];
        const result = rushDragThirds(ticks, 6);
        expect(result.tendency).toMatch(/acelerando/);
        expect(result.deltaFirstToLast).toBeGreaterThan(0);
    });

    it('marca "estable" cuando el delta es pequeño', () => {
        const ticks = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5];
        const result = rushDragThirds(ticks, 4.5);
        expect(result.tendency).toBe('estable de principio a fin');
    });
});

describe('noteStats', () => {
    it('devuelve null sin notas', () => {
        expect(noteStats([], 10)).toBeNull();
        expect(noteStats(null, 10)).toBeNull();
    });

    it('devuelve null si la duración es inválida', () => {
        expect(noteStats([{ pitchMidi: 60, startTimeSeconds: 0, durationSeconds: 0.3 }], 0)).toBeNull();
    });

    it('calcula densidad, rango y articulación con notas reales', () => {
        const notes = [
            { pitchMidi: 60, startTimeSeconds: 0.0, durationSeconds: 0.5, amplitude: 0.6 },
            { pitchMidi: 64, startTimeSeconds: 0.5, durationSeconds: 0.5, amplitude: 0.7 },
            { pitchMidi: 67, startTimeSeconds: 1.0, durationSeconds: 0.5, amplitude: 0.8 },
            { pitchMidi: 72, startTimeSeconds: 1.5, durationSeconds: 0.5, amplitude: 0.5 },
        ];
        const result = noteStats(notes, 2);
        expect(result.totalNotes).toBe(4);
        expect(result.notesPerSecond).toBe(2);
        expect(result.density).toBe('moderada');
        expect(result.lowestName).toBe('C4');
        expect(result.highestName).toBe('C5');
        expect(result.spanSemitones).toBe(12);
        expect(result.spanOctaves).toBe(1);
        expect(result.articulation).toBe('legato / sostenido');
    });

    it('detecta articulación staccato con notas cortas', () => {
        const notes = Array.from({ length: 10 }, (_, i) => ({
            pitchMidi: 60 + i,
            startTimeSeconds: i * 0.1,
            durationSeconds: 0.05,
            amplitude: 0.5,
        }));
        const result = noteStats(notes, 1);
        expect(result.articulation).toBe('staccato / muy corto');
    });
});

describe('pitchClassProfile', () => {
    it('devuelve null sin notas', () => {
        expect(pitchClassProfile([])).toBeNull();
        expect(pitchClassProfile(null)).toBeNull();
    });

    it('identifica las notas más usadas', () => {
        const notes = [
            { pitchMidi: 60 }, { pitchMidi: 60 }, { pitchMidi: 60 }, // C x3
            { pitchMidi: 64 }, { pitchMidi: 64 },                     // E x2
            { pitchMidi: 67 },                                         // G x1
        ];
        const result = pitchClassProfile(notes);
        expect(result.top3[0].note).toBe('C');
        expect(result.top3[0].count).toBe(3);
        expect(result.top3[1].note).toBe('E');
        expect(result.pitchClassesUsed).toBe(3);
        expect(result.unusedNotes).toContain('D');
    });
});

describe('silenceRatio', () => {
    it('devuelve silencio total sin notas', () => {
        const result = silenceRatio([], 10);
        expect(result.silenceRatio).toBe(1);
        expect(result.coverageSec).toBe(0);
    });

    it('calcula cobertura correctamente con intervalos que no se solapan', () => {
        const notes = [
            { startTimeSeconds: 0, durationSeconds: 2 },
            { startTimeSeconds: 5, durationSeconds: 2 },
        ];
        const result = silenceRatio(notes, 10);
        expect(result.coverageSec).toBe(4);
        expect(result.silenceRatio).toBe(0.6);
    });

    it('une intervalos solapados sin doble contar', () => {
        const notes = [
            { startTimeSeconds: 0, durationSeconds: 2 },
            { startTimeSeconds: 1, durationSeconds: 2 }, // solapa con anterior
        ];
        const result = silenceRatio(notes, 10);
        expect(result.coverageSec).toBe(3);
    });
});

describe('sectionProfile', () => {
    it('devuelve null con duración inválida', () => {
        expect(sectionProfile([], 0)).toBeNull();
    });

    it('divide notas correctamente en 3 secciones', () => {
        const notes = [
            { pitchMidi: 60, startTimeSeconds: 0.5, durationSeconds: 0.2, amplitude: 0.5 },
            { pitchMidi: 64, startTimeSeconds: 1.5, durationSeconds: 0.2, amplitude: 0.6 },
            { pitchMidi: 67, startTimeSeconds: 2.5, durationSeconds: 0.2, amplitude: 0.7 },
        ];
        const result = sectionProfile(notes, 3);
        expect(result).toHaveLength(3);
        expect(result[0].noteCount).toBe(1);
        expect(result[1].noteCount).toBe(1);
        expect(result[2].noteCount).toBe(1);
        expect(result[0].lowestName).toBe('C4');
        expect(result[2].highestName).toBe('G4');
    });
});

describe('deriveFeatures (integración)', () => {
    it('devuelve todos los campos aunque sean null cuando falta data', () => {
        const result = deriveFeatures({});
        expect(result).toHaveProperty('beat');
        expect(result).toHaveProperty('rushDrag');
        expect(result).toHaveProperty('notes');
        expect(result).toHaveProperty('pitchClass');
        expect(result).toHaveProperty('silence');
        expect(result).toHaveProperty('sections');
    });

    it('devuelve {} con entrada no válida', () => {
        expect(deriveFeatures(null)).toEqual({});
        expect(deriveFeatures(undefined)).toEqual({});
        expect(deriveFeatures('foo')).toEqual({});
    });

    it('produce un perfil completo con datos realistas', () => {
        const analysis = {
            duration: 6,
            tempo: {
                bpm: 120,
                confidence: 0.8,
                ticks: [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5],
            },
            midiNotes: [
                { pitchMidi: 60, startTimeSeconds: 0.0, durationSeconds: 0.4, amplitude: 0.6 },
                { pitchMidi: 62, startTimeSeconds: 0.5, durationSeconds: 0.4, amplitude: 0.7 },
                { pitchMidi: 64, startTimeSeconds: 1.0, durationSeconds: 0.4, amplitude: 0.5 },
                { pitchMidi: 65, startTimeSeconds: 3.0, durationSeconds: 0.4, amplitude: 0.6 },
                { pitchMidi: 67, startTimeSeconds: 5.0, durationSeconds: 0.4, amplitude: 0.8 },
            ],
        };
        const result = deriveFeatures(analysis);
        expect(result.beat.stability).toBe('muy estable');
        expect(result.notes.totalNotes).toBe(5);
        expect(result.sections).toHaveLength(3);
        expect(result.pitchClass.top3.length).toBeGreaterThan(0);
        expect(result.silence.silenceRatio).toBeGreaterThan(0);
    });
});
