import { describe, it, expect } from 'vitest';
import { selectSegments } from '../assets/js/modules/AudioSegmentSelector.js';

// Helpers: fabricar analysis + derived plausibles según lo que produciría
// AudioAnalyzer + AudioFeatures.deriveFeatures en el flujo real.
function makeAnalysis(duration) {
    return { duration };
}
function makeSections(startEndDensityTriples) {
    return startEndDensityTriples.map(([start, end, dens], i) => ({
        section: i + 1,
        startSec: start,
        endSec: end,
        noteCount: 0,
        notesPerSecond: dens,
        lowestName: '--',
        highestName: '--',
        avgAmplitude: 0,
    }));
}

describe('selectSegments — sesiones fuera del rango útil', () => {
    it('devuelve [] cuando la sesión no tiene duración', () => {
        expect(selectSegments(makeAnalysis(0), {})).toEqual([]);
        expect(selectSegments({}, {})).toEqual([]);
        expect(selectSegments(null, null)).toEqual([]);
    });

    it('devuelve [] cuando la sesión es más corta que minSessionDurationSec', () => {
        expect(selectSegments(makeAnalysis(2), {})).toEqual([]);
    });

    it('devuelve un único fragmento completo cuando la sesión es ≤ directSendMaxSec', () => {
        const result = selectSegments(makeAnalysis(6), {});
        expect(result).toHaveLength(1);
        expect(result[0].startSec).toBe(0);
        expect(result[0].endSec).toBe(6);
        expect(result[0].kind).toBe('representative');
        expect(result[0].reason).toMatch(/corta/i);
    });
});

describe('selectSegments — sesión larga sin señales derivadas', () => {
    it('devuelve al menos el fragmento representativo (mitad de la sesión)', () => {
        const result = selectSegments(makeAnalysis(60), {});
        expect(result.length).toBeGreaterThanOrEqual(1);
        const rep = result.find(s => s.kind === 'representative');
        expect(rep).toBeDefined();
        // Ventana de 8s centrada en 30 → [26, 34].
        expect(rep.startSec).toBeCloseTo(26, 1);
        expect(rep.endSec).toBeCloseTo(34, 1);
    });
});

describe('selectSegments — usa secciones para elegir interesante y contrast', () => {
    it('elige el tramo de mayor densidad como "interesting"', () => {
        const derived = {
            sections: makeSections([
                [0, 20, 1.0],
                [20, 40, 8.5],   // pico de densidad
                [40, 60, 2.0],
            ]),
        };
        const result = selectSegments(makeAnalysis(60), derived);
        const interesting = result.find(s => s.kind === 'interesting');
        expect(interesting).toBeDefined();
        // Ventana centrada en 30 (mitad de [20, 40]).
        expect(interesting.startSec).toBeCloseTo(26, 1);
        expect(interesting.endSec).toBeCloseTo(34, 1);
        expect(interesting.reason).toMatch(/densidad/i);
    });

    it('prioriza rush/drag notorio como "contrast" sobre el outlier de densidad', () => {
        const derived = {
            sections: makeSections([
                [0, 20, 3.0],
                [20, 40, 3.2],
                [40, 60, 3.1],   // sin outlier
            ]),
            rushDrag: {
                firstThirdBpm: 120,
                lastThirdBpm: 138,
                deltaFirstToLast: 18,
                tendency: 'acelerando notorio',
            },
        };
        const result = selectSegments(makeAnalysis(60), derived);
        const contrast = result.find(s => s.kind === 'contrast');
        expect(contrast).toBeDefined();
        expect(contrast.reason).toMatch(/deriva|acelerando|BPM/i);
        // 5/6 del total (60) = 50 → ventana [46, 54].
        expect(contrast.startSec).toBeCloseTo(46, 1);
    });

    it('cae a outlier de densidad como "contrast" si no hay rush/drag notorio', () => {
        const derived = {
            sections: makeSections([
                [0, 20, 3.0],
                [20, 40, 3.2],
                [40, 60, 10.0],   // outlier claro respecto al promedio ~5.4
            ]),
            rushDrag: {
                firstThirdBpm: 120,
                lastThirdBpm: 121,
                deltaFirstToLast: 1,
                tendency: 'estable',
            },
        };
        const result = selectSegments(makeAnalysis(60), derived);
        const contrast = result.find(s => s.kind === 'contrast');
        expect(contrast).toBeDefined();
        expect(contrast.reason).toMatch(/contraste|densidad/i);
    });
});

describe('selectSegments — invariantes duras', () => {
    it('no supera maxSegments', () => {
        const derived = {
            sections: makeSections([
                [0, 20, 1.0],
                [20, 40, 8.5],
                [40, 60, 10.0],
            ]),
            rushDrag: { firstThirdBpm: 100, lastThirdBpm: 130, deltaFirstToLast: 30, tendency: 'acelerando' },
        };
        const result = selectSegments(makeAnalysis(60), derived);
        expect(result.length).toBeLessThanOrEqual(3);
    });

    it('no supera maxTotalAudioSec en la suma total', () => {
        const derived = {
            sections: makeSections([
                [0, 20, 1.0],
                [20, 40, 8.5],
                [40, 60, 10.0],
            ]),
            rushDrag: { firstThirdBpm: 100, lastThirdBpm: 130, deltaFirstToLast: 30, tendency: 'acelerando' },
        };
        const result = selectSegments(makeAnalysis(60), derived);
        const total = result.reduce((s, x) => s + (x.endSec - x.startSec), 0);
        expect(total).toBeLessThanOrEqual(24 + 0.01);
    });

    it('no genera fragmentos que se superpongan', () => {
        const derived = {
            sections: makeSections([
                [0, 20, 5.0],
                [20, 40, 5.1],   // outlier apenas por encima del promedio, casi al centro
                [40, 60, 5.0],
            ]),
        };
        const result = selectSegments(makeAnalysis(60), derived);
        for (let i = 0; i < result.length; i++) {
            for (let j = i + 1; j < result.length; j++) {
                const a = result[i], b = result[j];
                const overlaps = !(a.endSec <= b.startSec || b.endSec <= a.startSec);
                expect(overlaps).toBe(false);
            }
        }
    });

    it('devuelve los segmentos ordenados cronológicamente', () => {
        const derived = {
            sections: makeSections([
                [0, 20, 10.0],   // interesting acá (arranque)
                [20, 40, 1.0],
                [40, 60, 3.0],
            ]),
            rushDrag: { firstThirdBpm: 100, lastThirdBpm: 120, deltaFirstToLast: 20, tendency: 'acelerando' },
        };
        const result = selectSegments(makeAnalysis(90), derived);
        for (let i = 1; i < result.length; i++) {
            expect(result[i].startSec).toBeGreaterThanOrEqual(result[i - 1].startSec);
        }
    });

    it('respeta config custom (maxSegments=1)', () => {
        const derived = {
            sections: makeSections([[0, 20, 10.0], [20, 40, 1.0], [40, 60, 3.0]]),
        };
        const result = selectSegments(makeAnalysis(60), derived, { maxSegments: 1 });
        expect(result).toHaveLength(1);
    });
});
