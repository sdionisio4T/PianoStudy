// GeminiAudioConfig.js — configuración central de la "escucha profunda" con Gemini.
//
// Todos los tunables viven acá. Para bajar consumo, cambiar únicamente estos
// valores — el pipeline (selector/clipper/analyzer) los lee de config sin
// hardcodear en múltiples lugares. Ver docs/PLAN_PROGRESO.md y la Fase 2 del
// plan Gemini Audio para el contexto.

export const GEMINI_AUDIO_CONFIG = {
    // Flag maestro. Si está en false, ni siquiera se selecciona ni se llama a
    // Gemini — el análisis queda con Groq + análisis local, como antes. Se
    // deja como flag interno hasta terminar el A/B (Fase 14 del plan).
    enabled: true,

    // Selección de fragmentos ────────────────────────────────────────────────
    // 3 clips × 8s = 24s máximos por análisis. Bajarlo primero si el costo
    // aprieta. Suele haber espacio: la mayoría de sesiones tiene <=2 tramos
    // realmente informativos.
    maxSegments: 3,
    segmentDurationSec: 8,
    maxTotalAudioSec: 24,

    // Por debajo de este umbral, no llamamos a Gemini (la ganancia de escucha
    // sobre <3s es marginal y el costo fijo por llamada no compensa).
    minSessionDurationSec: 3,
    // Por debajo de este umbral, mandamos la sesión entera sin selector.
    directSendMaxSec: 8,

    // Preprocesamiento ───────────────────────────────────────────────────────
    // 16 kHz mono 16-bit: sweet spot entre calidad para percepción musical y
    // tokens (Gemini cuenta ~32 tokens/seg a 16k). Subirlo a 22050 duplica
    // tokens sin ganancia perceptual real para lo que Gemini escucha.
    targetSampleRate: 16000,
    // RMS mínimo para considerar que un clip tiene señal. Si es menor, se
    // descarta como "silencio" — no vale la pena gastar la llamada.
    minSignalRms: 0.005,

    // Llamada al proxy ───────────────────────────────────────────────────────
    // Rotación entre modelos con cuota diaria separada. Cada modelo del free
    // tier de Google tiene su propio contador (~500 req/día), así que probar
    // varios en orden multiplica la capacidad total sin comprar plan.
    //
    // Lógica en el analyzer:
    //   - se prueba el primero; si devuelve 429/403 con quota → siguiente
    //     modelo INMEDIATAMENTE (no reintenta el mismo).
    //   - errores transitorios (503, 500, timeout) → reintenta el mismo modelo
    //     antes de pasar al siguiente.
    //   - si TODOS fallan → null (fallback silencioso, como siempre).
    //
    // El orden es de más capaz/costoso a más barato — así usamos el bueno
    // hasta agotarlo, después bajamos calidad. Los pines pueden desaparecer
    // sin aviso para keys nuevas, por eso al final va un alias que Google
    // mantiene vivo apuntando al mejor flash disponible.
    modelNames: [
        'gemini-3.5-flash-lite',   // único modelo que responde en esta key hoy
    ],
    // LEGACY: se conserva por compat con código externo que pudo haberla usado.
    // Si `modelNames` viene vacío, el analyzer cae a este valor único.
    modelName: 'gemini-3.5-flash-lite',
    // Timeout duro del cliente. Si el proxy tarda más, cancelamos y seguimos
    // sin observaciones auditivas (fallback silencioso).
    // Subido de 20000 → 35000: con maxSegments=3 y segmentDurationSec=8 (24s
    // de audio) más el prompt + JSON de salida, Gemini Flash puede rondar
    // los 15-25s bajo carga normal y 30s+ bajo picos. 20s dejaba muy poco
    // margen y disparaba fallback frecuentemente. Si seguís viendo timeouts:
    // bajar maxSegments a 2 (16s) o segmentDurationSec a 6 antes de subir más.
    timeoutMs: 35000,
    // Un JSON completo (4 obs + 3 strengths + 3 areas + 2 uncertainties en
    // español, frases hasta 160 chars) llega tranquilo a 900-1100 tokens.
    // 500 nos truncaba respuestas ricas mid-palabra (Google devuelve
    // finishReason=MAX_TOKENS y el JSON queda incompleto → parse null).
    // 1500 da ~50% de margen sin costo real: audio output cuesta centavos.
    maxOutputTokens: 1500,
    temperature: 0.4,

    // Retry ante errores transitorios (503/429/5xx). Un reintento con backoff
    // corto absorbe los picos temporales de Gemini sin degradar UX. Tests
    // pueden pasar retryBackoffMs: 0 para no esperar.
    retryAttempts: 1,
    retryBackoffMs: 1500,
};
