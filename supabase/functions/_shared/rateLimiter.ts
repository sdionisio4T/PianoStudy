// Rate limiter en memoria, compartido por anthropic-proxy y gemini-proxy.
// Extraído a un módulo aparte (2026-08-09) para poder testearlo con Vitest
// sin depender de Deno.serve ni de ningún API específica de Deno — es lógica
// pura (Map + Date.now()), corre igual en Deno y en Node.
//
// Limitación conocida: en memoria por instancia, se resetea en cold start y
// no es consistente entre instancias si el edge function escala
// horizontalmente. Ver docs/RUNBOOK_DISASTER_RECOVERY.md / docs/DIAGNOSTICO_Y_PLAN.md
// 0.7 para el contexto completo.

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
}

export interface RateLimiter {
  isRateLimited(key: string): boolean;
}

export function createRateLimiter({ limit, windowMs }: RateLimiterOptions): RateLimiter {
  const requestLog = new Map<string, number[]>();

  return {
    isRateLimited(key: string): boolean {
      const now = Date.now();
      const timestamps = (requestLog.get(key) || []).filter((t) => now - t < windowMs);
      timestamps.push(now);
      requestLog.set(key, timestamps);
      return timestamps.length > limit;
    },
  };
}
