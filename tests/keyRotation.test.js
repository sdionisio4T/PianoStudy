import { describe, it, expect, beforeEach } from 'vitest';

// El módulo compartido es TS (edge function), pero exporta funciones puras;
// vitest lo tolera vía el resolver de vite.
const mod = await import('../supabase/functions/_shared/keyRotation.ts');
const { getKeyAttemptOrder, TRANSIENT_UPSTREAM_STATUSES } = mod;

const makeEnv = (vars) => ({ get: (name) => vars[name] });

// Nota: getKeyAttemptOrder usa un contador roundrobin en módulo — no
// podemos "resetearlo" desde fuera. Los tests que dependen del orden
// alterno normalizan cambiando el prefix (los contadores son por prefix).
let uniquePrefix = 0;
const nextPrefix = () => `TEST_${++uniquePrefix}`;

describe('getKeyAttemptOrder', () => {
    it('devuelve array vacío cuando ninguna key está configurada', () => {
        const prefix = nextPrefix();
        const env = makeEnv({});
        expect(getKeyAttemptOrder(env, { prefix })).toEqual([]);
    });

    it('devuelve solo el slot 1 si el 2 no está seteado', () => {
        const prefix = nextPrefix();
        const env = makeEnv({ [`${prefix}_API_KEY`]: 'k1' });
        const result = getKeyAttemptOrder(env, { prefix });
        expect(result).toEqual([{ key: 'k1', slot: 1 }]);
    });

    it('devuelve solo el slot 2 si el 1 no está seteado', () => {
        const prefix = nextPrefix();
        const env = makeEnv({ [`${prefix}_API_KEY_2`]: 'k2' });
        const result = getKeyAttemptOrder(env, { prefix });
        expect(result).toEqual([{ key: 'k2', slot: 2 }]);
    });

    it('con preferredSlot=1 pone el slot 1 primero y el 2 como fallback', () => {
        const prefix = nextPrefix();
        const env = makeEnv({ [`${prefix}_API_KEY`]: 'k1', [`${prefix}_API_KEY_2`]: 'k2' });
        const result = getKeyAttemptOrder(env, { prefix, preferredSlot: 1 });
        expect(result).toEqual([{ key: 'k1', slot: 1 }, { key: 'k2', slot: 2 }]);
    });

    it('con preferredSlot=2 pone el slot 2 primero y el 1 como fallback', () => {
        const prefix = nextPrefix();
        const env = makeEnv({ [`${prefix}_API_KEY`]: 'k1', [`${prefix}_API_KEY_2`]: 'k2' });
        const result = getKeyAttemptOrder(env, { prefix, preferredSlot: 2 });
        expect(result).toEqual([{ key: 'k2', slot: 2 }, { key: 'k1', slot: 1 }]);
    });

    it('preferredSlot ignorado si esa key no está configurada — degrada a la otra', () => {
        const prefix = nextPrefix();
        const env = makeEnv({ [`${prefix}_API_KEY`]: 'k1' });   // no hay slot 2
        const result = getKeyAttemptOrder(env, { prefix, preferredSlot: 2 });
        expect(result).toEqual([{ key: 'k1', slot: 1 }]);
    });

    it('roundrobin alterna en llamadas sucesivas', () => {
        const prefix = nextPrefix();
        const env = makeEnv({ [`${prefix}_API_KEY`]: 'k1', [`${prefix}_API_KEY_2`]: 'k2' });
        const r1 = getKeyAttemptOrder(env, { prefix });
        const r2 = getKeyAttemptOrder(env, { prefix });
        // La primera pone slot 1 primero, la segunda alterna a slot 2.
        expect(r1[0].slot).toBe(1);
        expect(r2[0].slot).toBe(2);
        // Ambas incluyen la otra como fallback.
        expect(r1[1].slot).toBe(2);
        expect(r2[1].slot).toBe(1);
    });
});

describe('TRANSIENT_UPSTREAM_STATUSES', () => {
    it('incluye 429 y los 5xx típicos', () => {
        for (const s of [429, 500, 502, 503, 504]) {
            expect(TRANSIENT_UPSTREAM_STATUSES.has(s)).toBe(true);
        }
    });
    it('NO incluye 401/403 — esos son problemas de la key, no transitorios', () => {
        expect(TRANSIENT_UPSTREAM_STATUSES.has(401)).toBe(false);
        expect(TRANSIENT_UPSTREAM_STATUSES.has(403)).toBe(false);
    });
});
