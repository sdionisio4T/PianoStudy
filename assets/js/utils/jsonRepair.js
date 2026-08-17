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
// 5. Respuesta TRUNCADA a mitad de string/objeto/array (sucede cuando el
//    proveedor corta el output por max_tokens o timeout parcial). Se intenta
//    cerrar strings y agregar las llaves/corchetes faltantes para recuperar
//    lo que sí llegó completo del schema.
//
// Devuelve el objeto parseado, o null si no logra recuperar nada.
export function parseLlmJson(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    let s = text.trim();

    // 1. Sacar fences si los hay. Regex tolera fences SIN cierre (típico en
    // respuestas truncadas: llega ```json { ... y no llega el ``` final).
    const fenceClosed = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenceClosed) {
        s = fenceClosed[1].trim();
    } else {
        const fenceOpen = s.match(/^```(?:json)?\s*([\s\S]*)$/i);
        if (fenceOpen) s = fenceOpen[1].trim();
    }

    // 2. Intento directo
    try { return JSON.parse(s); } catch { /* seguir con sanitización */ }

    // 3. Intento con control chars sanitizados
    const sanitized = sanitizeJsonControlChars(s);
    try { return JSON.parse(sanitized); } catch { /* seguir con brace-matching */ }

    // 4. Brace-matching sobre el texto sanitizado: extrae el primer objeto
    // completo balanceando llaves, tolerando texto adicional antes/después.
    const start = sanitized.indexOf('{');
    if (start === -1) return null;
    let depth = 0, arrDepth = 0, inStr = false, esc = false;
    for (let i = start; i < sanitized.length; i++) {
        const ch = sanitized[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0 && arrDepth === 0) {
                try { return JSON.parse(sanitized.slice(start, i + 1)); }
                catch { /* seguir a reparación de truncamiento */ break; }
            }
        }
        else if (ch === '[') arrDepth++;
        else if (ch === ']') arrDepth--;
    }

    // 5. Reparación de respuesta truncada. Si el brace matching se terminó
    // sin cerrar el objeto raíz (depth > 0), casi seguro que la respuesta
    // vino cortada por max_tokens del proveedor. Intentamos:
    //   a) cerrar el string abierto (si inStr al final)
    //   b) sacar el último token incompleto (número/palabra a mitad, coma
    //      colgante, ':' sin valor)
    //   c) cerrar arrays y objetos que quedaron abiertos
    // Si algo del schema se recuperó (los primeros campos completos), el
    // caller obtiene un objeto parcial válido en lugar de perder TODO.
    return _repairTruncatedJson(sanitized, start);
}

// Intenta reparar un JSON truncado desde `sanitized[start..]` cerrando strings,
// arrays y objetos abiertos. Devuelve el objeto parseado o null.
//
// Estrategia: rastrear pares (,) y cierres (}, ]) como puntos "seguros" —
// SÓLO ahí sabemos con certeza que estamos entre valores completos. Un
// string cerrado NO cuenta como safe: puede ser una key esperando su value.
function _repairTruncatedJson(sanitized, start) {
    let inStr = false, esc = false;
    const openStack = [];   // '{' o '[' — orden de apertura para cerrar en reverso
    let lastSafe = -1;      // último índice safe (después de ',' | '}' | ']')
    let lastSafeStack = []; // snapshot del stack en lastSafe

    for (let i = start; i < sanitized.length; i++) {
        const ch = sanitized[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{' || ch === '[') openStack.push(ch);
        else if (ch === '}' || ch === ']') openStack.pop();
        // Sólo ',', '}' o ']' confirman fin-de-valor. Un '"' de cierre podría
        // ser una key todavía sin value ("k":).
        if (ch === '}' || ch === ']' || ch === ',') {
            lastSafe = i;
            lastSafeStack = [...openStack];
        }
    }

    const attempts = [];

    // Cuando el corte cayó dentro de un string, rescatar el string parcial
    // suele conservar el campo más pedagógico (musicalAnalysis a medias >
    // sin musicalAnalysis). Probamos ESE primero.
    if (inStr) {
        const piece = sanitized.slice(start) + '"';
        const closes = openStack.slice().reverse()
            .map(open => open === '{' ? '}' : ']').join('');
        attempts.push(piece + closes);
    }

    // Fallback: cortar en el último punto safe (después de coma o cierre),
    // remover coma colgante, cerrar contenedores. Preserva los campos que
    // llegaron completos aunque perdamos el que estaba en curso.
    if (lastSafe >= start) {
        let piece = sanitized.slice(start, lastSafe + 1).replace(/,\s*$/, '');
        const closes = lastSafeStack.slice().reverse()
            .map(open => open === '{' ? '}' : ']').join('');
        attempts.push(piece + closes);
    }

    // Último recurso: tomar todo y podar sufijo ambiguo (':', ',', keyword
    // incompleto). Solo cierre de contenedores — sirve para casos donde el
    // corte cae después de un ':' sin valor.
    if (!inStr && openStack.length > 0) {
        const piece = sanitized.slice(start)
            .replace(/,\s*"[^"]*"\s*:?\s*$/, '')  // key colgante ("strengths": o "strengths")
            .replace(/[,:\s]+$/, '');             // separadores colgantes
        const closes = openStack.slice().reverse()
            .map(open => open === '{' ? '}' : ']').join('');
        attempts.push(piece + closes);
    }

    for (const candidate of attempts) {
        try { return JSON.parse(candidate); } catch { /* siguiente */ }
    }
    return null;
}
