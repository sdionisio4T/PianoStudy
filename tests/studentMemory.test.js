import { describe, it, expect, beforeAll } from 'vitest';
import { AIAnalysisEngine } from '../assets/js/modules/AIAnalysisEngine.js';

const build = AIAnalysisEngine.buildStudentMemory;

describe('buildStudentMemory', () => {
    it('devuelve null con histórico vacío o inválido', () => {
        expect(build([])).toBeNull();
        expect(build(null)).toBeNull();
        expect(build(undefined)).toBeNull();
    });

    it('resume un único análisis previo', () => {
        const history = [{
            timestamp: Date.now(),
            aiAnalysis: {
                overallScore: 7,
                moments: [{ kind: 'improve', note: 'trabajá la sección final' }],
                practiceExercise: { title: 'Metrónomo a 90' },
            },
        }];
        const memory = build(history);
        expect(memory.totalSessions).toBe(1);
        expect(memory.averageScore).toBe(7);
        expect(memory.scoreTrend).toBe('sin tendencia suficiente');
        expect(memory.recurringImproveNotes).toContain('trabajá la sección final');
        expect(memory.recentExercises).toContain('Metrónomo a 90');
    });

    it('detecta tendencia "mejorando" con historia larga', () => {
        // 3 recientes con score 8, 4 anteriores con score 6 → mejorando
        const now = Date.now();
        const history = [
            { timestamp: now - 1000, aiAnalysis: { overallScore: 8, moments: [] } },
            { timestamp: now - 2000, aiAnalysis: { overallScore: 8, moments: [] } },
            { timestamp: now - 3000, aiAnalysis: { overallScore: 8, moments: [] } },
            { timestamp: now - 10000, aiAnalysis: { overallScore: 6, moments: [] } },
            { timestamp: now - 11000, aiAnalysis: { overallScore: 6, moments: [] } },
            { timestamp: now - 12000, aiAnalysis: { overallScore: 6, moments: [] } },
            { timestamp: now - 13000, aiAnalysis: { overallScore: 6, moments: [] } },
        ];
        const memory = build(history);
        expect(memory.scoreTrend).toMatch(/mejorando/);
    });

    it('detecta tendencia "bajando"', () => {
        const now = Date.now();
        const history = [
            { timestamp: now - 1000, aiAnalysis: { overallScore: 5 } },
            { timestamp: now - 2000, aiAnalysis: { overallScore: 5 } },
            { timestamp: now - 3000, aiAnalysis: { overallScore: 5 } },
            { timestamp: now - 10000, aiAnalysis: { overallScore: 8 } },
            { timestamp: now - 11000, aiAnalysis: { overallScore: 8 } },
            { timestamp: now - 12000, aiAnalysis: { overallScore: 8 } },
        ];
        const memory = build(history);
        expect(memory.scoreTrend).toMatch(/bajando/);
    });

    it('agrupa notas de mejora recurrentes de varios análisis (sin duplicar)', () => {
        const now = Date.now();
        const history = [
            { timestamp: now, aiAnalysis: { moments: [
                { kind: 'improve', note: 'pulso inestable en frases rápidas' },
                { kind: 'good', note: 'buen fraseo' },
            ]}},
            { timestamp: now - 1000, aiAnalysis: { moments: [
                { kind: 'improve', note: 'dinámica plana' },
            ]}},
        ];
        const memory = build(history);
        expect(memory.recurringImproveNotes).toContain('pulso inestable en frases rápidas');
        expect(memory.recurringImproveNotes).toContain('dinámica plana');
        // "buen fraseo" es 'good', NO debería entrar en recurringImproveNotes
        expect(memory.recurringImproveNotes).not.toContain('buen fraseo');
    });

    it('acumula ejercicios previos para evitar repetición', () => {
        const history = [
            { timestamp: 3, aiAnalysis: { practiceExercise: { title: 'Ejercicio C' } } },
            { timestamp: 2, aiAnalysis: { practiceExercise: { title: 'Ejercicio B' } } },
            { timestamp: 1, aiAnalysis: { practiceSuggestions: [{ title: 'Ejercicio A (schema viejo)' }] } },
        ];
        const memory = build(history);
        expect(memory.recentExercises).toEqual(['Ejercicio C', 'Ejercicio B', 'Ejercicio A (schema viejo)']);
    });

    it('recolecta estilos declarados sin duplicar', () => {
        const history = [
            { timestamp: 3, metadata: { style: 'Bebop' } },
            { timestamp: 2, metadata: { style: 'bebop' } },
            { timestamp: 1, metadata: { style: 'Latin Jazz' } },
        ];
        const memory = build(history);
        expect(memory.stylesPracticed).toEqual(expect.arrayContaining(['bebop', 'latin jazz']));
        expect(memory.stylesPracticed).toHaveLength(2);
    });

    it('calcula lastSessionAgeDays correctamente', () => {
        const oneDayMs = 24 * 60 * 60 * 1000;
        const history = [
            { timestamp: Date.now() - 3 * oneDayMs, aiAnalysis: {} },
        ];
        const memory = build(history);
        expect(memory.lastSessionAgeDays).toBe(3);
    });

    it('limita a maxEntries pero conserva totalSessions real', () => {
        const history = Array.from({ length: 20 }, (_, i) => ({
            timestamp: 10000 - i,
            aiAnalysis: { overallScore: 5 },
        }));
        const memory = build(history, { maxEntries: 3 });
        expect(memory.totalSessions).toBe(20);
        expect(memory.recentSessions).toBe(3);
    });
});
