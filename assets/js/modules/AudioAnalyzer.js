export class AudioAnalyzer {
    constructor() {
        this.audioContext = null;
        this.essentia = null;
        this.essentiaReady = false;
    }

    async init() {
        if (this.essentiaReady && this.essentia) return;

        const EssentiaClass = window.Essentia || window.essentia?.Essentia;
        const EssentiaWASMFactory = window.EssentiaWASM || window.essentiaWASM;

        if (!EssentiaClass || !EssentiaWASMFactory) {
            throw new Error('Essentia.js no está disponible en window.');
        }

        const wasmModule = await EssentiaWASMFactory();
        this.essentia = new EssentiaClass(wasmModule);
        this.essentiaReady = true;
    }

    async analyzeAudio(audioBlob, options = {}) {
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

            const arrayBuffer = await audioBlob.arrayBuffer();
            const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
            const channelData = audioBuffer.getChannelData(0);

            // Estructura base — se rellena progresivamente y cualquier motor
            // que falle se sustituye por fallback, sin tirar los demás.
            const analysis = {
                duration: audioBuffer.duration,
                sampleRate: audioBuffer.sampleRate,
                numberOfChannels: audioBuffer.numberOfChannels,
                tempo: null,
                key: null,
                loudness: null,
                mfcc: [],
                spectralCentroid: 0,
                rhythmicComplexity: 0,
                analysisProvider: 'unknown',
                providersUsed: [],
                providersFailed: [],
            };

            // Inicializar Essentia + convertir canal a vector.
            let essentiaVector = null;
            try {
                await this.init();
                essentiaVector = this.essentia.arrayToVector(channelData);
                analysis.providersUsed.push('essentia-init');
            } catch (e) {
                console.warn('Essentia init/arrayToVector falló:', e);
                analysis.providersFailed.push('essentia-init');
            }

            // Cada algoritmo de Essentia va en su propio try/catch: si uno
            // tira una excepción de C++ (WASM sin exception catching), los
            // demás sobreviven. Es la causa de que antes todo cayera a fallback.
            if (essentiaVector) {
                const runEssentia = (name, fn) => {
                    try {
                        const result = fn();
                        analysis.providersUsed.push(name);
                        return result;
                    } catch (e) {
                        console.warn(`Essentia ${name} falló:`, e?.message || e);
                        analysis.providersFailed.push(name);
                        return null;
                    }
                };

                analysis.tempo = runEssentia('tempo', () => this.detectTempo(essentiaVector));
                analysis.key = runEssentia('key', () => this.detectKey(essentiaVector));
                analysis.loudness = runEssentia('loudness', () => this.analyzeLoudness(essentiaVector));
                analysis.mfcc = runEssentia('mfcc', () => this.extractMFCC(essentiaVector)) || [];
                analysis.spectralCentroid = runEssentia('centroid', () => this.getSpectralCentroid(essentiaVector, audioBuffer.sampleRate)) ?? 0;
                analysis.rhythmicComplexity = runEssentia('rhythmic-complexity', () => this.getRhythmicComplexity(essentiaVector)) ?? 0;

                try { essentiaVector.delete?.(); } catch { /* ignore */ }
            }

            // Rellenar con fallback los campos que quedaron null (sin sobreescribir los que Essentia sí resolvió).
            const fallback = this.buildFallbackAnalysis(audioBuffer);
            if (!analysis.tempo)    { analysis.tempo = fallback.tempo;       analysis.providersUsed.push('tempo-fallback'); }
            if (!analysis.key)      { analysis.key = fallback.key;           analysis.providersUsed.push('key-fallback'); }
            if (!analysis.loudness) { analysis.loudness = fallback.loudness; analysis.providersUsed.push('loudness-fallback'); }
            if (!analysis.spectralCentroid) analysis.spectralCentroid = fallback.spectralCentroid;

            // Etiqueta agregada — útil para el chip de la UI.
            if (analysis.providersFailed.length === 0 && analysis.providersUsed.includes('essentia-init')) {
                analysis.analysisProvider = 'essentia';
            } else if (analysis.providersUsed.includes('essentia-init')) {
                analysis.analysisProvider = 'essentia-partial';
            } else {
                analysis.analysisProvider = 'fallback';
            }

            // Transcripción MIDI por basic-pitch (opcional, aparte).
            // basic-pitch está entrenada a 22050 Hz — hay que resamplear el AudioBuffer
            // antes de pasárselo, si el original está a 44100/48000. Sin este paso el
            // modelo devuelve 0 notas aunque el audio tenga música real.
            if (options.enableMidiTranscription) {
                try {
                    const resampled = await this._resampleForBasicPitch(audioBuffer, 22050);
                    let notes = await this.transcribeToMidi(resampled);
                    if (!Array.isArray(notes) || notes.length === 0) {
                        // Fallback 1: intentar con el AudioBuffer original sin resamplear.
                        notes = await this.transcribeToMidi(audioBuffer);
                    }
                    if (!Array.isArray(notes) || notes.length === 0) {
                        // Fallback 2: intentar con el Blob crudo por si la build lo prefiere.
                        notes = await this.transcribeToMidi(audioBlob);
                    }
                    analysis.midiNotes = Array.isArray(notes) ? notes : [];
                    if (analysis.midiNotes.length > 0) {
                        analysis.providersUsed.push(`basic-pitch (${analysis.midiNotes.length} notas)`);
                    } else {
                        analysis.providersFailed.push('basic-pitch (0 notas transcritas)');
                    }
                } catch (midiErr) {
                    console.warn('Basic Pitch falló:', midiErr);
                    analysis.midiNotes = [];
                    analysis.providersFailed.push('basic-pitch');
                }
            }

            return analysis;
        } catch (error) {
            console.error('Error analyzing audio:', error);
            throw error;
        }
    }

    buildFallbackAnalysis(audioBuffer) {
        const tempoBpm = this.detectTempoFallback(audioBuffer);
        const loudness = this.analyzeLoudnessFallback(audioBuffer);
        return {
            duration: audioBuffer.duration,
            sampleRate: audioBuffer.sampleRate,
            numberOfChannels: audioBuffer.numberOfChannels,
            tempo: {
                bpm: tempoBpm,
                confidence: 0.35,
                ticks: []
            },
            key: {
                key: 'Desconocida',
                scale: '',
                strength: 0
            },
            loudness,
            mfcc: [],
            spectralCentroid: this.calculateSpectralCentroidFallback(audioBuffer),
            rhythmicComplexity: 0,
            analysisProvider: 'fallback'
        };
    }

    detectTempo(vector) {
        // Intento 1: PercivalBpmEstimator, single-call, muy estable en la build web.
        try {
            const r = this.essentia.PercivalBpmEstimator(vector);
            const bpm = Math.round(r?.bpm || 0);
            if (bpm > 0) {
                return { bpm, confidence: 0.75, ticks: [] };
            }
        } catch { /* fall through */ }

        // Intento 2: RhythmExtractor2013 sin sampleRate.
        // El segundo arg de RhythmExtractor2013 NO es sampleRate — es maxTempo (default 208).
        // Pasar 44100 tira una excepción de C++ que no se puede capturar limpio.
        const result = this.essentia.RhythmExtractor2013(vector);
        return {
            bpm: Math.round(result?.bpm || 0),
            confidence: Number(result?.confidence || 0),
            ticks: result?.ticks ? this.essentia.vectorToArray(result.ticks) : []
        };
    }

    detectKey(vector) {
        // KeyExtractor hace toda la cadena internamente: frames → HPCP → Key.
        // Reemplaza a la cadena manual (FrameCutter → Windowing → Spectrum → HPCP → Key)
        // que estaba mal encadenada — HPCP necesita SpectralPeaks, no Spectrum crudo.
        const r = this.essentia.KeyExtractor(vector);
        return {
            key: r?.key || 'Desconocida',
            scale: r?.scale || '',
            strength: Number(r?.strength || 0)
        };
    }

    analyzeLoudness(vector) {
        const loudness = this.essentia.DynamicComplexity(vector);
        return {
            average: Number(loudness?.loudness || 0),
            dynamicComplexity: Number(loudness?.dynamicComplexity || 0)
        };
    }

    extractMFCC(vector) {
        const frameSize = 2048;
        const hopSize = 1024;
        const mfccValues = [];
        const signalLength = vector.size ? vector.size() : 0;

        for (let start = 0; start + frameSize <= signalLength; start += hopSize) {
            const frameArray = new Float32Array(frameSize);
            for (let i = 0; i < frameSize; i++) frameArray[i] = vector.get(start + i);

            const frameVec = this.essentia.arrayToVector(frameArray);
            const windowed = this.essentia.Windowing(frameVec).frame;
            const spectrum = this.essentia.Spectrum(windowed).spectrum;
            const mfcc = this.essentia.MFCC(spectrum).mfcc;
            mfccValues.push(this.essentia.vectorToArray(mfcc));
            frameVec.delete?.();
        }

        if (!mfccValues.length) return [];
        const numCoeffs = mfccValues[0].length;
        return Array.from({ length: numCoeffs }, (_, i) =>
            mfccValues.reduce((sum, frame) => sum + (frame[i] || 0), 0) / mfccValues.length
        );
    }

    getSpectralCentroid(vector, sampleRate) {
        const centroid = this.essentia.SpectralCentroidTime(vector, sampleRate);
        return Number(centroid?.centroid || 0);
    }

    getRhythmicComplexity(vector) {
        // Reutiliza el vector de estimates de RhythmExtractor2013 sin pasar sampleRate.
        // Devuelve 0 silenciosamente si no hay estimates suficientes.
        try {
            const result = this.essentia.RhythmExtractor2013(vector);
            const estimates = result?.estimates ? this.essentia.vectorToArray(result.estimates) : [];
            if (estimates.length < 2) return 0;
            const mean = estimates.reduce((a, b) => a + b, 0) / estimates.length;
            const variance = estimates.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / estimates.length;
            return Math.sqrt(variance);
        } catch {
            return 0;
        }
    }

    detectTempoFallback(audioBuffer) {
        const channelData = audioBuffer.getChannelData(0);
        const sampleRate = audioBuffer.sampleRate;

        const windowSize = Math.floor(sampleRate * 0.1);
        const energies = [];

        for (let i = 0; i < channelData.length - windowSize; i += windowSize) {
            let energy = 0;
            for (let j = 0; j < windowSize; j++) {
                energy += Math.abs(channelData[i + j]);
            }
            energies.push(energy / windowSize);
        }

        const avg = energies.reduce((a, b) => a + b, 0) / Math.max(1, energies.length);
        const threshold = avg * 1.5;
        const beats = [];

        for (let i = 1; i < energies.length - 1; i++) {
            if (energies[i] > threshold && energies[i] > energies[i - 1] && energies[i] > energies[i + 1]) {
                beats.push(i);
            }
        }

        if (beats.length < 2) {
            return 120;
        }

        const intervals = [];
        for (let i = 1; i < beats.length; i++) {
            intervals.push(beats[i] - beats[i - 1]);
        }

        const avgInterval = intervals.reduce((a, b) => a + b, 0) / Math.max(1, intervals.length);
        const beatsPerSecond = 1 / (avgInterval * 0.1);
        const bpm = Math.round(beatsPerSecond * 60);

        return Math.max(40, Math.min(200, bpm));
    }

    analyzeLoudnessFallback(audioBuffer) {
        const channelData = audioBuffer.getChannelData(0);

        let sum = 0;
        for (let i = 0; i < channelData.length; i++) {
            sum += channelData[i] * channelData[i];
        }
        const rms = Math.sqrt(sum / Math.max(1, channelData.length));
        const db = 20 * Math.log10(rms || 1e-8);

        return {
            average: db,
            dynamicComplexity: Math.min(1, Math.max(0, rms * 2))
        };
    }

    calculateSpectralCentroidFallback(audioBuffer) {
        const channelData = audioBuffer.getChannelData(0);
        const sampleRate = audioBuffer.sampleRate;
        const n = Math.min(4096, channelData.length);
        if (!n) return 0;

        let weighted = 0;
        let sum = 0;
        for (let i = 0; i < n; i++) {
            const mag = Math.abs(channelData[i]);
            const freq = (i / n) * (sampleRate / 2);
            weighted += freq * mag;
            sum += mag;
        }
        return sum > 0 ? weighted / sum : 0;
    }

    generateAnnotatedWaveform(audioBuffer, canvas) {
        const ctx = canvas.getContext('2d');
        const width = canvas.width;
        const height = canvas.height;

        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(0, 0, width, height);

        const channelData = audioBuffer.getChannelData(0);
        const step = Math.ceil(channelData.length / width);
        const amp = height / 2;

        ctx.strokeStyle = '#667eea';
        ctx.lineWidth = 1;
        ctx.beginPath();

        for (let i = 0; i < width; i++) {
            let min = 1;
            let max = -1;
            const base = i * step;
            for (let j = 0; j < step; j++) {
                const v = channelData[base + j] ?? 0;
                if (v < min) min = v;
                if (v > max) max = v;
            }
            ctx.moveTo(i, (1 + min) * amp);
            ctx.lineTo(i, (1 + max) * amp);
        }

        ctx.stroke();
        this.annotateWaveform(ctx, width, height);
    }

    // Resamplea un AudioBuffer al sample rate de destino, mezclándolo a mono.
    // basic-pitch está entrenada en 22050 Hz mono — sin este paso, con audio
    // grabado a 44100/48000 Hz estéreo el modelo devuelve 0 notas.
    async _resampleForBasicPitch(audioBuffer, targetSR = 22050) {
        if (!audioBuffer) return audioBuffer;
        // Si ya está en el target y es mono, no hacemos nada.
        if (audioBuffer.sampleRate === targetSR && audioBuffer.numberOfChannels === 1) {
            return audioBuffer;
        }
        try {
            const length = Math.max(1, Math.ceil(audioBuffer.duration * targetSR));
            const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
            if (!OfflineCtx) return audioBuffer;
            const offlineCtx = new OfflineCtx(1, length, targetSR);
            // Mezclamos a mono manualmente para evitar recanalización rara del ctx.
            const monoInput = offlineCtx.createBuffer(1, audioBuffer.length, audioBuffer.sampleRate);
            const mono = monoInput.getChannelData(0);
            const numCh = audioBuffer.numberOfChannels;
            for (let ch = 0; ch < numCh; ch++) {
                const chData = audioBuffer.getChannelData(ch);
                for (let i = 0; i < chData.length; i++) mono[i] += chData[i] / numCh;
            }
            const src = offlineCtx.createBufferSource();
            src.buffer = monoInput;
            src.connect(offlineCtx.destination);
            src.start();
            return await offlineCtx.startRendering();
        } catch (e) {
            console.warn('Resample para basic-pitch falló, uso el buffer original:', e);
            return audioBuffer;
        }
    }

    async transcribeToMidi(audioSource) {
        // audioSource puede ser un AudioBuffer (preferido) o un Blob (fallback).
        // Lazy-load: basic-pitch + tf.js pesan ~1MB gzip. Solo se descargan cuando
        // el usuario pide análisis IA por primera vez, no en la carga inicial de la app.
        // Vite hace code-splitting automático — quedan en un chunk aparte.
        const {
            BasicPitch,
            noteFramesToTime,
            addPitchBendsToNoteEvents,
            outputToNotesPoly
        } = await import('@spotify/basic-pitch');

        // Modelo alojado en jsDelivr apuntando a la MISMA versión pinneada en package.json,
        // así el modelo y el runtime siempre coinciden. Es ~4MB, no tiene sentido bundlearlo.
        const model = new BasicPitch('https://cdn.jsdelivr.net/npm/@spotify/basic-pitch@1.0.1/model/model.json');
        const frames = [];
        const onsets = [];
        const contours = [];

        await model.evaluateModel(
            audioSource,
            (f, o, c) => {
                frames.push(...f);
                onsets.push(...o);
                contours.push(...c);
            },
            () => {}
        );

        return noteFramesToTime(
            addPitchBendsToNoteEvents(contours, outputToNotesPoly(frames, onsets, 0.25, 0.25, 5, false)),
            22050 / 256,
            0.0
        );
    }

    annotateWaveform(ctx, width, height) {
        const regions = [
            { start: 0.1, end: 0.3, type: 'good' },
            { start: 0.35, end: 0.5, type: 'improve' },
            { start: 0.55, end: 0.8, type: 'good' },
            { start: 0.85, end: 0.95, type: 'improve' }
        ];

        regions.forEach(region => {
            const startX = region.start * width;
            const endX = region.end * width;

            ctx.fillStyle = region.type === 'good'
                ? 'rgba(0, 255, 65, 0.2)'
                : 'rgba(255, 165, 0, 0.2)';

            ctx.fillRect(startX, 0, endX - startX, height);
        });
    }

    cleanup() {
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
    }
}
