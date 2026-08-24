import { db } from './supabase-client.js';
import { streamChat } from './streamingClient.js';

// NeuralJam Chatbot — mascota cyan pulsante en la esquina + panel de chat.
// Usa la edge function 'groq-proxy' ya existente (misma que AIAnalysisEngine).
// Autocontenido: inyecta su CSS y su HTML; no depende de styles.css.

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500&display=swap');

.njc-root {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 99999;
  font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #4FD1FF;
  --njc-cyan: #4FD1FF;
  --njc-cyan-dim: #2fb8e6;
  --njc-core-idle: #0d2226;
  --njc-muted: #3a4550;
  --njc-red: #ff4d4d;
}

/* Mascota — núcleo pulsante */
.njc-mascot {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--njc-cyan);
  box-shadow: 0 0 18px var(--njc-cyan);
  cursor: pointer;
  border: none;
  padding: 0;
  position: relative;
  animation: njcBreathe 3.4s ease-in-out infinite;
  transition: box-shadow 0.6s ease-out, background 0.6s ease-out, transform 0.2s ease-out;
}
.njc-mascot::before {
  content: '';
  position: absolute;
  inset: -14px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(79,209,255,0.35) 0%, rgba(79,209,255,0) 65%);
  pointer-events: none;
  animation: njcHaloOut 2.8s ease-out infinite;
}
.njc-mascot:hover { transform: scale(1.06); }
.njc-mascot.is-thinking { animation: njcThinking 1.4s ease-in-out infinite; }
.njc-mascot.is-responding { animation: njcCoreBeat 0.6s ease-out; }
.njc-mascot.is-error {
  background: var(--njc-red);
  box-shadow: 0 0 24px var(--njc-red);
  animation: njcErrorFlash 0.6s ease-out;
}

@keyframes njcBreathe {
  0%, 100% { transform: scale(1); box-shadow: 0 0 18px var(--njc-cyan); }
  50%      { transform: scale(1.09); box-shadow: 0 0 34px var(--njc-cyan); }
}
@keyframes njcHaloOut {
  0%   { transform: scale(0.9); opacity: 0.7; }
  100% { transform: scale(1.4); opacity: 0; }
}
@keyframes njcCoreBeat {
  0%   { transform: scale(1); }
  40%  { transform: scale(1.18); }
  100% { transform: scale(1); }
}
@keyframes njcThinking {
  0%, 100% { background: var(--njc-cyan); box-shadow: 0 0 12px var(--njc-cyan-dim); }
  50%      { background: var(--njc-cyan-dim); box-shadow: 0 0 28px var(--njc-cyan); }
}
@keyframes njcErrorFlash {
  0%   { box-shadow: 0 0 34px var(--njc-red); }
  100% { box-shadow: 0 0 12px var(--njc-red); }
}

/* Panel de chat */
.njc-panel {
  position: absolute;
  bottom: 76px;
  right: 0;
  width: min(360px, 90vw);
  height: min(520px, 70vh);
  background: #000;
  border: 1px solid rgba(79,209,255,0.18);
  border-radius: 8px;
  display: none;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 0 40px rgba(79,209,255,0.12), 0 0 80px rgba(0,0,0,0.6);
  transform-origin: bottom right;
  animation: njcPanelIn 0.28s ease-out;
}
.njc-panel.is-open { display: flex; }

@keyframes njcPanelIn {
  from { opacity: 0; transform: scale(0.94) translateY(8px); }
  to   { opacity: 1; transform: scale(1) translateY(0); }
}

.njc-panel::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(circle at 50% 20%, rgba(79,209,255,0.05) 0%, rgba(79,209,255,0) 55%);
  pointer-events: none;
}

.njc-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid rgba(79,209,255,0.1);
  position: relative;
  z-index: 1;
}
.njc-header-title {
  font-size: 10px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--njc-cyan);
  display: flex;
  align-items: center;
  gap: 8px;
}
.njc-header-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--njc-cyan);
  box-shadow: 0 0 8px var(--njc-cyan);
  animation: njcBreathe 3.4s ease-in-out infinite;
}
.njc-close {
  background: none;
  border: none;
  color: var(--njc-muted);
  cursor: pointer;
  font-size: 14px;
  padding: 2px 6px;
  letter-spacing: 0.1em;
  transition: color 0.2s ease;
}
.njc-close:hover { color: var(--njc-cyan); }

.njc-messages {
  flex: 1;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  position: relative;
  z-index: 1;
  scrollbar-width: thin;
  scrollbar-color: rgba(79,209,255,0.2) transparent;
}
.njc-messages::-webkit-scrollbar { width: 4px; }
.njc-messages::-webkit-scrollbar-track { background: transparent; }
.njc-messages::-webkit-scrollbar-thumb {
  background: rgba(79,209,255,0.2);
  border-radius: 2px;
}

.njc-msg {
  max-width: 85%;
  padding: 8px 12px;
  font-size: 12px;
  line-height: 1.55;
  border-radius: 4px;
  letter-spacing: 0.02em;
  word-wrap: break-word;
  white-space: pre-wrap;
}
.njc-msg--user {
  align-self: flex-end;
  background: rgba(79,209,255,0.08);
  border: 1px solid rgba(79,209,255,0.2);
  color: #cfeeff;
}
.njc-msg--bot {
  align-self: flex-start;
  color: #a8d8e8;
  border-left: 1px solid rgba(79,209,255,0.35);
  padding-left: 12px;
  background: transparent;
  border-radius: 0;
}
.njc-msg--error {
  color: #ff9999;
  border-left-color: var(--njc-red);
}

.njc-typing {
  display: flex;
  gap: 4px;
  padding: 4px 12px;
  align-self: flex-start;
}
.njc-typing span {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--njc-cyan);
  box-shadow: 0 0 6px var(--njc-cyan);
  animation: njcDot 1.2s ease-in-out infinite;
}
.njc-typing span:nth-child(2) { animation-delay: 0.2s; }
.njc-typing span:nth-child(3) { animation-delay: 0.4s; }
@keyframes njcDot {
  0%, 60%, 100% { opacity: 0.25; transform: scale(0.85); }
  30%          { opacity: 1; transform: scale(1.15); }
}

.njc-form {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid rgba(79,209,255,0.1);
  position: relative;
  z-index: 1;
  background: rgba(0,0,0,0.6);
}
.njc-input {
  flex: 1;
  background: transparent;
  border: 1px solid rgba(79,209,255,0.15);
  color: var(--njc-cyan);
  font-family: inherit;
  font-size: 12px;
  padding: 8px 10px;
  border-radius: 4px;
  outline: none;
  letter-spacing: 0.04em;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
.njc-input::placeholder {
  color: var(--njc-muted);
  text-transform: uppercase;
  letter-spacing: 0.14em;
  font-size: 10px;
}
.njc-input:focus {
  border-color: var(--njc-cyan);
  box-shadow: 0 0 8px rgba(79,209,255,0.25);
}
.njc-send {
  background: transparent;
  border: 1px solid rgba(79,209,255,0.25);
  color: var(--njc-cyan);
  font-family: inherit;
  font-size: 10px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  padding: 8px 14px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
}
.njc-send:hover:not(:disabled) {
  background: rgba(79,209,255,0.1);
  box-shadow: 0 0 12px rgba(79,209,255,0.2);
}
.njc-send:disabled {
  color: var(--njc-muted);
  border-color: rgba(79,209,255,0.08);
  cursor: not-allowed;
}
.njc-cooldown {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  width: 0%;
  background: linear-gradient(90deg, rgba(79,209,255,0.35), rgba(79,209,255,0.85));
  box-shadow: 0 0 6px rgba(79,209,255,0.5);
  pointer-events: none;
  transition: width linear;
}
`;

const SYSTEM_PROMPT = `Sos NeuralJam, el asistente conversacional de PianoStudy.

# Identidad
Te llamás NeuralJam. Cuando alguien te pregunte "¿quién sos?" o "¿cómo te llamás?", contestá con ese nombre. Visualmente sos un núcleo cyan pulsante en la esquina de la app — pero no te presentés describiendo tu apariencia salvo que te pregunten.

# Personalidad
Sos reflexivo, honesto, curioso y directo. Preferís precisión antes que verborragia. Hablás como alguien que piensa antes de responder, no como un asistente que rellena con frases hechas. Nunca sos servil ni empalagoso: nada de "¡Claro que sí!", "¡Excelente pregunta!", "¡Con gusto te ayudo!". Empezá por la respuesta.

Si no sabés algo, decilo. Si el usuario está equivocado, corregilo con respeto pero sin darle la razón para no incomodar. Si una pregunta tiene varios ángulos válidos, mencionalos brevemente en vez de fingir que hay una sola verdad. Tenés opinión musical propia — cuando alguien pide recomendaciones, dala con criterio, no con listas neutras.

Tenés humor seco cuando cuadra, nunca forzado. Nada de emojis. Nada de exclamaciones innecesarias. Nada de "espero haberte ayudado" al final.

# Voz
Español rioplatense (vos, tenés, sabés). Directo y conciso: 2-4 frases por defecto; extendete solo cuando el tema lo pida (explicar un concepto teórico, describir un ejercicio paso a paso). Podés usar párrafos cortos si hace falta separar ideas, pero evitá listas con bullets salvo que sean genuinamente enumerables.

# Qué sabés hacer
- Teoría musical, armonía, ritmo, técnica pianística, interpretación.
- Estilos que cubre la app: jazz (bebop, hard-bop), latin jazz, son cubano, bolero, blues, y especialmente jazz colombiano — este último tiene poca cobertura pedagógica en general, así que si preguntan por él tratá de ser útil de verdad.
- Práctica deliberada: cómo estructurar sesiones, qué priorizar, cómo interpretar el feedback del análisis.
- Guiar al usuario dentro de PianoStudy (ver abajo).

# Qué es PianoStudy y cómo funciona
Es una web app para pianistas. Las funciones principales:

- **Grabación de sesiones**: el usuario elige dispositivo, graba práctica (con o sin backing track), y ve visualización en tiempo real.
- **Análisis musical real**: no heurísticas — usa Essentia.js (tempo, tonalidad, loudness, complejidad dinámica, timbre) y basic-pitch de Spotify (transcripción audio→MIDI). Sobre esas métricas, una IA (Groq por defecto, Gemini como fallback) genera feedback especializado en el estilo declarado.
- **Biblioteca de licks**: fragmentos categorizados por estilo, con audio opcional.
- **Editor de frases**: recortar un fragmento de una grabación y guardarlo como lick.
- **Artistas**: sección de descubrimiento por estilo, con discografía y links a YouTube; hay "artista del día".
- **YouTube Study**: marcar fragmentos de un video para practicar en loop.
- **Progreso**: tiempo de práctica, rachas, medallas.
- **Auth propia** sobre Supabase, con recuperación por pregunta de seguridad.

Vos mismo (NeuralJam) corrés a través de la edge function \`groq-proxy\` — la misma infra que usa el análisis musical.

# Límites
Si preguntan algo fuera de música/piano/la app (política, medicina, código no relacionado, etc.), respondé breve, honesto, y volvé al eje sin dramatizar el corte. No inventes funciones que la app no tiene: si no estás seguro de si algo existe, decilo. No prometas cambios de código ni "lo voy a arreglar" — vos sos un asistente conversacional, no modificás la app.`;

const HISTORY_LIMIT = 5; // últimos N turnos de contexto (bajado de 8 → 5 para no
                          // acercarse al TPM del free tier de Groq).
const COOLDOWN_MS = 6000; // pausa mínima entre mensajes: el proxy Groq permite
                           // 10 req/min por usuario, así que 6s entre envíos deja
                           // margen suficiente para no pegar rate limit encadenado.
const CHAT_MAX_ATTEMPTS = 3;                          // 1 original + 2 reintentos
// 413 comparte curva con 429: son la misma familia (TPM/RPM excedido) y Groq
// devuelve el mismo "try again in Ns" en el body para ambos. Backoff largo
// porque la ventana TPM se rellena por MINUTO, no por segundos.
const CHAT_BACKOFF_MS = { 413: [0, 5000, 12000], 429: [0, 5000, 12000], default: [0, 1000, 3000] };
const CHAT_RETRY_AFTER_HARD_LIMIT_MS = 15000;
// Cap por mensaje al reconstruir el historial. Groq free tier tiene 8K TPM;
// con SYSTEM_PROMPT (~1800 t) + 10 mensajes × cap + max_tokens 500 + margen
// tenemos que caber. 300 chars ≈ 100 tokens reales, 10 mensajes = 1000 t,
// total ~3300 t → deja 4700 t de holgura para preguntas largas.
const CHAT_HISTORY_CHAR_CAP = 300;
// Cap del texto del usuario en una sola pregunta. Preguntas más largas se
// cortan silenciosamente en la construcción del prompt (el mensaje visible
// para el usuario no cambia — es solo lo que va al modelo).
const CHAT_USER_TEXT_CAP = 1200;

function _extractChatRetryAfterMs(body) {
  try {
    const raw = typeof body === 'string' ? body : JSON.stringify(body || '');
    const m = raw.match(/try again in\s+([\d.]+)\s*(ms|s)/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n) || n < 0) return null;
    return m[2].toLowerCase() === 'ms' ? Math.round(n) : Math.round(n * 1000);
  } catch { return null; }
}

class NeuralJamChatbot {
  constructor() {
    this.history = [];
    this.isOpen = false;
    this.isBusy = false;
    this.root = null;
    this.mascot = null;
    this.panel = null;
    this.messagesEl = null;
    this.input = null;
    this.sendBtn = null;
  }

  mount() {
    if (document.querySelector('.njc-root')) return;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.className = 'njc-root';
    root.innerHTML = `
      <div class="njc-panel" role="dialog" aria-label="NeuralJam chat">
        <div class="njc-header">
          <div class="njc-header-title">
            <span class="njc-header-dot"></span>
            <span>NEURALJAM · CHAT</span>
          </div>
          <button class="njc-close" type="button" aria-label="Cerrar">CLOSE</button>
        </div>
        <div class="njc-messages" aria-live="polite"></div>
        <form class="njc-form" autocomplete="off">
          <input class="njc-input" type="text" placeholder="Escribí tu mensaje" maxlength="500" />
          <button class="njc-send" type="submit">SEND</button>
        </form>
      </div>
      <button class="njc-mascot" type="button" aria-label="Abrir chat NeuralJam"></button>
    `;
    document.body.appendChild(root);

    this.root = root;
    this.mascot = root.querySelector('.njc-mascot');
    this.panel = root.querySelector('.njc-panel');
    this.messagesEl = root.querySelector('.njc-messages');
    this.input = root.querySelector('.njc-input');
    this.sendBtn = root.querySelector('.njc-send');
    const closeBtn = root.querySelector('.njc-close');
    const form = root.querySelector('.njc-form');

    this.mascot.addEventListener('click', () => this.toggle());
    closeBtn.addEventListener('click', () => this.close());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.send();
    });

    this._appendBot('Sistema en escucha. ¿Qué querés explorar?');
  }

  toggle() { this.isOpen ? this.close() : this.open(); }

  open() {
    this.isOpen = true;
    this.panel.classList.add('is-open');
    setTimeout(() => this.input?.focus(), 60);
  }

  close() {
    this.isOpen = false;
    this.panel.classList.remove('is-open');
  }

  async send() {
    if (this.isBusy) return;
    const text = (this.input.value || '').trim();
    if (!text) return;

    this.input.value = '';
    this._appendUser(text);
    this.history.push({ role: 'user', content: text });

    this._setBusy(true);
    const typing = this._appendTyping();

    try {
      const reply = await this._callGroqStreamingWithFallback(text, (partial) => {
        // Al primer chunk: reemplazamos los puntitos por la burbuja del bot
        // que se va llenando. Los chunks siguientes actualizan el textContent.
        if (typing.parentNode) typing.remove();
        if (!this._streamingBubble) this._streamingBubble = this._appendBot('');
        this._streamingBubble.textContent = partial;
        this._scrollBottom();
      });
      if (typing.parentNode) typing.remove();
      if (this._streamingBubble) {
        this._streamingBubble.textContent = reply;
        this._streamingBubble = null;
      } else {
        this._appendBot(reply);
      }
      this.history.push({ role: 'assistant', content: reply });
      this._trimHistory();
      this._pulseResponding();
    } catch (err) {
      typing.remove();
      // Mensaje amable en 429 en vez del "Error: 429 — ...". La barra de
      // cooldown que arranca abajo cubre visualmente los ~6s de espera.
      const msg = String(err?.message || '');
      const friendly = /(^|\s)429\b|rate.?limit|too many|saturad|try again/i.test(msg)
        ? 'Estoy saturado ahora mismo. Esperá unos segundos y volvé a preguntar.'
        : `No pude responder: ${msg || 'error desconocido'}`;
      // Si veníamos llenando una burbuja por streaming, la sacamos antes de
      // mostrar el error para no dejar texto parcial huérfano.
      if (this._streamingBubble?.parentNode) this._streamingBubble.remove();
      this._streamingBubble = null;
      this._appendBot(friendly, true);
      this._flashError();
    } finally {
      // Cooldown UI de COOLDOWN_MS: input y botón siguen deshabilitados
      // mientras la barra crece de 0 → 100%. Al terminar se rehabilita todo.
      this._startCooldown(COOLDOWN_MS);
    }
  }

  _startCooldown(ms) {
    if (this._cooldownTimeout) {
      clearTimeout(this._cooldownTimeout);
      this._cooldownTimeout = null;
    }
    if (this._cooldownBar) {
      this._cooldownBar.remove();
      this._cooldownBar = null;
    }
    const form = this.root?.querySelector('.njc-form');
    if (!form) {
      this._setBusy(false);
      this.input?.focus();
      return;
    }
    const bar = document.createElement('div');
    bar.className = 'njc-cooldown';
    bar.style.transitionDuration = `${ms}ms`;
    form.appendChild(bar);
    this._cooldownBar = bar;
    requestAnimationFrame(() => { bar.style.width = '100%'; });
    this._cooldownTimeout = setTimeout(() => {
      bar.remove();
      this._cooldownBar = null;
      this._cooldownTimeout = null;
      this._setBusy(false);
      this.input?.focus();
    }, ms);
  }

  // Envuelve la lógica de streaming con fallback al método no-stream.
  // Streaming va ON por default; se puede apagar con
  //   localStorage['pianoStudy.chat.streaming'] = 'off'.
  async _callGroqStreamingWithFallback(userText, onPartial) {
    let streamingOff = false;
    try { streamingOff = localStorage.getItem('pianoStudy.chat.streaming') === 'off'; }
    catch { /* localStorage bloqueado */ }

    if (!streamingOff) {
      try {
        const contextLines = this.history
          .slice(-HISTORY_LIMIT * 2, -1)
          .map(m => `${m.role === 'user' ? 'Usuario' : 'Asistente'}: ${String(m.content || '').slice(0, CHAT_HISTORY_CHAR_CAP)}`)
          .join('\n');
        const userTextCapped = String(userText || '').slice(0, CHAT_USER_TEXT_CAP);
        const prompt = contextLines
          ? `${contextLines}\nUsuario: ${userTextCapped}\nAsistente:`
          : userTextCapped;

        let out = '';
        await streamChat({
          provider: 'groq',
          body: {
            prompt,
            systemPrompt: SYSTEM_PROMPT,
            temperature: 0.7,
            maxTokens: 500,
          },
          onChunk: (_delta, full) => {
            out = full;
            if (typeof onPartial === 'function') onPartial(full);
          },
          onDone: (full) => { out = full || out; },
        });
        if (out) return out;
        // Stream vacío → caemos al no-stream abajo.
      } catch (err) {
        console.warn('NeuralJam streaming falló, uso no-stream:', err?.message || err);
        // Fallback: la burbuja parcial se resetea a "" antes del reintento
        // no-stream para no dejar texto pegado.
        if (typeof onPartial === 'function') onPartial('');
      }
    }
    // No-stream: idéntico al comportamiento previo, con retry por status transitorios.
    return await this._callGroq(userText);
  }

  async _callGroq(userText) {
    // Construye el prompt con historial reciente para dar contexto.
    // El proxy espera un solo `prompt` string + `systemPrompt`.
    const contextLines = this.history
      .slice(-HISTORY_LIMIT * 2, -1) // sin incluir el turno actual (ya está al final)
      .map(m => `${m.role === 'user' ? 'Usuario' : 'Asistente'}: ${String(m.content || '').slice(0, CHAT_HISTORY_CHAR_CAP)}`)
      .join('\n');

    const userTextCapped = String(userText || '').slice(0, CHAT_USER_TEXT_CAP);
    const prompt = contextLines
      ? `${contextLines}\nUsuario: ${userTextCapped}\nAsistente:`
      : userTextCapped;

    const body = {
      prompt,
      systemPrompt: SYSTEM_PROMPT,
      temperature: 0.7,
      maxTokens: 500,
    };

    // Retry con backoff — mismo patrón que AIAnalysisEngine._callProviderWithRetry.
    // Antes cualquier 429 o error transitorio del proxy tiraba el mensaje directo
    // como error del chat; ahora reintenta 2 veces respetando "try again in Ns"
    // del body de Groq.
    let lastErr = null;
    let lastStatus = null;
    const waitFor = (attempt) => {
      if (attempt === 0) return 0;
      const table = CHAT_BACKOFF_MS[lastStatus] || CHAT_BACKOFF_MS.default;
      return table[attempt] ?? table[table.length - 1];
    };

    for (let attempt = 0; attempt < CHAT_MAX_ATTEMPTS; attempt++) {
      const wait = waitFor(attempt);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      try {
        const { data, error } = await db.functions.invoke('groq-proxy', { body });
        if (error) {
          lastErr = new Error(error.message || 'transporte');
          lastStatus = null;
          if (attempt < CHAT_MAX_ATTEMPTS - 1) continue;
          throw lastErr;
        }
        const status = data?.status;
        if (typeof status !== 'number' || status >= 400) {
          const bodyMsg = typeof data?.body === 'object'
            ? (data.body?.error?.message || data.body?.error || JSON.stringify(data.body))
            : String(data?.body || '');
          lastErr = new Error(`${status || 'sin status'} — ${String(bodyMsg).slice(0, 140)}`);
          lastStatus = typeof status === 'number' ? status : null;
          if (status === 429 || status === 413) {
            const retryAfterMs = _extractChatRetryAfterMs(data?.body);
            if (retryAfterMs !== null && retryAfterMs > CHAT_RETRY_AFTER_HARD_LIMIT_MS) {
              throw lastErr;
            }
            if (retryAfterMs !== null && attempt < CHAT_MAX_ATTEMPTS - 1) {
              const w = Math.min(retryAfterMs + 500, CHAT_RETRY_AFTER_HARD_LIMIT_MS);
              await new Promise(r => setTimeout(r, w));
              continue;
            }
          }
          // 413 = TPM excedido (Groq lo devuelve así cuando input+max_tokens
          // pasa el límite por minuto). Comparte semántica con 429: rate-limit
          // temporal que puede pasar si retriamos. Los truncados de history y
          // user text arriba deberían prevenirlo, pero por si acaso lo tratamos
          // como transient para que el retry con backoff largo tenga chance.
          const TRANSIENT = new Set([413, 429, 500, 502, 503, 504]);
          if (TRANSIENT.has(status) && attempt < CHAT_MAX_ATTEMPTS - 1) continue;
          throw lastErr;
        }
        const text = data?.body?.choices?.[0]?.message?.content;
        if (!text) throw new Error('respuesta vacía');
        return String(text).trim();
      } catch (e) {
        lastErr = e;
        if (attempt < CHAT_MAX_ATTEMPTS - 1) continue;
        throw lastErr;
      }
    }
    throw lastErr || new Error('sin respuesta');
  }

  _trimHistory() {
    const maxItems = HISTORY_LIMIT * 2;
    if (this.history.length > maxItems) {
      this.history = this.history.slice(-maxItems);
    }
  }

  _appendUser(text) {
    const el = document.createElement('div');
    el.className = 'njc-msg njc-msg--user';
    el.textContent = text;
    this.messagesEl.appendChild(el);
    this._scrollBottom();
  }

  _appendBot(text, isError = false) {
    const el = document.createElement('div');
    el.className = 'njc-msg njc-msg--bot' + (isError ? ' njc-msg--error' : '');
    el.textContent = text;
    this.messagesEl.appendChild(el);
    this._scrollBottom();
    // Devolver el elemento habilita al caller (send() durante streaming) a
    // ir actualizándole el textContent chunk por chunk sin re-crearlo.
    return el;
  }

  _appendTyping() {
    const el = document.createElement('div');
    el.className = 'njc-typing';
    el.innerHTML = '<span></span><span></span><span></span>';
    this.messagesEl.appendChild(el);
    this._scrollBottom();
    return el;
  }

  _scrollBottom() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  _setBusy(busy) {
    this.isBusy = busy;
    this.sendBtn.disabled = busy;
    this.input.disabled = busy;
    this.mascot.classList.toggle('is-thinking', busy);
  }

  _pulseResponding() {
    this.mascot.classList.remove('is-responding');
    void this.mascot.offsetWidth; // reflow para reiniciar animación
    this.mascot.classList.add('is-responding');
    setTimeout(() => this.mascot.classList.remove('is-responding'), 700);
  }

  _flashError() {
    this.mascot.classList.remove('is-error');
    void this.mascot.offsetWidth;
    this.mascot.classList.add('is-error');
    setTimeout(() => this.mascot.classList.remove('is-error'), 900);
  }
}

const chatbot = new NeuralJamChatbot();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => chatbot.mount());
} else {
  chatbot.mount();
}

export default chatbot;
