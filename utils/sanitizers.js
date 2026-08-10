/**
 * Escapes HTML special characters to prevent XSS when injecting text into HTML.
 * @param {unknown} text
 * @returns {string}
 */
export function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    if (typeof text !== 'string') {
        if (typeof text === 'number' || typeof text === 'boolean') return String(text);
        throw new TypeError('escapeHtml: text must be a string');
    }

    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Sanitizes a file name for safe downloads/uploads.
 * Removes potentially dangerous characters and enforces a max length of 255 chars.
 * @param {unknown} filename
 * @returns {string}
 */
export function sanitizeFileName(filename) {
    if (filename === null || filename === undefined) return 'file';
    if (typeof filename !== 'string') {
        throw new TypeError('sanitizeFileName: filename must be a string');
    }

    const trimmed = filename.trim();
    const safe = trimmed
        .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '')
        .replace(/^\.+$/, '')
        .replace(/\s+/g, ' ')
        .trim();

    const finalName = safe.length > 0 ? safe : 'file';
    return finalName.slice(0, 255);
}

/**
 * Validates an audio Blob for supported MIME types.
 * @param {unknown} blob
 * @returns {boolean}
 */
export function validateAudioBlob(blob) {
    if (!(blob instanceof Blob)) {
        throw new TypeError('validateAudioBlob: blob must be a Blob');
    }

    const allowed = new Set(['audio/wav', 'audio/mpeg', 'audio/webm']);
    return allowed.has(blob.type);
}
