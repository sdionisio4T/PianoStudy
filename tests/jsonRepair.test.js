import { describe, it, expect } from 'vitest';
import { sanitizeJsonControlChars, parseLlmJson } from '../assets/js/utils/jsonRepair.js';

describe('sanitizeJsonControlChars', () => {
    it('escapa un \\n literal dentro de un string', () => {
        const input = '{"a":"linea1\nlinea2"}';
        const out = sanitizeJsonControlChars(input);
        expect(out).toBe('{"a":"linea1\\nlinea2"}');
        expect(() => JSON.parse(out)).not.toThrow();
    });

    it('deja los \\n FUERA de strings intactos (whitespace legal en JSON)', () => {
        const input = '{\n  "a": "x"\n}';
        const out = sanitizeJsonControlChars(input);
        expect(out).toBe(input);
    });

    it('respeta escapes ya presentes — no duplica', () => {
        const input = '{"a":"ya\\nescapado"}';
        const out = sanitizeJsonControlChars(input);
        expect(out).toBe(input);
    });

    it('escapa múltiples control chars distintos (tab, cr, form-feed)', () => {
        const input = '{"a":"con\ttab\rcr\fff"}';
        const out = sanitizeJsonControlChars(input);
        expect(() => JSON.parse(out)).not.toThrow();
        expect(JSON.parse(out).a).toBe('con\ttab\rcr\fff');
    });

    it('escapa control chars raros como \\u001f', () => {
        const input = '{"a":"raro\x1f"}';
        const out = sanitizeJsonControlChars(input);
        expect(out).toContain('\\u001f');
        expect(() => JSON.parse(out)).not.toThrow();
    });
});

describe('parseLlmJson', () => {
    it('parsea JSON válido sin tocar nada', () => {
        expect(parseLlmJson('{"a":1}')).toEqual({ a: 1 });
    });

    it('quita fences ```json', () => {
        expect(parseLlmJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
        expect(parseLlmJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
    });

    it('parsea JSON con \\n literal dentro de un string (bug frecuente de LLM)', () => {
        const raw = '{"musicalAnalysis":"parrafo1\n\nparrafo2","score":7}';
        const out = parseLlmJson(raw);
        expect(out).toEqual({ musicalAnalysis: 'parrafo1\n\nparrafo2', score: 7 });
    });

    it('extrae el objeto cuando hay texto suelto antes o después', () => {
        const raw = 'Aquí va tu análisis:\n{"a":1}\nEspero que sirva.';
        expect(parseLlmJson(raw)).toEqual({ a: 1 });
    });

    it('devuelve null cuando no hay nada parseable', () => {
        expect(parseLlmJson('')).toBeNull();
        expect(parseLlmJson('   ')).toBeNull();
        expect(parseLlmJson('sin llave abierta')).toBeNull();
        expect(parseLlmJson(null)).toBeNull();
        expect(parseLlmJson(undefined)).toBeNull();
    });

    it('maneja objetos anidados con newlines internos', () => {
        const raw = '{"obs":[{"text":"linea a\nlinea b"}]}';
        const out = parseLlmJson(raw);
        expect(out.obs[0].text).toBe('linea a\nlinea b');
    });

    it('sobrevive a texto con caracteres unicode en strings', () => {
        const raw = '{"a":"tú y yo — piano"}';
        expect(parseLlmJson(raw)).toEqual({ a: 'tú y yo — piano' });
    });
});

describe('parseLlmJson — reparación de respuestas truncadas', () => {
    it('recupera campos ya completos cuando la respuesta se corta a mitad de string', () => {
        // Caso real: Groq cortó el output a mitad de musicalAnalysis. Los campos
        // anteriores (overallScore) están completos y deberíamos rescatarlos.
        const raw = '{"overallScore":7,"musicalAnalysis":"La grabación comienza con un pulso estable y una tonalidad de F menor, y luego';
        const out = parseLlmJson(raw);
        expect(out).not.toBeNull();
        expect(out.overallScore).toBe(7);
        // musicalAnalysis debería estar presente aunque el string haya quedado incompleto
        expect(typeof out.musicalAnalysis).toBe('string');
    });

    it('recupera cuando la respuesta se corta con fence ```json abierto pero sin cerrar', () => {
        const raw = '```json\n{"overallScore":7,"strengths":["fraseo con dirección","pulso estable"';
        const out = parseLlmJson(raw);
        expect(out).not.toBeNull();
        expect(out.overallScore).toBe(7);
        expect(Array.isArray(out.strengths)).toBe(true);
        expect(out.strengths.length).toBeGreaterThanOrEqual(1);
    });

    it('recupera cuando queda una coma colgante al final', () => {
        const raw = '{"overallScore":8,"strengths":["a","b"],';
        const out = parseLlmJson(raw);
        expect(out).not.toBeNull();
        expect(out.overallScore).toBe(8);
        expect(out.strengths).toEqual(['a', 'b']);
    });

    it('recupera cuando queda ":" sin valor', () => {
        const raw = '{"overallScore":8,"musicalAnalysis":"ok","strengths":';
        const out = parseLlmJson(raw);
        expect(out).not.toBeNull();
        expect(out.overallScore).toBe(8);
        expect(out.musicalAnalysis).toBe('ok');
    });

    it('cierra objetos anidados abiertos cuando el truncamiento ocurre profundo', () => {
        const raw = '{"a":1,"nested":{"b":2,"c":"texto';
        const out = parseLlmJson(raw);
        expect(out).not.toBeNull();
        expect(out.a).toBe(1);
        expect(out.nested).toBeDefined();
        expect(out.nested.b).toBe(2);
    });

    it('cierra arrays abiertos cuando el truncamiento cae dentro de uno', () => {
        const raw = '{"score":5,"observations":[{"fact":"x","interpretation":"y"},{"fact":"z"';
        const out = parseLlmJson(raw);
        expect(out).not.toBeNull();
        expect(out.score).toBe(5);
        expect(Array.isArray(out.observations)).toBe(true);
        expect(out.observations.length).toBeGreaterThanOrEqual(1);
        expect(out.observations[0].fact).toBe('x');
    });

    it('sigue devolviendo null si NO llegó nada parseable (ni el objeto empezó)', () => {
        expect(parseLlmJson('```json\n')).toBeNull();
        expect(parseLlmJson('solo texto sin llaves')).toBeNull();
    });
});
