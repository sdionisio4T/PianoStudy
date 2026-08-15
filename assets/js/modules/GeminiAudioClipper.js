// GeminiAudioClipper.js — recorta un AudioBuffer en fragmentos, los resamplea
// a mono 16 kHz, los codifica como WAV PCM 16-bit LE y devuelve base64 listo
// para enviarse como `inline_data` a Gemini.
//
// Requiere OfflineAudioContext (browser). En Node no corre — el pipeline solo
// se activa en runtime del cliente, y el flujo tiene fallback silencioso.

import { GEMINI_AUDIO_CONFIG } from './GeminiAudioConfig.js';

// Devuelve un AudioBuffer mono a `targetSR` con el rango [startSec, endSec) del
// buffer original. Mezclamos a mono a mano (evita recanalización rara del ctx).
async function extractResampled(audioBuffer, startSec, endSec, targetSR) {
    const OfflineCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!OfflineCtx) throw new Error('OfflineAudioContext no disponible');

    const durSec = Math.max(0, endSec - startSec);
    if (durSec <= 0) throw new Error('Rango vacío');
    const targetLength = Math.max(1, Math.ceil(durSec * targetSR));
    const offline = new OfflineCtx(1, targetLength, targetSR);

    const srcRate = audioBuffer.sampleRate;
    const totalSamples = Math.max(1, Math.floor(durSec * srcRate));
    const startSample = Math.floor(startSec * srcRate);
    const monoInput = offline.createBuffer(1, totalSamples, srcRate);
    const mono = monoInput.getChannelData(0);
    const numCh = audioBuffer.numberOfChannels || 1;
    for (let ch = 0; ch < numCh; ch++) {
        const chData = audioBuffer.getChannelData(ch);
        for (let i = 0; i < totalSamples; i++) {
            mono[i] += (chData[startSample + i] || 0) / numCh;
        }
    }

    const src = offline.createBufferSource();
    src.buffer = monoInput;
    src.connect(offline.destination);
    src.start();
    return await offline.startRendering();
}

// PCM 16-bit LE en un contenedor WAV mono. Formato estándar mínimo.
export function encodeWavMono16(monoBuffer) {
    const sampleRate = monoBuffer.sampleRate;
    const data = monoBuffer.getChannelData(0);
    const numSamples = data.length;
    const bytesPerSample = 2;
    const blockAlign = bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = numSamples * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    const writeString = (offset, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);        // PCM
    view.setUint16(22, 1, true);        // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
        const s = Math.max(-1, Math.min(1, data[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        offset += 2;
    }
    return new Uint8Array(buffer);
}

// btoa se banca hasta ~1MB por String.fromCharCode.apply — para audio de hasta
// ~1.5MB con 24s @ 16k mono chunkeamos para evitar stack overflow.
export function bytesToBase64(bytes) {
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

function rms(monoBuffer) {
    const data = monoBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    return Math.sqrt(sum / Math.max(1, data.length));
}

// Punto de entrada: recibe el AudioBuffer decodificado (blob → decodeAudioData)
// y la lista de segmentos del selector. Devuelve los clips procesados listos
// para el analyzer. Silenciosamente descarta los que quedan bajo el umbral de
// señal (fragmentos de silencio) — nunca los enviamos.
export async function clipSegments(audioBuffer, segments, config = {}) {
    const cfg = { ...GEMINI_AUDIO_CONFIG, ...config };
    const out = [];
    for (const seg of segments) {
        try {
            const resampled = await extractResampled(
                audioBuffer, seg.startSec, seg.endSec, cfg.targetSampleRate,
            );
            const level = rms(resampled);
            if (level < cfg.minSignalRms) {
                console.info('GeminiAudioClipper: descartado por silencio', seg, level);
                continue;
            }
            const wav = encodeWavMono16(resampled);
            const dataBase64 = bytesToBase64(wav);
            out.push({
                startSec: seg.startSec,
                endSec: seg.endSec,
                reason: seg.reason,
                kind: seg.kind,
                mimeType: 'audio/wav',
                dataBase64,
                seconds: Number((seg.endSec - seg.startSec).toFixed(2)),
                rms: Number(level.toFixed(4)),
            });
        } catch (e) {
            console.warn('GeminiAudioClipper: falló clip', seg, e);
        }
    }
    return out;
}
