import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock del cliente Supabase antes de importar el analyzer. El analyzer
// invoca db.functions.invoke('gemini-proxy', ...) — todos los tests inyectan
// una respuesta distinta acá para probar fallback y validación.
const invokeMock = vi.fn();
vi.mock('../assets/js/modules/supabase-client.js', () => ({
    db: { functions: { invoke: invokeMock } },
}));

const { analyzeAudioClips, validateAuditoryPayload } = await import(
    '../assets/js/modules/GeminiAudioAnalyzer.js'
);

const clip = (startSec, endSec) => ({
    startSec, endSec, seconds: endSec - startSec,
    reason: 'test', kind: 'representative',
    mimeType: 'audio/wav', dataBase64: 'AAAA',
});

beforeEach(() => {
    invokeMock.mockReset();
});

describe('analyzeAudioClips — fallback silencioso', () => {
    it('devuelve null si no hay clips', async () => {
        expect(await analyzeAudioClips([])).toBeNull();
        expect(await analyzeAudioClips(null)).toBeNull();
    });

    it('devuelve null si la invoke tira error', async () => {
        invokeMock.mockRejectedValueOnce(new Error('network down'));
        const result = await analyzeAudioClips([clip(0, 8)], {}, { retryBackoffMs: 0, retryAttempts: 0, modelNames: ['test-model'] });
        expect(result).toBeNull();
    });

    it('devuelve null si la data trae error de transporte', async () => {
        invokeMock.mockResolvedValueOnce({ data: null, error: { message: 'bad' } });
        const result = await analyzeAudioClips([clip(0, 8)], {}, { retryBackoffMs: 0, retryAttempts: 0, modelNames: ['test-model'] });
        expect(result).toBeNull();
    });

    it('devuelve null si el status upstream es ≥400', async () => {
        invokeMock.mockResolvedValueOnce({ data: { status: 429, body: { error: 'rate' } }, error: null });
        const result = await analyzeAudioClips([clip(0, 8)], {}, { retryBackoffMs: 0, retryAttempts: 0, modelNames: ['test-model'] });
        expect(result).toBeNull();
    });

    it('devuelve null si el JSON de Gemini es inválido', async () => {
        invokeMock.mockResolvedValueOnce({
            data: {
                status: 200,
                body: { candidates: [{ content: { parts: [{ text: 'no soy JSON' }] } }] },
            },
            error: null,
        });
        const result = await analyzeAudioClips([clip(0, 8)], {}, { retryBackoffMs: 0, retryAttempts: 0, modelNames: ['test-model'] });
        expect(result).toBeNull();
    });
});

describe('analyzeAudioClips — respuesta válida', () => {
    it('parsea, normaliza y devuelve observaciones + usage', async () => {
        const geminiJson = JSON.stringify({
            auditory_observations: [
                { type: 'rhythm', observation: 'Pulso firme', confidence: 0.9, timestamp_start: 2, timestamp_end: 8 },
            ],
            strengths: ['Sensación de swing consistente'],
            areas_to_explore: ['Explorar más contraste dinámico en la sección B'],
            uncertainties: ['No se pudo determinar la sustitución armónica exacta'],
        });
        invokeMock.mockResolvedValueOnce({
            data: {
                status: 200,
                body: {
                    candidates: [{ content: { parts: [{ text: geminiJson }] } }],
                    usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 120, totalTokenCount: 920 },
                },
            },
            error: null,
        });
        const result = await analyzeAudioClips([clip(0, 8)], { style: 'bebop' });
        expect(result).not.toBeNull();
        expect(result.observations.auditory_observations).toHaveLength(1);
        expect(result.observations.auditory_observations[0].type).toBe('rhythm');
        expect(result.observations.strengths).toHaveLength(1);
        expect(result.usage.segments_sent).toBe(1);
        expect(result.usage.audio_seconds_sent).toBe(8);
        expect(result.usage.input_tokens).toBe(800);
        expect(result.usage.output_tokens).toBe(120);
    });

    it('pasa mode=audio y systemPrompt al proxy', async () => {
        invokeMock.mockResolvedValueOnce({
            data: {
                status: 200,
                body: {
                    candidates: [{ content: { parts: [{
                        text: JSON.stringify({
                            auditory_observations: [{ observation: 'ok', confidence: 0.5, timestamp_start: 0, timestamp_end: 8, type: 'rhythm' }],
                            strengths: [], areas_to_explore: [], uncertainties: [],
                        }),
                    }] } }],
                    usageMetadata: {},
                },
            },
            error: null,
        });
        await analyzeAudioClips([clip(0, 8)], {});
        expect(invokeMock).toHaveBeenCalledWith('gemini-proxy', expect.objectContaining({
            body: expect.objectContaining({
                mode: 'audio',
                responseFormat: 'json_object',
                systemPrompt: expect.stringContaining('PERCEPCIÓN MUSICAL'),
                parts: expect.any(Array),
            }),
        }));
    });
});

describe('analyzeAudioClips — rotación entre modelos (cuota diaria)', () => {
    const validBody = (obs = 'Pulso firme') => ({
        candidates: [{
            content: { parts: [{ text: JSON.stringify({
                auditory_observations: [{ type: 'rhythm', observation: obs, confidence: 0.9, timestamp_start: 0, timestamp_end: 8 }],
                strengths: [], areas_to_explore: [], uncertainties: [],
            }) }] },
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    });

    it('si el primer modelo devuelve 429 con "quota exceeded" → prueba el segundo modelo automáticamente', async () => {
        invokeMock
            .mockResolvedValueOnce({ data: { status: 429, body: { error: { message: 'Quota exceeded for model gemini-2.5-flash' } } }, error: null })
            .mockResolvedValueOnce({ data: { status: 200, body: validBody('desde modelo B') }, error: null });
        const result = await analyzeAudioClips([clip(0, 8)], {}, {
            retryBackoffMs: 0, modelNames: ['modelo-A', 'modelo-B'],
        });
        expect(result).not.toBeNull();
        expect(result.model_used).toBe('modelo-B');
        expect(result.observations.auditory_observations[0].observation).toBe('desde modelo B');
        // 2 llamadas: una por modelo, sin reintentar el primero (quota agotada).
        expect(invokeMock).toHaveBeenCalledTimes(2);
    });

    it('si el primer modelo devuelve 403 con "RESOURCE_EXHAUSTED" → salta al segundo', async () => {
        invokeMock
            .mockResolvedValueOnce({ data: { status: 403, body: { error: { status: 'RESOURCE_EXHAUSTED', message: 'daily limit' } } }, error: null })
            .mockResolvedValueOnce({ data: { status: 200, body: validBody() }, error: null });
        const result = await analyzeAudioClips([clip(0, 8)], {}, {
            retryBackoffMs: 0, modelNames: ['A', 'B'],
        });
        expect(result).not.toBeNull();
        expect(result.model_used).toBe('B');
    });

    it('si el primer modelo devuelve 503 → reintenta el mismo modelo antes de rotar', async () => {
        invokeMock
            .mockResolvedValueOnce({ data: { status: 503, body: { error: 'high demand' } }, error: null })
            .mockResolvedValueOnce({ data: { status: 200, body: validBody() }, error: null });
        const result = await analyzeAudioClips([clip(0, 8)], {}, {
            retryBackoffMs: 0, modelNames: ['A', 'B'], retryAttempts: 1,
        });
        expect(result).not.toBeNull();
        expect(result.model_used).toBe('A'); // el retry rescató al mismo modelo
        expect(invokeMock).toHaveBeenCalledTimes(2);
    });

    it('si TODOS los modelos devuelven quota exhausted → devuelve null', async () => {
        const quotaErr = { data: { status: 429, body: { error: { message: 'Quota exceeded' } } }, error: null };
        invokeMock.mockResolvedValue(quotaErr);
        const result = await analyzeAudioClips([clip(0, 8)], {}, {
            retryBackoffMs: 0, modelNames: ['A', 'B', 'C'],
        });
        expect(result).toBeNull();
        expect(invokeMock).toHaveBeenCalledTimes(3); // uno por modelo, sin retries
    });

    it('usa el primer modelo si funciona (no rota innecesariamente)', async () => {
        invokeMock.mockResolvedValueOnce({ data: { status: 200, body: validBody() }, error: null });
        const result = await analyzeAudioClips([clip(0, 8)], {}, {
            retryBackoffMs: 0, modelNames: ['A', 'B', 'C'],
        });
        expect(result).not.toBeNull();
        expect(result.model_used).toBe('A');
        expect(invokeMock).toHaveBeenCalledTimes(1);
    });

    it('con modelNames vacío, cae a modelName legacy (compat)', async () => {
        invokeMock.mockResolvedValueOnce({ data: { status: 200, body: validBody() }, error: null });
        const result = await analyzeAudioClips([clip(0, 8)], {}, {
            retryBackoffMs: 0, modelNames: [], modelName: 'legacy-model',
        });
        expect(result).not.toBeNull();
        expect(result.model_used).toBe('legacy-model');
    });
});

describe('validateAuditoryPayload', () => {
    const clips = [clip(0, 8), clip(20, 28)];

    it('devuelve null cuando todos los arrays están vacíos', () => {
        expect(validateAuditoryPayload({
            auditory_observations: [],
            strengths: [],
            areas_to_explore: [],
            uncertainties: [],
        }, clips)).toBeNull();
    });

    it('clampa timestamps al rango de los clips enviados', () => {
        const validated = validateAuditoryPayload({
            auditory_observations: [
                { type: 'rhythm', observation: 'x', confidence: 0.9, timestamp_start: -5, timestamp_end: 999 },
            ],
        }, clips);
        expect(validated.auditory_observations[0].timestamp_start).toBe(0);
        expect(validated.auditory_observations[0].timestamp_end).toBe(28);
    });

    it('recorta types no válidos a "character"', () => {
        const validated = validateAuditoryPayload({
            auditory_observations: [{ type: 'no-existe', observation: 'ok', confidence: 0.5 }],
        }, clips);
        expect(validated.auditory_observations[0].type).toBe('character');
    });

    it('respeta los límites de cantidad (max 4 observations, 3/3/2 en el resto)', () => {
        const validated = validateAuditoryPayload({
            auditory_observations: Array.from({ length: 10 }, (_, i) => ({ type: 'rhythm', observation: `o${i}`, confidence: 0.5 })),
            strengths: ['a', 'b', 'c', 'd', 'e'],
            areas_to_explore: ['a', 'b', 'c', 'd'],
            uncertainties: ['a', 'b', 'c'],
        }, clips);
        expect(validated.auditory_observations).toHaveLength(4);
        expect(validated.strengths).toHaveLength(3);
        expect(validated.areas_to_explore).toHaveLength(3);
        expect(validated.uncertainties).toHaveLength(2);
    });
});
