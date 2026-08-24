// Grabador MIDI vía Web MIDI API. Alternativa a MediaRecorder para pianistas
// con teclado MIDI conectado: captura noteOn/noteOff/controlChange exactos y
// los serializa a un blob .mid usando @tonejs/midi.
//
// Uso típico:
//   const rec = new MidiRecorder();
//   await rec.requestAccess();          // pide permiso al navegador
//   const inputs = rec.listInputs();    // devuelve array de {id, name}
//   rec.startRecording(inputId);        // suscribe eventos
//   const { blob, duration, noteCount } = await rec.stopRecording();
//
// Notas de diseño:
// - startTime se ancla en la PRIMERA nota, no en el click de "grabar", para
//   descartar el silencio inicial (mismo criterio que el modo audio hoy).
// - Notas colgadas (noteOn sin noteOff al parar) se cierran forzosamente con
//   duración = tiempo restante en el buffer.
// - PPQ 480 por default (estándar DAW). Sin marca de tempo → el .mid usa 120
//   BPM por convención MIDI, pero como la app deriva tempo del stream real,
//   ese default no importa para el análisis.

import { Midi } from '@tonejs/midi';

export class MidiRecorder {
    constructor() {
        this.access = null;
        this.input = null;
        this.isRecording = false;
        this.events = []; // { t: seconds, type, note, velocity, cc, value }
        this.activeNotes = new Map(); // note -> { startTime, velocity }
        this.firstEventTime = null;
        this._onMidiMessage = this._onMidiMessage.bind(this);
    }

    async requestAccess() {
        if (!navigator.requestMIDIAccess) {
            throw new Error('Web MIDI API no disponible en este navegador. Probá Chrome/Edge.');
        }
        this.access = await navigator.requestMIDIAccess({ sysex: false });
        return this.access;
    }

    listInputs() {
        if (!this.access) return [];
        const inputs = [];
        for (const input of this.access.inputs.values()) {
            inputs.push({ id: input.id, name: input.name || 'MIDI Input', manufacturer: input.manufacturer || '' });
        }
        return inputs;
    }

    // Sin argumento: usa el primer input disponible.
    startRecording(inputId = null) {
        if (this.isRecording) return;
        if (!this.access) throw new Error('Llamá a requestAccess() antes de startRecording()');
        this._unbindInput();

        let target = null;
        for (const input of this.access.inputs.values()) {
            if (!inputId || input.id === inputId) { target = input; break; }
        }
        if (!target) throw new Error('No hay ningún teclado MIDI conectado.');

        this.input = target;
        this.events = [];
        this.activeNotes = new Map();
        this.firstEventTime = null;
        this.isRecording = true;
        this.input.addEventListener('midimessage', this._onMidiMessage);
    }

    async stopRecording() {
        if (!this.isRecording) return null;
        this.isRecording = false;
        this._unbindInput();

        // Cerrar notas colgadas con la última marca temporal registrada +
        // un pequeño extra (mismo criterio que un DAW cuando frenás la
        // reproducción con notas sostenidas).
        const lastT = this.events.length ? this.events[this.events.length - 1].t : 0;
        const closeAt = lastT + 0.05;
        for (const [note, { startTime, velocity }] of this.activeNotes.entries()) {
            this.events.push({ t: closeAt, type: 'noteOff', note, velocity });
        }
        this.activeNotes.clear();

        // Construir el objeto Midi y volcarlo a blob.
        const midi = new Midi();
        midi.header.setTempo(120); // marcador nominal; el análisis no lo usa.
        const track = midi.addTrack();

        // Emparejar noteOn con su noteOff correspondiente para armar cada nota.
        const openByPitch = new Map(); // pitch -> { start, velocity }
        let noteCount = 0;
        for (const ev of this.events) {
            if (ev.type === 'noteOn') {
                openByPitch.set(ev.note, { start: ev.t, velocity: ev.velocity });
            } else if (ev.type === 'noteOff') {
                const open = openByPitch.get(ev.note);
                if (!open) continue;
                openByPitch.delete(ev.note);
                const duration = Math.max(0.01, ev.t - open.start);
                track.addNote({
                    midi: ev.note,
                    time: open.start,
                    duration,
                    velocity: Math.max(0, Math.min(1, open.velocity / 127)),
                });
                noteCount += 1;
            } else if (ev.type === 'cc') {
                track.addCC({ number: ev.cc, value: Math.max(0, Math.min(1, ev.value / 127)), time: ev.t });
            }
        }

        const bytes = midi.toArray();
        const blob = new Blob([new Uint8Array(bytes)], { type: 'audio/midi' });
        const duration = lastT || 0;

        return { blob, duration, noteCount };
    }

    _unbindInput() {
        if (this.input) {
            try { this.input.removeEventListener('midimessage', this._onMidiMessage); } catch { /* noop */ }
            this.input = null;
        }
    }

    _onMidiMessage(event) {
        if (!this.isRecording) return;
        const [status, data1, data2] = event.data;
        const kind = status & 0xf0;
        // performance.now() da precisión sub-ms y es monotónico; event.timeStamp
        // usa la misma base de tiempo, así que uso la del evento si viene.
        const nowMs = event.timeStamp ?? performance.now();
        if (this.firstEventTime === null) this.firstEventTime = nowMs;
        const t = (nowMs - this.firstEventTime) / 1000;

        if (kind === 0x90 && data2 > 0) {
            // noteOn con velocity > 0.
            this.events.push({ t, type: 'noteOn', note: data1, velocity: data2 });
            this.activeNotes.set(data1, { startTime: t, velocity: data2 });
        } else if (kind === 0x80 || (kind === 0x90 && data2 === 0)) {
            // noteOff (o noteOn velocity 0, equivalente por convención MIDI).
            this.events.push({ t, type: 'noteOff', note: data1, velocity: data2 });
            this.activeNotes.delete(data1);
        } else if (kind === 0xb0) {
            // controlChange (útil para pedal de sustain = CC64).
            this.events.push({ t, type: 'cc', cc: data1, value: data2 });
        }
        // Ignoramos: pitch bend, program change, aftertouch, sysex.
    }
}

// Deriva un audioAnalysis "sintético" a partir de un blob .mid, con la forma
// que espera AIAnalysisEngine.analyzePerformance. Sirve para saltar Essentia
// y basic-pitch cuando la grabación es MIDI directo.
//
// Devuelve al menos: { duration, tempo, key, loudness, midiNotes }.
// Tempo: mediana de IOIs entre onsets. Key: histograma cromático simple.
export async function midiBlobToAnalysis(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const midi = new Midi(arrayBuffer);

    const notes = [];
    for (const track of midi.tracks) {
        for (const n of track.notes) {
            notes.push({
                pitchMidi: n.midi,
                startTimeSeconds: n.time,
                durationSeconds: n.duration,
                amplitude: n.velocity, // 0..1
            });
        }
    }
    notes.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);

    const duration = notes.length
        ? notes[notes.length - 1].startTimeSeconds + notes[notes.length - 1].durationSeconds
        : (midi.duration || 0);

    // Tempo: 60 / mediana de IOIs (>=50 ms para descartar acordes) — pragmático,
    // no perfecto. La IA recibe esto con confianza media.
    let bpm = 0;
    let tempoConfidence = 0;
    if (notes.length >= 4) {
        const iois = [];
        for (let i = 1; i < notes.length; i++) {
            const dt = notes[i].startTimeSeconds - notes[i - 1].startTimeSeconds;
            if (dt > 0.05) iois.push(dt);
        }
        if (iois.length >= 3) {
            iois.sort((a, b) => a - b);
            const median = iois[Math.floor(iois.length / 2)];
            bpm = Math.round(60 / median);
            // Confianza ~ inversa de la variabilidad relativa.
            const mean = iois.reduce((s, x) => s + x, 0) / iois.length;
            const variance = iois.reduce((s, x) => s + (x - mean) ** 2, 0) / iois.length;
            const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
            tempoConfidence = Math.max(0, Math.min(1, 1 - cv));
        }
    }

    // Key: profile cromático simple (12 bins) ponderado por duración.
    // No es Krumhansl completo — el prompt igual dice "fuerza baja" si el
    // score máximo no supera cierto umbral, así la IA no afirma tonalidad.
    let keyName = '';
    let keyStrength = 0;
    if (notes.length > 0) {
        const bins = new Array(12).fill(0);
        for (const n of notes) bins[n.pitchMidi % 12] += n.durationSeconds || 0.1;
        const total = bins.reduce((s, x) => s + x, 0) || 1;
        const norm = bins.map(x => x / total);
        const sharpNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        // Peso simple: la tónica es la clase con más peso; strength = share.
        let maxIdx = 0;
        for (let i = 1; i < 12; i++) if (norm[i] > norm[maxIdx]) maxIdx = i;
        keyName = sharpNames[maxIdx];
        keyStrength = norm[maxIdx]; // 0..~0.4 típico
    }

    return {
        duration,
        tempo: { bpm, confidence: tempoConfidence },
        key: { key: keyName, scale: '', strength: keyStrength },
        loudness: { average: 0, dynamicComplexity: 0 },
        midiNotes: notes,
        source: 'midi-input',
    };
}
