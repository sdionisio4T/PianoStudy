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
    // 'gemini-flash-latest' es el alias vivo que Google mantiene apuntando al
    // mejor flash disponible para keys nuevas. Descubrimos por la mala que los
    // pines antiguos (1.5-flash-latest, 2.0-flash, 2.5-flash) se cierran para
    // keys nuevas sin previo aviso — el alias nos protege de esa rotación.
    // Alternativas si querés pinear: 'gemini-3.5-flash' (baseline estable) o
    // 'gemini-flash-lite-latest' (más barato). Ver la salida completa de
    // ListModels con tu key: v1beta/models?key=... (retorna paginado).
    modelName: 'gemini-flash-latest',
    // Timeout duro del cliente. Si el proxy tarda más, cancelamos y seguimos
    // sin observaciones auditivas (fallback silencioso).
    timeoutMs: 20000,
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
