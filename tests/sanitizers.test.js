import { describe, it, expect } from 'vitest';
import { escapeHtml, sanitizeFileName, validateAudioBlob } from '../assets/js/utils/sanitizers.js';

describe('escapeHtml', () => {
    it('escapa los caracteres especiales de HTML', () => {
        const input = `<script>alert("xss")</script> & 'quoted'`;
        const out = escapeHtml(input);
        expect(out).not.toContain('<script>');
        expect(out).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; &#39;quoted&#39;');
    });

    it('devuelve string vacío para null/undefined', () => {
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
    });
});

describe('sanitizeFileName', () => {
    it('quita caracteres peligrosos de un nombre de archivo', () => {
        expect(sanitizeFileName('../../etc/passwd')).not.toContain('/');
        expect(sanitizeFileName('mi lick: "final".wav')).toBe('mi lick final.wav');
    });

    it('devuelve "file" para nombres vacíos o inválidos', () => {
        expect(sanitizeFileName('')).toBe('file');
        expect(sanitizeFileName('   ')).toBe('file');
    });
});

describe('validateAudioBlob', () => {
    it('acepta tipos MIME de audio soportados', () => {
        const blob = new Blob([], { type: 'audio/webm' });
        expect(validateAudioBlob(blob)).toBe(true);
    });

    it('rechaza tipos MIME no soportados', () => {
        const blob = new Blob([], { type: 'application/octet-stream' });
        expect(validateAudioBlob(blob)).toBe(false);
    });
});
