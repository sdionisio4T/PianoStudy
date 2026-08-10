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

            let analysis = null;
            let essentiaVector = null;

            try {
                await this.init();
                essentiaVector = this.essentia.arrayToVector(channelData);
                analysis = {
                    duration: audioBuffer.duration,
                    sampleRate: audioBuffer.sampleRate,
                    numberOfChannels: audioBuffer.numberOfChannels,
                    tempo: this.detectTempo(essentiaVector, audioBuffer.sampleRate),
                    key: this.detectKey(essentiaVector, audioBuffer.sampleRate),
                    loudness: this.analyzeLoudness(essentiaVector),
                    mfcc: this.extractMFCC(essentiaVector),
                    spectralCentroid: this.getSpectralCentroid(essentiaVector, audioBuffer.sampleRate),
                    rhythmicComplexity: this.getRhythmicComplexity(essentiaVector, audioBuffer.sampleRate),
                    analysisProvider: 'essentia'
                };
            } catch (essErr) {
                console.warn('Essentia no disponible, usando fallback local:', essErr);
                analysis = this.buildFallbackAnalysis(audioBuffer);
            }

            if (options.enableMidiTranscription) {
                try {
                    analysis.midiNotes = await this.transcribeToMidi(audioBlob);
                } catch (midiErr) {
                    console.warn('Basic Pitch no disponible:', midiErr);
                    analysis.midiNotes = [];
                }
            }

            if (essentiaVector?.delete) essentiaVector.delete();

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

    detectTempo(vector, sampleRate) {
        const result = this.essentia.RhythmExtractor2013(vector, sampleRate);
        return {
            bpm: Math.round(result?.bpm || 0),
            confidence: Number(result?.confidence || 0),
            ticks: result?.ticks ? this.essentia.vectorToArray(result.ticks) : []
        };
    }

    detectKey(vector) {
        const frame = this.essentia.FrameCutter(vector).frame;
        const windowed = this.essentia.Windowing(frame).frame;
        const spectrum = this.essentia.Spectrum(windowed).spectrum;
        const hpcp = this.essentia.HPCP(spectrum).hpcp;
        const key = this.essentia.Key(hpcp);
        return {
            key: key?.key || 'Desconocida',
            scale: key?.scale || '',
            strength: Number(key?.strength || 0)
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

    getRhythmicComplexity(vector, sampleRate) {
        const result = this.essentia.RhythmExtractor2013(vector, sampleRate);
        const estimates = result?.estimates ? this.essentia.vectorToArray(result.estimates) : [];
        if (estimates.length < 2) return 0;
        const mean = estimates.reduce((a, b) => a + b, 0) / estimates.length;
        const variance = estimates.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / estimates.length;
        return Math.sqrt(variance);
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

    async transcribeToMidi(audioBlob) {
        const bp = window.BasicPitch;
        if (!bp || !bp.BasicPitch) return [];

        const {
            BasicPitch,
            noteFramesToTime,
            addPitchBendsToNoteEvents,
            outputToNotesPoly
        } = bp;

        const model = new BasicPitch('https://unpkg.com/@spotify/basic-pitch/model/model.json');
        const frames = [];
        const onsets = [];
        const contours = [];

        await model.evaluateModel(
            audioBlob,
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
