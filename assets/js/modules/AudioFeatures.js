// AudioFeatures.js — derivación de features musicalmente hablables.
//
// Toma el output crudo de AudioAnalyzer (essentia + basic-pitch) y produce
// observaciones concretas que la IA puede citar con números en su análisis.
// Sin esto, la IA solo ve promedios planos y responde en generalidades.
//
// Todas las funciones son puras y aceptan entradas parciales o vacías —
// devuelven null para la observación cuando no hay datos suficientes.

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiToName(midi) {
    const n = Number(midi);
    if (!Number.isFinite(n) || n <= 0) return '--';
    const octave = Math.floor(n / 12) - 1;
    return `${NOTE_NAMES[n % 12]}${octave}`;
}

function noteStart(n)    { return Number(n?.startTimeSeconds ?? n?.start ?? 0); }
function noteDuration(n) { return Number(n?.durationSeconds ?? n?.duration ?? 0); }
function notePitch(n)    { return Number(n?.pitchMidi ?? n?.pitch ?? 0); }
function noteAmp(n)      { return Number(n?.amplitude ?? 0); }

// Estabilidad del pulso a partir de los ticks (timeline de beats) de Essentia.
// coefficientOfVariation < 0.03 → pulso muy firme; > 0.12 → tempo se te va.
export function beatConsistency(ticks) {
    if (!Array.isArray(ticks) || ticks.length < 3) return null;

    const intervals = [];
    for (let i = 1; i < ticks.length; i++) {
        intervals.push(ticks[i] - ticks[i - 1]);
    }
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance = intervals.reduce((s, v) => s + (v - mean) ** 2, 0) / intervals.length;
    const std = Math.sqrt(variance);
    const cv = mean > 0 ? std / mean : 0;

    let stability;
    if (cv < 0.03)       stability = 'muy estable';
    else if (cv < 0.06)  stability = 'estable';
    else if (cv < 0.12)  stability = 'algo inestable';
    else                 stability = 'inestable';

    return {
        beatCount: ticks.length,
        meanIntervalMs: Math.round(mean * 1000),
        stdMs: Math.round(std * 1000),
        coefficientOfVariation: Number(cv.toFixed(3)),
        stability,
    };
}

// Comparación de tempo entre el primer y último tercio: detecta rush/drag.
export function rushDragThirds(ticks, duration) {
    if (!Array.isArray(ticks) || ticks.length < 6) return null;
    const dur = Number(duration);
    if (!Number.isFinite(dur) || dur <= 0) return null;

    const third = dur / 3;
    const buckets = [[], [], []];
    for (let i = 1; i < ticks.length; i++) {
        const interval = ticks[i] - ticks[i - 1];
        const idx = Math.min(2, Math.max(0, Math.floor(ticks[i - 1] / third)));
        buckets[idx].push(interval);
    }

    const bpmOf = (arr) => {
        if (!arr.length) return null;
        const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
        return avg > 0 ? 60 / avg : null;
    };

    const first = bpmOf(buckets[0]);
    const mid = bpmOf(buckets[1]);
    const last = bpmOf(buckets[2]);
    if (first == null || last == null) return null;

    const delta = last - first;
    let tendency;
    if (Math.abs(delta) < 2) tendency = 'estable de principio a fin';
    else if (delta > 0)      tendency = `acelerando (${delta > 5 ? 'notorio' : 'leve'})`;
    else                     tendency = `arrastrando (${Math.abs(delta) > 5 ? 'notorio' : 'leve'})`;

    return {
        firstThirdBpm: Math.round(first),
        middleThirdBpm: mid ? Math.round(mid) : null,
        lastThirdBpm: Math.round(last),
        deltaFirstToLast: Number(delta.toFixed(1)),
        tendency,
    };
}

// Estadísticas globales de las notas MIDI transcritas por basic-pitch:
// densidad, rango, articulación (staccato/legato), dinámica real.
export function noteStats(notes, duration) {
    if (!Array.isArray(notes) || notes.length === 0) return null;
    const dur = Number(duration);
    if (!Number.isFinite(dur) || dur <= 0) return null;

    const pitches = notes.map(notePitch).filter(p => p > 0);
    if (pitches.length === 0) return null;

    const durs = notes.map(noteDuration).filter(Number.isFinite);
    const amps = notes.map(noteAmp).filter(Number.isFinite);

    const density = notes.length / dur;
    const lowest = Math.min(...pitches);
    const highest = Math.max(...pitches);
    const span = highest - lowest;

    const meanDur = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : 0;
    const avgAmp = amps.length ? amps.reduce((a, b) => a + b, 0) / amps.length : 0;
    const ampStd = amps.length
        ? Math.sqrt(amps.reduce((s, v) => s + (v - avgAmp) ** 2, 0) / amps.length)
        : 0;
    const dynamicVariation = avgAmp > 0 ? ampStd / avgAmp : 0;

    let density_label;
    if (density < 2)      density_label = 'espaciada';
    else if (density < 5) density_label = 'moderada';
    else if (density < 9) density_label = 'densa';
    else                  density_label = 'muy densa';

    let articulation;
    if (meanDur < 0.15)     articulation = 'staccato / muy corto';
    else if (meanDur < 0.4) articulation = 'medio';
    else                    articulation = 'legato / sostenido';

    let dynamics;
    if (dynamicVariation < 0.15)      dynamics = 'plano';
    else if (dynamicVariation < 0.3)  dynamics = 'moderado';
    else if (dynamicVariation < 0.5)  dynamics = 'expresivo';
    else                              dynamics = 'muy contrastado';

    return {
        totalNotes: notes.length,
        notesPerSecond: Number(density.toFixed(2)),
        density: density_label,
        lowestMidi: lowest,
        highestMidi: highest,
        lowestName: midiToName(lowest),
        highestName: midiToName(highest),
        spanSemitones: span,
        spanOctaves: Number((span / 12).toFixed(1)),
        meanNoteDurationMs: Math.round(meanDur * 1000),
        articulation,
        avgAmplitude: Number(avgAmp.toFixed(2)),
        dynamicVariationCV: Number(dynamicVariation.toFixed(2)),
        dynamics,
    };
}

// Histograma de clases de nota (12 pitch classes) — sirve para inferir modo
// real de la interpretación vs la tonalidad plana que detecta Essentia.
export function pitchClassProfile(notes) {
    if (!Array.isArray(notes) || notes.length === 0) return null;

    const hist = new Array(12).fill(0);
    for (const n of notes) {
        const p = notePitch(n);
        if (p > 0) hist[p % 12] += 1;
    }
    const total = hist.reduce((a, b) => a + b, 0);
    if (total === 0) return null;

    const withNames = hist.map((count, i) => ({
        note: NOTE_NAMES[i],
        count,
        pct: Number(((count / total) * 100).toFixed(1)),
    }));
    const sorted = [...withNames].sort((a, b) => b.count - a.count);

    return {
        top3: sorted.slice(0, 3),
        unusedNotes: withNames.filter(x => x.count === 0).map(x => x.note),
        pitchClassesUsed: withNames.filter(x => x.count > 0).length,
    };
}

// Ratio de silencio: cuánto del audio está sin notas sonando.
export function silenceRatio(notes, duration) {
    const dur = Number(duration);
    if (!Number.isFinite(dur) || dur <= 0) return null;
    if (!Array.isArray(notes) || notes.length === 0) {
        return { coverageSec: 0, silenceRatio: 1, interpretation: 'sin notas detectadas' };
    }

    // Unión de intervalos de notas para calcular cobertura real.
    const intervals = notes
        .map(n => [noteStart(n), noteStart(n) + noteDuration(n)])
        .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
        .sort((a, b) => a[0] - b[0]);

    if (intervals.length === 0) {
        return { coverageSec: 0, silenceRatio: 1, interpretation: 'sin notas válidas' };
    }

    let covered = 0;
    let [curStart, curEnd] = intervals[0];
    for (let i = 1; i < intervals.length; i++) {
        const [s, e] = intervals[i];
        if (s <= curEnd) {
            curEnd = Math.max(curEnd, e);
        } else {
            covered += curEnd - curStart;
            curStart = s;
            curEnd = e;
        }
    }
    covered += curEnd - curStart;
    covered = Math.min(covered, dur);

    const ratio = covered / dur;
    const silence = 1 - ratio;

    let interpretation;
    if (ratio > 0.85)      interpretation = 'muy denso, casi sin respiraciones';
    else if (ratio > 0.6)  interpretation = 'balanceado entre notas y silencio';
    else if (ratio > 0.35) interpretation = 'espacioso, con silencios notables';
    else                   interpretation = 'muy espacioso, mucho silencio';

    return {
        coverageSec: Number(covered.toFixed(2)),
        silenceRatio: Number(silence.toFixed(2)),
        interpretation,
    };
}

// Perfil por secciones (por defecto 3): densidad, rango y dinámica en cada
// tercio de la grabación. Le da a la IA algo concreto para decir "en el
// primer tercio hiciste X, en el último cambiaste a Y".
export function sectionProfile(notes, duration, numSections = 3) {
    const dur = Number(duration);
    if (!Number.isFinite(dur) || dur <= 0) return null;
    if (!Array.isArray(notes)) return null;

    const sectionDur = dur / numSections;
    const out = [];
    for (let s = 0; s < numSections; s++) {
        const start = s * sectionDur;
        const end = start + sectionDur;
        const inSec = notes.filter(n => {
            const t = noteStart(n);
            return t >= start && t < end;
        });
        const pitches = inSec.map(notePitch).filter(p => p > 0);
        const amps = inSec.map(noteAmp).filter(Number.isFinite);
        const avgAmp = amps.length ? amps.reduce((a, b) => a + b, 0) / amps.length : 0;

        out.push({
            section: s + 1,
            startSec: Number(start.toFixed(1)),
            endSec: Number(end.toFixed(1)),
            noteCount: inSec.length,
            notesPerSecond: sectionDur > 0 ? Number((inSec.length / sectionDur).toFixed(2)) : 0,
            lowestName: pitches.length ? midiToName(Math.min(...pitches)) : '--',
            highestName: pitches.length ? midiToName(Math.max(...pitches)) : '--',
            avgAmplitude: Number(avgAmp.toFixed(2)),
        });
    }
    return out;
}

// Punto de entrada único: toma la salida cruda de AudioAnalyzer y produce
// todas las observaciones derivadas. Cualquier feature con datos insuficientes
// aparece como null; el consumidor decide si mostrarlo o no.
export function deriveFeatures(analysis) {
    if (!analysis || typeof analysis !== 'object') return {};

    const duration = Number(analysis.duration || 0);
    const ticks = analysis?.tempo?.ticks;
    const notes = Array.isArray(analysis.midiNotes) ? analysis.midiNotes : [];

    return {
        beat: beatConsistency(ticks),
        rushDrag: rushDragThirds(ticks, duration),
        notes: noteStats(notes, duration),
        pitchClass: pitchClassProfile(notes),
        silence: silenceRatio(notes, duration),
        sections: sectionProfile(notes, duration, 3),
    };
}
