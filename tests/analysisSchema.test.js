import { describe, it, expect, vi } from 'vitest';

// AIAnalysisEngine importa supabase-client.js — necesitamos el mock antes de
// importar el engine para que no explote al cargar. La validación es un método
// puro, no toca red, así que un stub vacío alcanza.
vi.mock('../assets/js/modules/supabase-client.js', () => ({
    db: { functions: { invoke: vi.fn() } },
}));

const { AIAnalysisEngine } = await import('../assets/js/modules/AIAnalysisEngine.js');
const engine = new AIAnalysisEngine();

// Helper para armar respuestas plausibles del LLM con overrides.
const baseValid = (over = {}) => ({
    overallScore: 7,
    musicalAnalysis: 'Interpretación con energía sostenida durante toda la toma.',
    practiceExercise: {
        title: 'Notas estructurales primero',
        steps: [
            'Elegí un fragmento de 4-8 compases.',
            'Tocalo a 90 BPM con solo las notas estructurales.',
        ],
        checkQuestion: '¿La frase sigue siendo reconocible al volver al tempo original?',
        durationMin: 10,
    },
    ...over,
});

describe('validateAnalysisSchema — nuevo formato de ejercicio', () => {
    it('acepta el schema nuevo con steps + checkQuestion', () => {
        const r = engine.validateAnalysisSchema(baseValid());
        expect(r.ok).toBe(true);
        expect(r.value.practiceExercise.steps).toHaveLength(2);
        expect(r.value.practiceExercise.checkQuestion).toMatch(/reconocible/);
    });

    it('mantiene compatibilidad con el schema viejo (description prosa, sin steps)', () => {
        const r = engine.validateAnalysisSchema(baseValid({
            practiceExercise: {
                title: 'Metrónomo escalonado',
                description: 'Tomá un fragmento de 8 compases y tocalo con metrónomo a 90 BPM, después a 100.',
                durationMin: 10,
            },
        }));
        expect(r.ok).toBe(true);
        expect(r.value.practiceExercise.description).toMatch(/metrónomo/);
        expect(r.value.practiceExercise.steps).toEqual([]);
    });

    it('rechaza cuando no hay ni steps ni description', () => {
        const r = engine.validateAnalysisSchema(baseValid({
            practiceExercise: { title: 'Sin cuerpo', durationMin: 10 },
        }));
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/steps.*description/);
    });

    it('recorta steps a máximo 4 y filtra strings vacíos', () => {
        const r = engine.validateAnalysisSchema(baseValid({
            practiceExercise: {
                title: 'Muchos pasos',
                steps: ['a', '', 'b', '   ', 'c', 'd', 'e', 'f'],
                checkQuestion: '¿ok?',
                durationMin: 8,
            },
        }));
        expect(r.ok).toBe(true);
        expect(r.value.practiceExercise.steps).toEqual(['a', 'b', 'c', 'd']);
    });

    it('acepta un solo step siempre que exista description como fallback', () => {
        // 1 step no alcanza para "nuevo formato" (necesita ≥2), pero si viene
        // description queda como schema viejo y el 1 step queda ahí igual.
        const r = engine.validateAnalysisSchema(baseValid({
            practiceExercise: {
                title: 'Uno solo',
                steps: ['Único paso'],
                description: 'Prosa larga que explica el ejercicio.',
                durationMin: 10,
            },
        }));
        expect(r.ok).toBe(true);
        expect(r.value.practiceExercise.steps).toEqual(['Único paso']);
        expect(r.value.practiceExercise.description).toMatch(/prosa/i);
    });
});

describe('validateAnalysisSchema — strengths', () => {
    it('acepta hasta 2 fortalezas', () => {
        const r = engine.validateAnalysisSchema(baseValid({
            strengths: ['Pulso muy estable', 'Buen contraste dinámico'],
        }));
        expect(r.ok).toBe(true);
        expect(r.value.strengths).toEqual(['Pulso muy estable', 'Buen contraste dinámico']);
    });

    it('trunca a 2 si el LLM devuelve más', () => {
        const r = engine.validateAnalysisSchema(baseValid({
            strengths: ['una', 'dos', 'tres', 'cuatro'],
        }));
        expect(r.value.strengths).toEqual(['una', 'dos']);
    });

    it('deduplica strings idénticos', () => {
        const r = engine.validateAnalysisSchema(baseValid({
            strengths: ['pulso estable', 'pulso estable', 'contraste'],
        }));
        expect(r.value.strengths).toEqual(['pulso estable', 'contraste']);
    });

    it('filtra strings vacíos y trims', () => {
        const r = engine.validateAnalysisSchema(baseValid({
            strengths: ['  con espacios  ', '', '   '],
        }));
        expect(r.value.strengths).toEqual(['con espacios']);
    });

    it('devuelve array vacío cuando strengths no viene (soft-required)', () => {
        const r = engine.validateAnalysisSchema(baseValid());
        expect(r.value.strengths).toEqual([]);
    });
});

describe('validateAnalysisSchema — primaryFocus', () => {
    it('acepta primaryFocus string', () => {
        const r = engine.validateAnalysisSchema(baseValid({
            primaryFocus: 'Explorar si la línea principal se percibe destacada.',
        }));
        expect(r.value.primaryFocus).toMatch(/línea principal/);
    });

    it('trimea whitespace', () => {
        const r = engine.validateAnalysisSchema(baseValid({
            primaryFocus: '   foco con espacios   ',
        }));
        expect(r.value.primaryFocus).toBe('foco con espacios');
    });

    it('devuelve null cuando falta o está vacío (soft-required)', () => {
        expect(engine.validateAnalysisSchema(baseValid()).value.primaryFocus).toBeNull();
        expect(engine.validateAnalysisSchema(baseValid({ primaryFocus: '' })).value.primaryFocus).toBeNull();
        expect(engine.validateAnalysisSchema(baseValid({ primaryFocus: '   ' })).value.primaryFocus).toBeNull();
    });
});

describe('validateAnalysisSchema — observations cap 3', () => {
    it('trunca a 3 observaciones (antes eran 4)', () => {
        const obs = Array.from({ length: 5 }, (_, i) => ({
            fact: `fact ${i}`,
            interpretation: `interp ${i}`,
            recommendation: `rec ${i}`,
            confidence: 'medium',
        }));
        const r = engine.validateAnalysisSchema(baseValid({ observations: obs }));
        expect(r.value.observations).toHaveLength(3);
    });

    it('descarta observaciones incompletas (falta alguna de las tres capas)', () => {
        const r = engine.validateAnalysisSchema(baseValid({
            observations: [
                { fact: 'a', interpretation: 'b', recommendation: 'c', confidence: 'high' },
                { fact: 'sin interp', recommendation: 'c', confidence: 'high' },
                { fact: '', interpretation: 'b', recommendation: 'c' },
            ],
        }));
        expect(r.value.observations).toHaveLength(1);
        expect(r.value.observations[0].fact).toBe('a');
    });
});
