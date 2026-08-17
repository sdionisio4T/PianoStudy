import { AIAnalysisEngine } from './assets/js/modules/AIAnalysisEngine.js';
import { getRelevantMusicalTerms, MUSICAL_TERMS } from './assets/js/data/musicalTerms.js';

const engine = new AIAnalysisEngine();
const audio = {
    tempo: { bpm: 134, confidence: 0.85 }, key: { key: 'C', scale: 'major', strength: 0.75 },
    loudness: { average: -18, dynamicComplexity: 0.35 }, duration: 43,
    midiNotes: Array.from({ length: 200 }, (_, i) => ({ pitchMidi: 60 + (i % 24), startTimeSeconds: i * 0.2, durationSeconds: 0.18, amplitude: 0.5 })),
};
const reliability = {
    tempo: { value: 134, reliability: 'high', confidence: 0.85 },
    key: { value: 'C', mode: 'major', reliability: 'high', confidence: 0.75, reasons_for_hedge: [] },
    transcription: { level: 'high', available: true, score: 0.8, warnings: [] },
    melody: { status: 'estimated', note: '' }, reliable_signals: ['tempo', 'key'], unreliable_signals: [], overall_data_quality: 'high',
};
const auditory = { auditory_observations: [{ type: 'phrasing', observation: 'notas conectadas y direccionadas', confidence: 0.8, timestamp_start: 0, timestamp_end: 20 }] };

const terms = getRelevantMusicalTerms(audio, { style: 'bebop' }, reliability, auditory);
console.log(`Términos seleccionados (${terms.length}): ${terms.map(t => t.term).join(', ')}\n`);
const nuevo = engine.formatMusicalTermsForPrompt(terms);
const estimarTokens = (s) => Math.ceil(s.length / 4);

// Reconstrucción "antes de este cambio": 20 términos con formato viejo
const idsViejoBebop = ['tempo','pulso','estabilidad_del_pulso','dinamica','contraste_dinamico','registro','rango','silencio','densidad_ritmica','fraseo','frase','respiracion_musical','acento','ataque','articulacion','subdivision','swing','swing_feel','bebop_scale','approach_note','enclosure','encierro','chord_tone','aproximacion_cromatica','ii_V_I','guide_tones','sustitucion_tritono','playing_the_changes','call_response','comping','shell_voicing','motivo','contorno_melodico','nota_de_paso','cromatismo','tension','resolucion','tension_resolution','tonalidad','tonica','dominante','acorde','voicing','conduccion_de_voces'].filter(id => MUSICAL_TERMS[id]).slice(0, 20);
const termsViejo = idsViejoBebop.map(id => MUSICAL_TERMS[id]);
const viejoFull = ['VOCABULARIO MUSICAL DISPONIBLE PARA ESTA SESIÓN (elegí solo lo que la evidencia respalde — no lo trates como lista obligatoria):']
    .concat(termsViejo.map(t => {
        const levelTag = t.level ? ` (${t.level})` : '';
        const use = t.pedagogicalUse ? ` Uso: ${t.pedagogicalUse}` : '';
        const forbid = Array.isArray(t.forbiddenWhen) && t.forbiddenWhen.length ? ` NO usar cuando: ${t.forbiddenWhen.slice(0, 2).join('; ')}.` : '';
        return `- ${t.term}${levelTag}: ${t.definition}${use}${forbid}`;
    })).join('\n');

console.log(`ANTES: ${viejoFull.length} chars ≈ ${estimarTokens(viejoFull)} tokens (20 términos, formato verbose)`);
console.log(`AHORA: ${nuevo.length} chars ≈ ${estimarTokens(nuevo)} tokens (${terms.length} términos, formato compacto)`);
console.log(`AHORRO: ${viejoFull.length - nuevo.length} chars ≈ ${estimarTokens(viejoFull) - estimarTokens(nuevo)} tokens (${((1 - nuevo.length/viejoFull.length)*100).toFixed(0)}%)\n`);
console.log(`--- BLOQUE NUEVO ---\n${nuevo}`);
