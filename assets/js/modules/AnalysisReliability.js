// AnalysisReliability.js — capa de confiabilidad entre el análisis crudo y el
// LLM. NO corrige datos: los envuelve con etiquetas que el LLM lee para
// decidir sobre qué se puede afirmar y sobre qué no.
//
// Diseño:
// - Puro (sin efectos). Testeable en Node.
// - Independiente por señal: la tonalidad puede ser 'unreliable' y el tempo
//   seguir siendo 'high'.
// - Pesimista por defecto. En la duda, marcar como 'low' — es mejor decir
//   "no hay evidencia suficiente" que inventar una conclusión.
// - Explicable: cada tier incluye `evidence`/`reasons_for_hedge` para que el
//   humano revisando logs (y el propio LLM) entienda POR QUÉ se degradó.
//
// Salida: un objeto con { tempo, key, transcription, melody,
// reliable_signals[], unreliable_signals[], overall_data_quality } que se
// pasa a AIAnalysisEngine.analyzePerformance como 5º parámetro.

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

// Piano acústico: A0 (MIDI 21) → C8 (MIDI 108). Notas fuera son casi siempre
// artefactos de basic-pitch (parciales altos de un ataque fuerte se ven como
// notas por arriba de C8; ruido de sala o pedal como notas por debajo de A0).
const PIANO_MIN_MIDI = 21;
const PIANO_MAX_MIDI = 108;

const NOTE_TO_PC = (name) => {
    const table = { 'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3, 'E': 4, 'F': 5, 'F#': 6, 'Gb': 6, 'G': 7, 'G#': 8, 'Ab': 8, 'A': 9, 'A#': 10, 'Bb': 10, 'B': 11 };
    const k = String(name || '').trim();
    return Object.prototype.hasOwnProperty.call(table, k) ? table[k] : null;
};

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

const noteStart = (n) => Number(n?.startTimeSeconds ?? n?.start ?? 0);
const noteDur = (n) => Number(n?.durationSeconds ?? n?.duration ?? 0);
const notePitch = (n) => Number(n?.pitchMidi ?? n?.pitch ?? 0);

// ─── TRANSCRIPCIÓN (basic-pitch) ─────────────────────────────────────────────
// Heurística rápida — no científica. Suma penalizaciones por señales que
// indican transcripción mala/artefactos y devuelve score∈[0,1] + banda.
export function assessTranscription(audioAnalysis) {
    const notes = Array.isArray(audioAnalysis?.midiNotes) ? audioAnalysis.midiNotes : [];
    const duration = Number(audioAnalysis?.duration || 0);
    const failed = Array.isArray(audioAnalysis?.providersFailed) ? audioAnalysis.providersFailed : [];

    if (!notes.length) {
        const failedBasicPitch = failed.some(p => String(p).includes('basic-pitch'));
        return {
            available: false,
            score: 0,
            level: 'unreliable',
            warnings: [failedBasicPitch
                ? 'basic-pitch no devolvió notas (falla técnica del transcriptor)'
                : 'basic-pitch no encontró notas transcribibles en el audio'],
            evidence: [],
        };
    }

    const total = notes.length;
    const warnings = [];
    const evidence = [];
    let penalty = 0;

    // 1) Notas muy cortas (<40 ms) — sombra típica de basic-pitch en pasajes
    //    con reverberación o pedal sostenuto.
    const veryShort = notes.filter(n => noteDur(n) > 0 && noteDur(n) < 0.04).length;
    const shortRatio = veryShort / total;
    if (shortRatio > 0.10) {
        warnings.push(`${Math.round(shortRatio * 100)}% de notas < 40 ms (posibles artefactos)`);
        penalty += Math.min(0.30, shortRatio * 1.5);
    }
    evidence.push(`short-note-ratio=${shortRatio.toFixed(2)}`);

    // 2) Duplicados: dos notas con el mismo pitch que arrancan a <30 ms una de
    //    la otra. Suele pasar cuando el modelo dispara onset y contour separados.
    const sortedByStart = [...notes].sort((a, b) => noteStart(a) - noteStart(b));
    let duplicates = 0;
    for (let i = 1; i < sortedByStart.length; i++) {
        if (Math.abs(noteStart(sortedByStart[i]) - noteStart(sortedByStart[i - 1])) < 0.03
            && notePitch(sortedByStart[i]) === notePitch(sortedByStart[i - 1])) {
            duplicates++;
        }
    }
    const dupRatio = duplicates / total;
    if (dupRatio > 0.05) {
        warnings.push(`${Math.round(dupRatio * 100)}% de notas duplicadas (mismo pitch, comienzos casi simultáneos)`);
        penalty += Math.min(0.20, dupRatio * 2);
    }
    evidence.push(`duplicate-ratio=${dupRatio.toFixed(2)}`);

    // 3) Notas fuera del rango físico del piano — casi siempre artefacto.
    const outOfRange = notes.filter(n => {
        const p = notePitch(n);
        return p > 0 && (p < PIANO_MIN_MIDI || p > PIANO_MAX_MIDI);
    }).length;
    const outRatio = outOfRange / total;
    if (outRatio > 0.02) {
        warnings.push(`${Math.round(outRatio * 100)}% de notas fuera del rango del piano (A0–C8)`);
        penalty += Math.min(0.15, outRatio * 3);
    }
    evidence.push(`out-of-range-ratio=${outRatio.toFixed(2)}`);

    // 4) Densidad global extrema — más de 15 notas/seg promedio es raro
    //    incluso en solos de bebop rápidos; suele indicar errores.
    const density = duration > 0 ? total / duration : 0;
    if (density > 15) {
        warnings.push(`densidad global extrema (${density.toFixed(1)} notas/seg)`);
        penalty += Math.min(0.20, (density - 15) / 30);
    }
    evidence.push(`density=${density.toFixed(2)}`);

    // 5) Simultaneidad extrema — >8 notas activas al mismo tiempo en piano
    //    solo es implausible (dos manos = 10 dedos, y muchas no suenan a la vez).
    const events = [];
    for (const n of notes) {
        const s = noteStart(n);
        const d = noteDur(n);
        if (d <= 0) continue;
        events.push({ t: s, delta: 1 });
        events.push({ t: s + d, delta: -1 });
    }
    events.sort((a, b) => a.t - b.t || b.delta - a.delta);
    let active = 0, maxActive = 0;
    for (const e of events) {
        active += e.delta;
        if (active > maxActive) maxActive = active;
    }
    if (maxActive > 8) {
        warnings.push(`hasta ${maxActive} notas simultáneas (poco plausible en piano solo)`);
        penalty += Math.min(0.15, (maxActive - 8) / 20);
    }
    evidence.push(`max-simultaneous=${maxActive}`);

    const score = clamp01(1 - penalty);
    let level;
    if (score >= 0.75) level = 'high';
    else if (score >= 0.50) level = 'medium';
    else if (score >= 0.25) level = 'low';
    else level = 'unreliable';

    return {
        available: true,
        score: Number(score.toFixed(2)),
        level,
        warnings,
        evidence,
    };
}

// ─── TONALIDAD (essentia KeyExtractor + corroboración basic-pitch) ───────────
// Combina la `strength` de essentia con la evidencia de las pitch classes de
// la transcripción (si es confiable). Si los top pitch classes no pertenecen
// a la escala detectada, la tonalidad se degrada aunque essentia esté seguro.
export function assessKey(audioAnalysis, transcriptionAssessment) {
    const keyObj = audioAnalysis?.key || {};
    const value = String(keyObj.key || '').trim();
    const mode = String(keyObj.scale || '').trim();
    const confidence = clamp01(keyObj.strength);

    if (!value || value.toLowerCase() === 'desconocida' || confidence <= 0) {
        return {
            value: null,
            mode: null,
            confidence: 0,
            reliability: 'unreliable',
            evidence: ['essentia no devolvió tonalidad'],
            reasons_for_hedge: ['la detección de tonalidad falló'],
        };
    }

    const evidence = [`essentia strength=${confidence.toFixed(2)}`];
    const reasons = [];

    // Corroboración con basic-pitch: los pitch classes deberían caer en su
    // mayoría dentro de la escala detectada. Si no hay MIDI confiable, esta
    // rama no corrobora ni desmiente — solo baja el techo de tier a 'medium'.
    let corroborates = null;
    if (transcriptionAssessment?.available && transcriptionAssessment.level !== 'unreliable') {
        const notes = Array.isArray(audioAnalysis?.midiNotes) ? audioAnalysis.midiNotes : [];
        if (notes.length > 0) {
            const hist = new Array(12).fill(0);
            for (const n of notes) {
                const p = notePitch(n);
                if (p > 0) hist[((p % 12) + 12) % 12] += 1;
            }
            const total = hist.reduce((a, b) => a + b, 0);
            const root = NOTE_TO_PC(value);
            if (total > 0 && root != null) {
                const scaleSteps = mode.toLowerCase().startsWith('min') ? MINOR_SCALE : MAJOR_SCALE;
                const scalePcs = new Set(scaleSteps.map(s => (root + s) % 12));
                const inScale = hist.reduce((s, c, i) => s + (scalePcs.has(i) ? c : 0), 0);
                const inScaleRatio = inScale / total;
                evidence.push(`in-scale-ratio=${inScaleRatio.toFixed(2)}`);
                if (inScaleRatio >= 0.75) corroborates = true;
                else if (inScaleRatio < 0.55) corroborates = false;
                // 0.55–0.75 = neutral: ni corrobora ni desmiente.
            }
        }
    }

    let reliability;
    if (confidence >= 0.75) {
        reliability = corroborates === false ? 'medium' : 'high';
    } else if (confidence >= 0.60) {
        if (corroborates === true) reliability = 'high';
        else if (corroborates === false) reliability = 'low';
        else reliability = 'medium';
    } else if (confidence >= 0.45) {
        reliability = corroborates === false ? 'unreliable' : 'low';
    } else {
        reliability = 'unreliable';
    }

    if (reliability === 'low' || reliability === 'unreliable') {
        reasons.push(`confianza de detección baja (strength=${confidence.toFixed(2)})`);
        if (corroborates === false) {
            reasons.push('las notas transcritas no coinciden con la escala detectada');
        } else if (!transcriptionAssessment?.available) {
            reasons.push('sin transcripción MIDI que corrobore la tonalidad');
        }
    }

    return {
        value,
        mode,
        confidence: Number(confidence.toFixed(2)),
        reliability,
        evidence,
        reasons_for_hedge: reasons,
    };
}

// ─── TEMPO (essentia) ────────────────────────────────────────────────────────
export function assessTempo(audioAnalysis) {
    const tempo = audioAnalysis?.tempo || {};
    const value = Math.round(Number(tempo.bpm || 0));
    const confidence = clamp01(tempo.confidence);
    if (!value) {
        return {
            value: null,
            confidence: 0,
            reliability: 'unreliable',
            evidence: ['tempo no detectado'],
        };
    }
    let reliability;
    if (confidence >= 0.70) reliability = 'high';
    else if (confidence >= 0.45) reliability = 'medium';
    else if (confidence >= 0.25) reliability = 'low';
    else reliability = 'unreliable';
    return {
        value,
        confidence: Number(confidence.toFixed(2)),
        reliability,
        evidence: [`essentia confidence=${confidence.toFixed(2)}`],
    };
}

// ─── PUNTO DE ENTRADA ────────────────────────────────────────────────────────
export function assessAnalysis(audioAnalysis) {
    const transcription = assessTranscription(audioAnalysis);
    const key = assessKey(audioAnalysis, transcription);
    const tempo = assessTempo(audioAnalysis);

    // Dinámica es confiable solo si Essentia DynamicComplexity corrió (no fue
    // fallback casero). Ver AudioAnalyzer.buildFallbackAnalysis.
    const usedList = Array.isArray(audioAnalysis?.providersUsed) ? audioAnalysis.providersUsed : [];
    const dynamicsReliable = usedList.includes('loudness') && !usedList.includes('loudness-fallback');

    // Grupos de señales — el LLM las lee y decide qué usar. El grupo
    // 'transcription_dependent_metrics' incluye densidad, articulación
    // estimada, rango de notas, silencio derivado del MIDI y perfil por
    // secciones — todo lo que se cae si la transcripción no es confiable.
    const reliable = ['duration'];
    const unreliable = [];

    (tempo.reliability === 'high' || tempo.reliability === 'medium')
        ? reliable.push('tempo') : unreliable.push('tempo');

    (key.reliability === 'high' || key.reliability === 'medium')
        ? reliable.push('key') : unreliable.push('key');

    dynamicsReliable ? reliable.push('dynamics') : unreliable.push('dynamics');

    (transcription.level === 'high' || transcription.level === 'medium')
        ? reliable.push('transcription_dependent_metrics')
        : unreliable.push('transcription_dependent_metrics');

    // Calidad global — dos o más señales flojas → low.
    const tiers = [tempo.reliability, key.reliability, transcription.level];
    const weak = tiers.filter(t => t === 'low' || t === 'unreliable').length;
    const strong = tiers.filter(t => t === 'high').length;
    let overall;
    if (strong >= 2 && weak === 0) overall = 'high';
    else if (weak >= 2) overall = 'low';
    else overall = 'medium';

    return {
        tempo,
        key,
        transcription,
        melody: {
            status: 'unknown',
            note: 'basic-pitch da eventos de pitch pero no separa roles: la nota más aguda NO es la melodía y la más grave NO es el bajo.',
        },
        reliable_signals: reliable,
        unreliable_signals: unreliable,
        overall_data_quality: overall,
    };
}
