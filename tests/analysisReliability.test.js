import { describe, it, expect } from 'vitest';
import {
    assessTranscription,
    assessKey,
    assessTempo,
    assessAnalysis,
} from '../assets/js/modules/AnalysisReliability.js';

// Helpers para construir grabaciones plausibles: emulan la forma exacta que
// tiene la salida real de AudioAnalyzer.analyzeAudio.
const goodNote = (start, dur, pitch, amp = 0.5) => ({
    startTimeSeconds: start,
    durationSeconds: dur,
    pitchMidi: pitch,
    amplitude: amp,
});
const makeAnalysis = (overrides = {}) => ({
    duration: 30,
    tempo: { bpm: 120, confidence: 0.8 },
    key: { key: 'C', scale: 'major', strength: 0.7 },
    loudness: { average: -18, dynamicComplexity: 0.3 },
    providersUsed: ['essentia-init', 'tempo', 'key', 'loudness', 'basic-pitch (100 notas)'],
    providersFailed: [],
    midiNotes: [],
    ...overrides,
});

describe('assessTranscription', () => {
    it('marca como unreliable cuando no hay notas y basic-pitch falló', () => {
        const r = assessTranscription(makeAnalysis({
            midiNotes: [],
            providersFailed: ['basic-pitch (0 notas transcritas)'],
        }));
        expect(r.available).toBe(false);
        expect(r.level).toBe('unreliable');
        expect(r.warnings[0]).toMatch(/basic-pitch/);
    });

    it('marca como high una transcripción limpia', () => {
        const notes = Array.from({ length: 60 }, (_, i) => goodNote(i * 0.5, 0.4, 60 + (i % 12)));
        const r = assessTranscription(makeAnalysis({ midiNotes: notes, duration: 30 }));
        expect(r.available).toBe(true);
        expect(r.level).toBe('high');
        expect(r.score).toBeGreaterThanOrEqual(0.75);
    });

    it('penaliza cuando hay muchas notas < 40 ms', () => {
        const notes = [
            ...Array.from({ length: 30 }, (_, i) => goodNote(i * 0.3, 0.4, 60 + i % 12)),
            ...Array.from({ length: 15 }, (_, i) => goodNote(i * 0.3 + 0.1, 0.02, 72 + i % 6)),
        ];
        const r = assessTranscription(makeAnalysis({ midiNotes: notes, duration: 15 }));
        expect(r.warnings.some(w => /< 40 ms/.test(w))).toBe(true);
        expect(r.score).toBeLessThan(0.85);
    });

    it('penaliza notas fuera del rango del piano', () => {
        const notes = [
            ...Array.from({ length: 40 }, (_, i) => goodNote(i * 0.3, 0.4, 60 + i % 12)),
            ...Array.from({ length: 8 }, (_, i) => goodNote(i * 0.3 + 0.1, 0.3, 130)),   // fuera del rango
        ];
        const r = assessTranscription(makeAnalysis({ midiNotes: notes, duration: 20 }));
        expect(r.warnings.some(w => /rango del piano/.test(w))).toBe(true);
    });

    it('detecta densidad global extrema', () => {
        const notes = Array.from({ length: 800 }, (_, i) => goodNote(i * 0.05, 0.3, 60 + (i % 24)));
        const r = assessTranscription(makeAnalysis({ midiNotes: notes, duration: 30 }));
        expect(r.warnings.some(w => /densidad global extrema/.test(w))).toBe(true);
    });
});

describe('assessKey', () => {
    const transcriptionReliable = { available: true, level: 'high', score: 0.85 };
    const transcriptionUnavailable = { available: false, level: 'unreliable', score: 0 };

    it('devuelve unreliable cuando essentia no detectó tonalidad', () => {
        const r = assessKey(makeAnalysis({ key: { key: 'Desconocida', scale: '', strength: 0 } }), transcriptionUnavailable);
        expect(r.reliability).toBe('unreliable');
        expect(r.reasons_for_hedge.length).toBeGreaterThan(0);
    });

    it('marca high con strength alta y transcripción no disponible', () => {
        const r = assessKey(makeAnalysis({ key: { key: 'C', scale: 'major', strength: 0.82 } }), transcriptionUnavailable);
        expect(r.reliability).toBe('high');
    });

    it('degrada a low cuando la transcripción confiable muestra pitch classes que NO coinciden con la escala', () => {
        // C mayor: escala {0,2,4,5,7,9,11}. Metemos puras notas fuera de escala (1,3,6,8,10 = C#/D#/F#/G#/A#).
        const outOfScaleNotes = Array.from({ length: 50 }, (_, i) => goodNote(i * 0.5, 0.4, [61, 63, 66, 68, 70][i % 5]));
        const r = assessKey(
            makeAnalysis({ key: { key: 'C', scale: 'major', strength: 0.65 }, midiNotes: outOfScaleNotes }),
            transcriptionReliable,
        );
        expect(r.reliability).toBe('low');
        expect(r.reasons_for_hedge.some(x => /no coinciden/.test(x))).toBe(true);
    });

    it('se mantiene en high si transcripción confiable corrobora la escala', () => {
        // C mayor escala {C,D,E,F,G,A,B} → MIDI 60,62,64,65,67,69,71
        const inScale = Array.from({ length: 60 }, (_, i) => goodNote(i * 0.4, 0.35, [60, 62, 64, 65, 67, 69, 71][i % 7]));
        const r = assessKey(
            makeAnalysis({ key: { key: 'C', scale: 'major', strength: 0.68 }, midiNotes: inScale }),
            transcriptionReliable,
        );
        expect(r.reliability).toBe('high');
    });
});

describe('assessTempo', () => {
    it('marca high con confidence alta', () => {
        const r = assessTempo(makeAnalysis({ tempo: { bpm: 128, confidence: 0.85 } }));
        expect(r.reliability).toBe('high');
        expect(r.value).toBe(128);
    });

    it('marca medium con confidence intermedia', () => {
        const r = assessTempo(makeAnalysis({ tempo: { bpm: 100, confidence: 0.55 } }));
        expect(r.reliability).toBe('medium');
    });

    it('marca unreliable con confidence muy baja', () => {
        const r = assessTempo(makeAnalysis({ tempo: { bpm: 80, confidence: 0.1 } }));
        expect(r.reliability).toBe('unreliable');
    });
});

describe('assessAnalysis (integración)', () => {
    it('produce overall high cuando todas las señales son fuertes y coincidentes', () => {
        const notes = Array.from({ length: 40 }, (_, i) => goodNote(i * 0.5, 0.35, [60, 62, 64, 65, 67, 69, 71][i % 7]));
        const r = assessAnalysis(makeAnalysis({
            tempo: { bpm: 120, confidence: 0.9 },
            key: { key: 'C', scale: 'major', strength: 0.85 },
            midiNotes: notes,
        }));
        expect(r.overall_data_quality).toBe('high');
        expect(r.reliable_signals).toContain('tempo');
        expect(r.reliable_signals).toContain('key');
        expect(r.reliable_signals).toContain('dynamics');
        expect(r.reliable_signals).toContain('transcription_dependent_metrics');
    });

    it('produce overall low cuando dos o más señales están flojas', () => {
        const r = assessAnalysis(makeAnalysis({
            tempo: { bpm: 100, confidence: 0.2 },
            key: { key: 'C', scale: 'major', strength: 0.3 },
            midiNotes: [],
            providersFailed: ['basic-pitch (0 notas transcritas)'],
        }));
        expect(r.overall_data_quality).toBe('low');
        expect(r.unreliable_signals).toContain('key');
        expect(r.unreliable_signals).toContain('transcription_dependent_metrics');
    });

    it('marca dynamics como inconfiable cuando loudness fue fallback', () => {
        const r = assessAnalysis(makeAnalysis({
            providersUsed: ['essentia-init', 'tempo', 'key', 'loudness-fallback'],
        }));
        expect(r.unreliable_signals).toContain('dynamics');
    });

    it('siempre marca melody.status como unknown', () => {
        const r = assessAnalysis(makeAnalysis());
        expect(r.melody.status).toBe('unknown');
    });
});
