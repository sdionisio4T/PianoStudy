// AudioSegmentSelector.js — decide qué 1-3 fragmentos merecen que Gemini los
// escuche. Usa las señales que YA calcula AudioFeatures.js (densidad por
// tercios, rush/drag, silencio, etc.); no vuelve a mirar el audio crudo.
//
// Filosofía:
// - Nunca aleatorio a ciegas: cada fragmento tiene un "reason" concreto.
// - Combinación intentada: 1 representativo + 1 interesante + 1 contrastante.
//   Si no hay suficientes eventos, devolvemos menos — no inventamos.
// - Los timestamps son SIEMPRE los originales de la grabación (para que la UI
//   pueda anclar observaciones auditivas al waveform del usuario).

import { GEMINI_AUDIO_CONFIG } from './GeminiAudioConfig.js';

function overlaps(a, b) {
    return !(a.endSec <= b.startSec || b.endSec <= a.startSec);
}

function totalCovered(list) {
    return list.reduce((s, x) => s + (x.endSec - x.startSec), 0);
}

// Encuadra una ventana de `durationSec` centrada en `centerSec`, respetando
// [0, totalDur]. Si se sale por un borde, se desplaza al opuesto sin recortar.
function windowAround(centerSec, durationSec, totalDur) {
    const half = durationSec / 2;
    let start = centerSec - half;
    let end = centerSec + half;
    if (start < 0) { end -= start; start = 0; }
    if (end > totalDur) { start -= (end - totalDur); end = totalDur; }
    start = Math.max(0, start);
    end = Math.min(totalDur, end);
    return { startSec: Number(start.toFixed(2)), endSec: Number(end.toFixed(2)) };
}

// Agrega `seg` si no solapa con ninguno ya elegido y hay presupuesto. Recorta
// la duración del clip si el presupuesto no alcanza para el clip completo.
function tryPush(list, seg, totalDur, budgetSec) {
    if (!seg) return;
    if (list.some(x => overlaps(x, seg))) return;
    const remaining = budgetSec - totalCovered(list);
    if (remaining <= 0.5) return;
    const desired = seg.endSec - seg.startSec;
    let clipped = { ...seg };
    if (desired > remaining) {
        clipped.endSec = clipped.startSec + remaining;
    }
    clipped.endSec = Math.min(totalDur, clipped.endSec);
    if (clipped.endSec - clipped.startSec < 1) return;   // <1s no aporta
    list.push(clipped);
}

// Punto de entrada. `audioAnalysis` = salida de AudioAnalyzer, `derived` =
// salida de deriveFeatures(audioAnalysis). Devuelve un array (posiblemente
// vacío) de fragmentos ordenados por timestamp.
export function selectSegments(audioAnalysis, derived, config = {}) {
    const cfg = { ...GEMINI_AUDIO_CONFIG, ...config };
    const totalDur = Number(audioAnalysis?.duration || 0);

    if (!(totalDur > 0)) return [];
    if (totalDur < cfg.minSessionDurationSec) return [];

    // Sesión corta: sin selector, se manda entera (el proxy sigue teniendo
    // rate-limit específico de audio, así que no hay riesgo de abuso).
    if (totalDur <= cfg.directSendMaxSec) {
        return [{
            startSec: 0,
            endSec: Number(totalDur.toFixed(2)),
            reason: 'sesión corta — se envía completa',
            kind: 'representative',
        }];
    }

    const segments = [];
    const segDur = Math.min(cfg.segmentDurationSec, totalDur);
    const budget = cfg.maxTotalAudioSec;
    const sections = Array.isArray(derived?.sections) ? derived.sections : [];
    const withDensity = sections.filter(s => Number.isFinite(s?.notesPerSecond) && s.notesPerSecond > 0);

    // Prueba una lista de candidatos ordenados por preferencia hasta que uno
    // logre entrar (los que se superponen a lo ya elegido se descartan). Sirve
    // para que INTERESTING/CONTRAST siempre acaben eligiendo algo distinto,
    // no que compitan por la misma ventana del medio.
    const tryAnyCandidate = (candidates) => {
        for (const c of candidates) {
            const before = segments.length;
            tryPush(segments, c, totalDur, budget);
            if (segments.length > before) return true;
        }
        return false;
    };

    // 1) INTERESANTE — secciones ordenadas por densidad descendente. Si Basic
    //    Pitch no devolvió notas, `withDensity` queda vacío y esta rama no
    //    aporta clip extra (nos apoyamos en representativo + contrast).
    if (withDensity.length) {
        const sorted = [...withDensity].sort((a, b) => b.notesPerSecond - a.notesPerSecond);
        tryAnyCandidate(sorted.map(s => {
            const w = windowAround((s.startSec + s.endSec) / 2, segDur, totalDur);
            return {
                ...w,
                reason: `mayor densidad melódica (~${s.notesPerSecond.toFixed(1)} notas/s entre ${s.startSec}s y ${s.endSec}s)`,
                kind: 'interesting',
            };
        }));
    }

    // 2) CONTRASTANTE — priorizar tempo con deriva notoria (rush/drag > 5 BPM
    //    entre primer y último tercio). Si no hay deriva, la sección con
    //    densidad más lejana al promedio (probamos por orden de "distancia" al
    //    promedio, así si la más extrema ya está tomada por interesting se cae
    //    a la siguiente).
    if (segments.length < cfg.maxSegments) {
        const rd = derived?.rushDrag;
        const notoriousDrift = rd && Math.abs(Number(rd.deltaFirstToLast) || 0) > 5;
        if (notoriousDrift) {
            const w = windowAround(totalDur * (5 / 6), segDur, totalDur);
            tryPush(segments, {
                ...w,
                reason: `tempo con deriva perceptible: ${rd.tendency} (${rd.firstThirdBpm} → ${rd.lastThirdBpm} BPM)`,
                kind: 'contrast',
            }, totalDur, budget);
        } else if (withDensity.length >= 2) {
            const avg = withDensity.reduce((s, x) => s + x.notesPerSecond, 0) / withDensity.length;
            const sortedByDelta = [...withDensity]
                .sort((a, b) => Math.abs(b.notesPerSecond - avg) - Math.abs(a.notesPerSecond - avg));
            tryAnyCandidate(sortedByDelta.map(s => {
                const w = windowAround((s.startSec + s.endSec) / 2, segDur, totalDur);
                return {
                    ...w,
                    reason: `contraste interno: densidad ${s.notesPerSecond.toFixed(1)} n/s vs promedio ${avg.toFixed(1)} n/s`,
                    kind: 'contrast',
                };
            }));
        }
    }

    // 3) REPRESENTATIVO — ventana en el centro de la sesión. Va último para
    //    llenar espacio si sobra; si el centro ya lo cubrió un clip más
    //    específico (interesting/contrast), no se agrega duplicado.
    if (segments.length < cfg.maxSegments) {
        const rep = windowAround(totalDur / 2, segDur, totalDur);
        tryPush(segments, {
            ...rep,
            reason: 'ventana representativa (mitad de la sesión)',
            kind: 'representative',
        }, totalDur, budget);
    }

    // Nada logró entrar (ej. sesión larga con Basic Pitch falló, sin ticks
    // útiles y algún corner case). Forzar un representativo mínimo — es mejor
    // enviar el centro que quedarse sin nada.
    if (segments.length === 0) {
        const rep = windowAround(totalDur / 2, segDur, totalDur);
        segments.push({
            ...rep,
            reason: 'ventana representativa (mitad de la sesión)',
            kind: 'representative',
        });
    }

    segments.sort((a, b) => a.startSec - b.startSec);
    return segments.slice(0, cfg.maxSegments);
}
