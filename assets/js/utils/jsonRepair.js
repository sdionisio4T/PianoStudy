// jsonRepair.js — utilidades para parsear JSON emitido por LLMs, que a menudo
// no cumple estrictamente el standard aunque los proveedores fuerzan
// response_format: json_object.
//
// El bug más frecuente en producción: el modelo escribe un salto de línea
// LITERAL (0x0A) dentro de un string value en vez de `\n` escapado. JSON.parse
// tira "Bad control character in string literal" en position N y la respuesta
// completa se pierde. Este util pre-procesa el texto escapando los control
// chars solo cuando aparecen dentro de un string, dejando el JSON válido.

// Camina el texto char por char, trackeando si estamos dentro de un string
// literal (delimitado por `"` no escapado). Cuando encuentra un control char
// (0x00-0x1F) dentro de un string, lo reemplaza por su forma escapada.
// Fuera de strings, los control chars quedan como whitespace (JSON permite).
export function sanitizeJsonControlChars(text) {
    if (typeof text !== 'string' || !text) return text;
    const out = [];
    let inStr = false;
    let esc = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const code = c.charCodeAt(0);
        if (esc) { out.push(c); esc = false; continue; }
        if (c === '\\') { out.push(c); esc = true; continue; }
        if (c === '"') { inStr = !inStr; out.push(c); continue; }
        if (inStr && code < 0x20) {
            if (c === '\n') out.push('\\n');
            else if (c === '\r') out.push('\\r');
            else if (c === '\t') out.push('\\t');
            else if (c === '\b') out.push('\\b');
            else if (c === '\f') out.push('\\f');
            else out.push('\\u' + code.toString(16).padStart(4, '0'));
        } else {
            out.push(c);
        }
    }
    return out.join('');
}

// Parsea JSON tolerando los defectos típicos de output de LLMs:
// 1. Fences ```json ... ```
// 2. Texto extra antes/después del objeto
// 3. Control chars sin escapar dentro de strings (el bug más común)
// 4. Objeto anidado dentro de texto suelto
//
// Devuelve el objeto parseado, o null si no logra recuperar nada.
export function parseLlmJson(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    let s = text.trim();

    // 1. Sacar fences si los hay
    const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fence) s = fence[1].trim();

    // 2. Intento directo
    try { return JSON.parse(s); } catch { /* seguir con sanitización */ }

    // 3. Intento con control chars sanitizados
    const sanitized = sanitizeJsonControlChars(s);
    try { return JSON.parse(sanitized); } catch { /* seguir con brace-matching */ }

    // 4. Brace-matching sobre el texto sanitizado: extrae el primer objeto
    // completo balanceando llaves, tolerando texto adicional antes/después.
    const start = sanitized.indexOf('{');
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < sanitized.length; i++) {
        const ch = sanitized[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) {
                try { return JSON.parse(sanitized.slice(start, i + 1)); }
                catch { return null; }
            }
        }
    }
    return null;
}
