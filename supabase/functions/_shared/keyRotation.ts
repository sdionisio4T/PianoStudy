// keyRotation.ts — helper compartido para los proxies (groq / gemini /
// openrouter). Todos los proveedores soportan hoy dos secretos por env
// (`<PREFIX>_API_KEY` + `<PREFIX>_API_KEY_2`); esta capa unifica la lógica
// de "cuál key usar" y "si esta falla, probar la otra en la misma request".
//
// Escenario dev actual: ambas keys son free tier. El objetivo es maximizar
// disponibilidad efectiva:
//   - roundrobin entre las dos keys → duplica el TPM/RPM efectivo del proveedor.
//   - fallback dentro de la misma request → si la primera pega 429/5xx,
//     reintentamos UNA vez con la otra antes de devolver error al cliente.
//
// Sin un backing store distribuido, el contador vive en memoria por cold
// start. Suficiente para dev; en prod habría que persistirlo (Redis/DB) o
// aceptar el "sesgo por edge instance", que no es crítico con solo 2 keys.

export interface KeySlotInfo {
  key: string;
  slot: 1 | 2;
}

export interface KeyRotationContext {
  /** Prefix del env var: 'GROQ', 'GEMINI', 'OPENROUTER'. Se resuelven
   *  `${PREFIX}_API_KEY` y `${PREFIX}_API_KEY_2` (el segundo es opcional). */
  prefix: string;
  /** Override opcional del cliente: fuerza el slot 1 o 2 (útil para debug). */
  preferredSlot?: 1 | 2;
}

/** Contador global por prefix para roundrobin. Reinicia en cold start. */
const roundRobinCounters = new Map<string, number>();

/**
 * Devuelve las keys configuradas para un prefix, en orden de intento:
 * primero la elegida por roundrobin (o `preferredSlot` si vino), después
 * la otra como fallback. Slots vacíos se filtran silenciosamente — si solo
 * hay una key configurada, el array tiene un solo elemento.
 *
 * Ejemplo con GROQ_API_KEY seteada y GROQ_API_KEY_2 seteada, primera request:
 *   → [{ key: '...1', slot: 1 }, { key: '...2', slot: 2 }]
 * Segunda request (roundrobin gira):
 *   → [{ key: '...2', slot: 2 }, { key: '...1', slot: 1 }]
 */
export function getKeyAttemptOrder(
  env: { get(name: string): string | undefined },
  ctx: KeyRotationContext,
): KeySlotInfo[] {
  const { prefix, preferredSlot } = ctx;
  const key1 = env.get(`${prefix}_API_KEY`) || '';
  const key2 = env.get(`${prefix}_API_KEY_2`) || '';

  const slot1: KeySlotInfo | null = key1 ? { key: key1, slot: 1 } : null;
  const slot2: KeySlotInfo | null = key2 ? { key: key2, slot: 2 } : null;

  if (!slot1 && !slot2) return [];

  // Preferencia explícita del cliente (debug/override).
  if (preferredSlot === 1 && slot1) return slot2 ? [slot1, slot2] : [slot1];
  if (preferredSlot === 2 && slot2) return slot1 ? [slot2, slot1] : [slot2];

  // Roundrobin: si solo hay una key, no gira.
  if (!slot1) return [slot2!];
  if (!slot2) return [slot1];

  const count = (roundRobinCounters.get(prefix) || 0) + 1;
  roundRobinCounters.set(prefix, count);
  return (count % 2 === 1) ? [slot1, slot2] : [slot2, slot1];
}

/** Status del upstream que amerita intentar con la otra key. 401/403 NO
 *  entran acá — esos son "esta key está mal", no "esta key está saturada",
 *  y si volviéramos a probar con la otra podríamos enmascarar un problema
 *  de config. */
export const TRANSIENT_UPSTREAM_STATUSES = new Set([429, 500, 502, 503, 504]);
