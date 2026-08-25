// app-audio-flow.js — flujo de grabación, editor de frases y análisis IA.
// Mezclado sobre PianoStudyApp.prototype en app-init.js.

import { escapeHtml, sanitizeFileName } from '../utils/sanitizers.js';
import { AIAnalysisEngine } from '../modules/AIAnalysisEngine.js';
import { deriveFeatures } from '../modules/AudioFeatures.js';
import { selectSegments } from '../modules/AudioSegmentSelector.js';
import { clipSegments } from '../modules/GeminiAudioClipper.js';
import { analyzeAudioClips } from '../modules/GeminiAudioAnalyzer.js';
import { GEMINI_AUDIO_CONFIG } from '../modules/GeminiAudioConfig.js';
import { assessAnalysis } from '../modules/AnalysisReliability.js';
import { MidiRecorder, midiBlobToAnalysis } from '../modules/MidiRecorder.js';
import { MidiPianoRoll } from '../modules/MidiPianoRoll.js';
import { streamChat } from '../modules/streamingClient.js';
import { saveTake as saveAfterPracticeTake, getTake as getAfterPracticeTake, deleteTake as deleteAfterPracticeTake } from '../modules/AfterPracticeStore.js';
import {
    insertLick, updateLick, uploadLickAudio,
    loadRecordingsFromDB, uploadRecording, getRecordingPublicUrl, deleteRecording,
    downloadRecordingBlob,
    ERR_MSG
} from '../modules/SupabaseDataManager.js';
import { db } from '../modules/supabase-client.js';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';
import TimelinePlugin from 'wavesurfer.js/dist/plugins/timeline.esm.js';
import ZoomPlugin from 'wavesurfer.js/dist/plugins/zoom.esm.js';
import HoverPlugin from 'wavesurfer.js/dist/plugins/hover.esm.js';
import flatpickr from 'flatpickr';
import { Spanish } from 'flatpickr/dist/l10n/es.js';
import 'flatpickr/dist/flatpickr.min.css';

export const audioFlowMixin = {
    initializeAIEngine() {
        this.aiEngine = new AIAnalysisEngine();
        this.updateAIStatusIndicator();
    },

    updateAIStatusIndicator() {
        const dot = document.getElementById('ai-status-dot');
        const text = document.getElementById('ai-status-text');

        if (dot) {
            dot.classList.toggle('ai-status-dot--on', true);
            dot.classList.toggle('ai-status-dot--off', false);
        }
        if (text) {
            text.textContent = 'IA Activa';
        }
    },

    async showAnalysisSection() {
        this.showSection('ai-analysis');
        await this.loadRecordingsFromServer();
        this.loadRecordingsForAnalysis();
        this._initGeminiToggle();
        this._initProviderChips();
    },

    // Toggle "Escucha profunda (Gemini)". Persistido por usuario. Default ON
    // — el pipeline híbrido corre igual que hoy salvo que el usuario lo apague
    // explícitamente para comparar A vs B (Fase 14 del plan).
    _initGeminiToggle() {
        const toggle = document.getElementById('analysis-gemini-toggle');
        if (!toggle) return;
        const key = this.userKey('pianostudy-gemini-audio-enabled');
        const stored = this.safeGetLocalStorage(key, true);
        toggle.checked = stored !== false;
        if (!toggle._geminiWired) {
            toggle._geminiWired = true;
            toggle.addEventListener('change', () => {
                this.safeSetLocalStorage(
                    this.userKey('pianostudy-gemini-audio-enabled'),
                    !!toggle.checked,
                );
            });
        }
    },

    _isGeminiAudioEnabled() {
        const toggle = document.getElementById('analysis-gemini-toggle');
        if (toggle) return !!toggle.checked;
        const stored = this.safeGetLocalStorage(
            this.userKey('pianostudy-gemini-audio-enabled'), true,
        );
        return stored !== false;
    },

    // Chip selector "Motor de IA" — persiste el proveedor elegido en
    // localStorage con la MISMA clave que AIAnalysisEngine._getProvider lee
    // (`pianoStudy.provider.analysis` y `.chat`). Un solo selector controla
    // ambos roles por simplicidad — si algún día se quiere separarlos, se
    // agrega un segundo chip group con `data-role="chat"`.
    _initProviderChips() {
        const container = document.getElementById('analysis-provider-chips');
        if (!container || container._providerWired) return;
        container._providerWired = true;

        const validProviders = new Set(['gemini', 'groq', 'openrouter']);
        const readCurrent = () => {
            try {
                const v = localStorage.getItem('pianoStudy.provider.analysis');
                return validProviders.has(v) ? v : 'gemini';
            } catch { return 'gemini'; }
        };
        const writeCurrent = (provider) => {
            try {
                localStorage.setItem('pianoStudy.provider.analysis', provider);
                localStorage.setItem('pianoStudy.provider.chat', provider);
            } catch { /* modo privado / SSR — persistencia se pierde, la selección visual queda igual */ }
        };
        const paint = (active) => {
            container.querySelectorAll('.provider-chip').forEach(btn => {
                const isActive = btn.dataset.provider === active;
                btn.setAttribute('aria-checked', isActive ? 'true' : 'false');
            });
        };

        paint(readCurrent());

        container.addEventListener('click', (e) => {
            const btn = e.target.closest('.provider-chip');
            if (!btn) return;
            const provider = btn.dataset.provider;
            if (!validProviders.has(provider)) return;
            writeCurrent(provider);
            paint(provider);
        });
    },

    // "Lo que estás haciendo bien" — bullets simples con checkmark, máx 2.
    // Oculta la sección si el LLM no aportó fortalezas (mejor no mostrar que
    // forzar un "bien hecho" genérico — ver REGLA 8).
    _renderStrengths(strengths) {
        const section = document.getElementById('analysis-strengths-section');
        const list = document.getElementById('analysis-strengths-list');
        if (!section || !list) return;
        const items = Array.isArray(strengths)
            ? strengths.filter(s => typeof s === 'string' && s.trim())
            : [];
        if (!items.length) {
            section.classList.add('hidden');
            list.innerHTML = '';
            return;
        }
        list.innerHTML = items.slice(0, 2).map(s => `
            <li class="analysis-strength-item">
                <i class="fas fa-check-circle" aria-hidden="true"></i>
                <span>${escapeHtml(s)}</span>
            </li>
        `).join('');
        section.classList.remove('hidden');
    },

    // Paso 01 del recorrido — Tu percepción.
    // Refleja lo que el pianista respondió en el modal de autoevaluación
    // (rating, área más floja, hipótesis) como primer bloque del flujo. Si
    // el usuario saltó el modal, la sección queda oculta y el paso 02 pasa
    // a ser el primero visible. Se lee de currentAnalysis.selfEvaluation
    // (guardado en startAnalysis) y no vuelve a preguntar al usuario.
    _renderPerception(selfEval) {
        const section = document.getElementById('analysis-perception-section');
        const content = document.getElementById('analysis-perception-content');
        if (!section || !content) return;

        const rating = Number(selfEval?.rating);
        const weakArea = String(selfEval?.weakArea || '').trim();
        const prediction = String(selfEval?.prediction || '').trim();
        const hasRating = Number.isFinite(rating) && rating >= 1 && rating <= 5;

        // Si el pianista saltó el modal, no vino nada: ocultamos la sección
        // para que el paso 02 arranque el recorrido.
        if (!hasRating && !weakArea && !prediction) {
            section.classList.add('hidden');
            content.innerHTML = '';
            return;
        }

        const weakAreaLabels = {
            timing: 'Timing',
            dinamica: 'Dinámica',
            notas: 'Notas',
            fraseo: 'Fraseo',
            otro: 'Otro',
        };

        const rows = [];

        if (hasRating) {
            const ratingScale = { 1: 'muy floja', 2: 'floja', 3: 'regular', 4: 'buena', 5: 'muy buena' };
            const dots = Array.from({ length: 5 }, (_, i) =>
                `<span class="perception-rating__dot ${i < rating ? 'is-on' : ''}"></span>`
            ).join('');
            rows.push(`
                <div class="perception-row">
                    <span class="perception-label">Cómo la sentiste</span>
                    <span class="perception-rating">
                        <span class="perception-rating__dots" aria-hidden="true">${dots}</span>
                        <span>${rating}/5 · ${ratingScale[rating]}</span>
                    </span>
                </div>
            `);
        }

        if (weakArea) {
            const label = weakAreaLabels[weakArea] || weakArea;
            rows.push(`
                <div class="perception-row">
                    <span class="perception-label">Dónde sentiste el problema</span>
                    <span class="perception-chip">${escapeHtml(label)}</span>
                </div>
            `);
        }

        if (prediction) {
            rows.push(`
                <div class="perception-row">
                    <span class="perception-label">Tu hipótesis</span>
                </div>
                <blockquote class="perception-prediction">${escapeHtml(prediction)}</blockquote>
            `);
        }

        content.innerHTML = rows.join('');
        section.classList.remove('hidden');
    },

    // Paso 06 del recorrido — Después de practicar.
    // Cierra el ciclo experimento → escuchar → evaluar. Persistencia local
    // por análisis; en Fase 2 no toca backend ni Supabase. La key incluye
    // recordingId + timestamp del análisis para no colisionar entre tomas
    // de la misma grabación, y sobrevive a recargar la página o volver al
    // análisis desde el historial (currentAnalysis conserva ambos campos).
    _afterPracticeKey(analysis) {
        const rid = String(analysis?.recordingId || 'unknown');
        const ts = Number(analysis?.timestamp || 0);
        return `pianostudy.afterpractice.${rid}.${ts}`;
    },

    _loadAfterPractice(analysis) {
        try {
            const raw = localStorage.getItem(this._afterPracticeKey(analysis));
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return null;
            return parsed;
        } catch (err) {
            console.warn('[afterpractice] load falló:', err);
            return null;
        }
    },

    _saveAfterPractice(analysis, data) {
        try {
            localStorage.setItem(this._afterPracticeKey(analysis), JSON.stringify(data));
        } catch (err) {
            console.warn('[afterpractice] save falló:', err);
        }
    },

    // Etiquetas legibles de las 4 opciones de "¿qué notaste?".
    // Los slugs son los que se guardan; las labels se derivan al render.
    _afterPracticeNoticedLabels: {
        improved: 'Mejoró',
        same: 'Igual',
        changed_other: 'Cambió otra cosa',
        no_diff: 'No noté diferencia',
    },

    _renderAfterPractice(analysis) {
        const section = document.getElementById('analysis-afterpractice-section');
        const content = document.getElementById('analysis-afterpractice-content');
        if (!section || !content) return;

        // Estado local (no persistente entre renders): lo que el pianista
        // eligió/escribió en el formulario antes de darle guardar.
        const draft = this._afterPracticeDraft || { noticed: null, worked: '' };
        const saved = this._loadAfterPractice(analysis);
        const editing = Boolean(this._afterPracticeEditing);
        const showForm = editing || !saved;

        if (!showForm && saved) {
            const noticedLabel = this._afterPracticeNoticedLabels[saved.noticed] || '—';
            const workedText = String(saved.worked || '').trim();
            content.innerHTML = `
                <div class="afterpractice__saved">
                    <div class="afterpractice__saved-row">
                        <span class="afterpractice__saved-label">Qué notaste</span>
                        <span class="afterpractice__saved-value is-chip">${escapeHtml(noticedLabel)}</span>
                    </div>
                    ${workedText ? `
                        <div class="afterpractice__saved-row">
                            <span class="afterpractice__saved-label">Qué funcionó</span>
                            <span class="afterpractice__saved-value">${escapeHtml(workedText)}</span>
                        </div>
                    ` : ''}
                    <button type="button" class="afterpractice__edit" data-action="afterpractice-edit">
                        <i class="fas fa-pen"></i> Editar respuesta
                    </button>
                </div>
            `;
        } else {
            // Precarga del formulario con lo guardado (si estamos editando) o
            // con el borrador temporal (si el pianista está en medio de escribir).
            const seed = editing && saved ? saved : draft;
            const noticed = seed.noticed || null;
            const worked = String(seed.worked || '');

            const optionsHtml = Object.entries(this._afterPracticeNoticedLabels)
                .map(([slug, label]) => `
                    <button type="button"
                            class="afterpractice__option ${noticed === slug ? 'is-active' : ''}"
                            data-action="afterpractice-option"
                            data-value="${slug}">${escapeHtml(label)}</button>
                `).join('');

            content.innerHTML = `
                <p class="afterpractice__intro">Cuando probaste el experimento, <strong>¿qué cambió?</strong></p>
                <div class="afterpractice__field">
                    <span class="afterpractice__label">¿Qué notaste?</span>
                    <div class="afterpractice__options" role="radiogroup" aria-label="¿Qué notaste después del experimento?">
                        ${optionsHtml}
                    </div>
                </div>
                <div class="afterpractice__field">
                    <label class="afterpractice__label" for="afterpractice-worked">¿Qué crees que funcionó?</label>
                    <textarea id="afterpractice-worked"
                              class="afterpractice__textarea"
                              maxlength="400"
                              placeholder="Ej: bajar el tempo al 70% me dejó escuchar el pulso interno"
                              data-action="afterpractice-worked">${escapeHtml(worked)}</textarea>
                </div>
                <div class="afterpractice__actions">
                    <button type="button" class="afterpractice__save" data-action="afterpractice-save" ${noticed ? '' : 'disabled'}>
                        <i class="fas fa-check"></i> Guardar
                    </button>
                    ${saved ? `<button type="button" class="afterpractice__skip" data-action="afterpractice-cancel">Cancelar edición</button>` : ''}
                </div>
                <p class="afterpractice__hint">Se guarda solo en este dispositivo. Podés editarlo más tarde.</p>
            `;
        }

        // Delegación de eventos: un único onclick por render (reemplazamos el
        // innerHTML entero, así que no acumulamos handlers viejos).
        content.onclick = (ev) => {
            const target = ev.target.closest('[data-action]');
            if (!target) return;
            const action = target.getAttribute('data-action');
            if (action === 'afterpractice-option') {
                const value = target.getAttribute('data-value');
                this._afterPracticeDraft = {
                    ...(this._afterPracticeDraft || {}),
                    noticed: value,
                    worked: (content.querySelector('#afterpractice-worked')?.value || '').trim(),
                };
                this._renderAfterPractice(analysis);
            } else if (action === 'afterpractice-save') {
                const noticed = this._afterPracticeDraft?.noticed
                    || (this._afterPracticeEditing ? this._loadAfterPractice(analysis)?.noticed : null);
                if (!noticed) return;
                const worked = (content.querySelector('#afterpractice-worked')?.value || '').trim();
                this._saveAfterPractice(analysis, {
                    noticed,
                    worked,
                    savedAt: Date.now(),
                });
                this._afterPracticeDraft = null;
                this._afterPracticeEditing = false;
                this._renderAfterPractice(analysis);
            } else if (action === 'afterpractice-edit') {
                this._afterPracticeEditing = true;
                this._renderAfterPractice(analysis);
            } else if (action === 'afterpractice-cancel') {
                this._afterPracticeEditing = false;
                this._afterPracticeDraft = null;
                this._renderAfterPractice(analysis);
            }
        };

        // Guardar el texto en el borrador conforme el pianista escribe, para
        // que si toca una opción (que fuerza rerender) no pierda lo tipeado.
        const ta = content.querySelector('#afterpractice-worked');
        if (ta) {
            ta.oninput = () => {
                this._afterPracticeDraft = {
                    ...(this._afterPracticeDraft || { noticed: null }),
                    worked: ta.value,
                };
            };
        }

        section.classList.remove('hidden');
    },

    // ═════════════════════════════════════════════════════════════════════
    // FASE 3 — Grabación de toma B + comparación A/B
    //
    // Zona de grabación dentro del paso 06 y comparación waveform-a-waveform
    // en el paso 07. Persistencia en IndexedDB (ver AfterPracticeStore.js);
    // solo se guarda una toma por análisis (regrabar reemplaza).
    // ═════════════════════════════════════════════════════════════════════

    _afterPracticeFormatTimer(ms) {
        const total = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
        const m = Math.floor(total / 60);
        const s = Math.floor(total % 60);
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    },

    // Estado del recorder de toma B. Vive en this._afterPracticeRec para
    // que _afterPracticeStopRecording pueda accederlo desde el handler.
    // Se resetea al cambiar de análisis en displayAnalysisResults.
    _afterPracticeRec: null,
    _afterPracticeMidiRec: null,

    // ¿El análisis primario fue MIDI? Miramos el tipo del blob que guardó
    // startAnalysis en currentAnalysisAudioBlob. Si es MIDI, el recorder
    // ofrece dos modos (audio-mic + midi-teclado); si no, solo audio-mic.
    _isPrimaryMidiAnalysis() {
        const t = this.currentAnalysisAudioBlob?.type || '';
        return t === 'audio/midi' || t === 'audio/x-midi';
    },

    _isMidiBlob(blob) {
        const t = blob?.type || '';
        return t === 'audio/midi' || t === 'audio/x-midi';
    },

    _renderAfterPracticeRecording(analysis) {
        const el = document.getElementById('analysis-afterpractice-recorder');
        if (!el) return;
        const audioActive = !!this._afterPracticeRec?.mediaRecorder;
        const midiActive = !!this._afterPracticeMidiRec?.isRecording;
        const isRecording = audioActive || midiActive;

        if (isRecording) {
            const startTime = audioActive
                ? this._afterPracticeRec.startTime
                : this._afterPracticeMidiRec.startTime;
            const kindLabel = audioActive ? 'audio con mic' : 'MIDI desde el teclado';
            const elapsed = Date.now() - startTime;
            el.innerHTML = `
                <p class="afterpractice-recorder__hint">Grabando toma B (${escapeHtml(kindLabel)}) — tocá el fragmento y detené cuando termines.</p>
                <span class="afterpractice-recorder__timer" data-role="ap-timer">${this._afterPracticeFormatTimer(elapsed)}</span>
                <button type="button" class="afterpractice-recorder__btn afterpractice-recorder__btn--recording" data-action="ap-rec-stop">
                    <i class="fas fa-stop"></i> Detener
                </button>
            `;
        } else {
            // Siempre ofrecemos ambos modos, independientemente del tipo del
            // análisis original: el pianista puede grabar en audio o en MIDI
            // según lo que tenga a mano en ese momento. El adapter A/B luego
            // pintará el player que corresponda al blob que llegó.
            const buttons = `
                <button type="button" class="afterpractice-recorder__btn" data-action="ap-rec-start-audio">
                    <i class="fas fa-microphone"></i> Grabar audio (mic)
                </button>
                <button type="button" class="afterpractice-recorder__btn" data-action="ap-rec-start-midi">
                    <i class="fas fa-keyboard"></i> Grabar MIDI (teclado)
                </button>
            `;
            el.innerHTML = `
                <p class="afterpractice-recorder__hint">Volvé a tocar el fragmento y grabalo para comparar antes / después con tu oído.</p>
                ${buttons}
            `;
            // Post-render async: si ya hay una toma guardada, actualizamos el copy.
            getAfterPracticeTake(this._afterPracticeKey(analysis)).then((take) => {
                if (!take || this._afterPracticeRec || this._afterPracticeMidiRec) return;
                const hint = el.querySelector('.afterpractice-recorder__hint');
                if (hint) hint.textContent = 'Ya tenés una toma B guardada abajo. Podés regrabar cuando quieras.';
                el.querySelectorAll('[data-action="ap-rec-start-audio"] i').forEach(i => { i.className = 'fas fa-rotate'; });
                el.querySelectorAll('[data-action="ap-rec-start-audio"]').forEach(b => {
                    const span = b.childNodes[b.childNodes.length - 1];
                    if (span && span.nodeType === Node.TEXT_NODE) span.textContent = ' Regrabar audio';
                });
                el.querySelectorAll('[data-action="ap-rec-start-midi"] i').forEach(i => { i.className = 'fas fa-rotate'; });
                el.querySelectorAll('[data-action="ap-rec-start-midi"]').forEach(b => {
                    const span = b.childNodes[b.childNodes.length - 1];
                    if (span && span.nodeType === Node.TEXT_NODE) span.textContent = ' Regrabar MIDI';
                });
            });
        }

        // Delegación de eventos idempotente (reemplazamos innerHTML entero).
        el.onclick = (ev) => {
            const t = ev.target.closest('[data-action]');
            if (!t) return;
            const action = t.getAttribute('data-action');
            if (action === 'ap-rec-start-audio') this._afterPracticeStartAudioRecording(analysis);
            else if (action === 'ap-rec-start-midi') this._afterPracticeStartMidiRecording(analysis);
            else if (action === 'ap-rec-stop') this._afterPracticeStopRecording(analysis);
        };
    },

    async _afterPracticeStartAudioRecording(analysis) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                },
            });
            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                ? 'audio/webm;codecs=opus'
                : 'audio/webm';
            const mediaRecorder = new MediaRecorder(stream, { mimeType });
            const chunks = [];
            mediaRecorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
            mediaRecorder.onstop = async () => {
                const rec = this._afterPracticeRec;
                if (!rec) return;
                const blob = new Blob(chunks, { type: mediaRecorder.mimeType || mimeType });
                const durationMs = Date.now() - rec.startTime;
                rec.stream?.getTracks().forEach(t => t.stop());
                clearInterval(rec.timerInterval);
                this._afterPracticeRec = null;

                const ok = await saveAfterPracticeTake(
                    this._afterPracticeKey(analysis),
                    blob,
                    { duration: durationMs / 1000 },
                );
                if (!ok) {
                    this.showNotification?.('No se pudo guardar la toma B.', 'error');
                }
                this._renderAfterPracticeRecording(analysis);
                await this._renderAbTakes(analysis);
            };

            this._afterPracticeRec = { mediaRecorder, stream, chunks, startTime: Date.now(), timerInterval: null };
            mediaRecorder.start();
            this._startAfterPracticeTimer();
            this._renderAfterPracticeRecording(analysis);
        } catch (err) {
            console.error('[afterpractice] no se pudo iniciar audio:', err);
            this.showNotification?.('No se pudo acceder al micrófono. Revisá los permisos.', 'error');
            this._afterPracticeRec = null;
            this._renderAfterPracticeRecording(analysis);
        }
    },

    async _afterPracticeStartMidiRecording(analysis) {
        try {
            if (!this._afterPracticeMidiRec) {
                this._afterPracticeMidiRec = new MidiRecorder();
            }
            const midiRec = this._afterPracticeMidiRec;
            if (!midiRec.access) await midiRec.requestAccess();
            midiRec.startRecording();
            midiRec.startTime = Date.now();
            midiRec.timerInterval = null;
            this._startAfterPracticeTimer();
            this._renderAfterPracticeRecording(analysis);
        } catch (err) {
            console.error('[afterpractice] no se pudo iniciar MIDI:', err);
            this.showNotification?.('No se pudo iniciar la grabación MIDI. Verificá que el teclado esté conectado.', 'error');
            this._afterPracticeMidiRec = null;
            this._renderAfterPracticeRecording(analysis);
        }
    },

    _startAfterPracticeTimer() {
        // Refresca solo el nodo del cronómetro para no reconstruir DOM.
        const tick = () => {
            const timerEl = document.querySelector('[data-role="ap-timer"]');
            if (!timerEl) return;
            const audioStart = this._afterPracticeRec?.startTime;
            const midiStart = this._afterPracticeMidiRec?.isRecording ? this._afterPracticeMidiRec.startTime : null;
            const startTime = audioStart || midiStart;
            if (!startTime) return;
            timerEl.textContent = this._afterPracticeFormatTimer(Date.now() - startTime);
        };
        const interval = setInterval(tick, 500);
        if (this._afterPracticeRec) this._afterPracticeRec.timerInterval = interval;
        if (this._afterPracticeMidiRec) this._afterPracticeMidiRec.timerInterval = interval;
    },

    async _afterPracticeStopRecording(analysis) {
        // Audio: delegamos al onstop del MediaRecorder (guarda y re-renderea).
        if (this._afterPracticeRec?.mediaRecorder) {
            try {
                if (this._afterPracticeRec.mediaRecorder.state !== 'inactive') {
                    this._afterPracticeRec.mediaRecorder.stop();
                }
            } catch (err) {
                console.warn('[afterpractice] stop audio falló:', err);
            }
            return;
        }
        // MIDI: aquí sí hacemos el guardado inline porque MidiRecorder.stop
        // devuelve el blob directamente en vez de vía callback.
        if (this._afterPracticeMidiRec?.isRecording) {
            try {
                const result = await this._afterPracticeMidiRec.stopRecording();
                clearInterval(this._afterPracticeMidiRec.timerInterval);
                if (result?.blob) {
                    const ok = await saveAfterPracticeTake(
                        this._afterPracticeKey(analysis),
                        result.blob,
                        { duration: result.duration || 0 },
                    );
                    if (!ok) this.showNotification?.('No se pudo guardar la toma B.', 'error');
                } else {
                    this.showNotification?.('No se detectaron notas MIDI en la toma B.', 'warning');
                }
                this._renderAfterPracticeRecording(analysis);
                await this._renderAbTakes(analysis);
            } catch (err) {
                console.error('[afterpractice] stop midi falló:', err);
                this.showNotification?.('No se pudo detener la grabación MIDI.', 'error');
            }
        }
    },

    async _afterPracticeDiscardTake(analysis) {
        await deleteAfterPracticeTake(this._afterPracticeKey(analysis));
        this._destroyAbTakes();
        this._renderAfterPracticeRecording(analysis);
        await this._renderAbTakes(analysis);
    },

    // ═════════════════════════════════════════════════════════════════
    // Comparación A/B — dos paneles con players intercambiables.
    // Cada panel se monta como audio (WaveSurfer) o como MIDI
    // (MidiPianoRoll) según el tipo del blob. Ambos exponen la misma
    // interfaz mínima vía adapter (_buildAbPlayer): play, pause, isPlaying,
    // seekToStart, onFinish, destroy.
    // ═════════════════════════════════════════════════════════════════
    _ab: null,

    _destroyAbTakes() {
        if (!this._ab) return;
        try { this._ab.playerA?.destroy(); } catch {}
        try { this._ab.playerB?.destroy(); } catch {}
        if (this._ab.urlA) URL.revokeObjectURL(this._ab.urlA);
        if (this._ab.urlB) URL.revokeObjectURL(this._ab.urlB);
        this._ab = null;
    },

    // Monta un player en el container para el blob dado. Devuelve el adapter
    // o null si no se pudo. Para MIDI usamos midiBlobToAnalysis para extraer
    // las notas y luego un MidiPianoRoll compacto.
    async _buildAbPlayer(container, blob, progressColor) {
        if (!container || !(blob instanceof Blob)) return null;
        container.innerHTML = '';

        if (this._isMidiBlob(blob)) {
            try {
                const analysis = await midiBlobToAnalysis(blob);
                const notes = Array.isArray(analysis?.midiNotes) ? analysis.midiNotes : [];
                const duration = Number(analysis?.duration) || 0;
                const roll = new MidiPianoRoll(container, { notes, duration, height: 90 });
                let objUrl = null;
                return {
                    kind: 'midi',
                    inst: roll,
                    objUrl,
                    play: () => roll.play(),
                    pause: () => roll.pause(),
                    isPlaying: () => !!roll.isPlaying,
                    seekToStart: () => { try { roll.seek(0); } catch {} },
                    onFinish: (cb) => roll.on('finish', cb),
                    destroy: () => { try { roll.destroy(); } catch {} },
                };
            } catch (err) {
                console.warn('[ab] no se pudo montar piano-roll MIDI:', err);
                container.innerHTML = '<p class="ab-take__placeholder">No se pudo cargar la toma MIDI.</p>';
                return null;
            }
        }

        try {
            const url = URL.createObjectURL(blob);
            const ws = WaveSurfer.create({
                container,
                waveColor: 'rgba(255, 255, 255, 0.2)',
                progressColor: progressColor || 'rgba(255, 255, 255, 0.55)',
                cursorColor: 'rgba(255, 255, 255, 0.35)',
                height: 68,
                barWidth: 2,
                barGap: 1,
                barRadius: 1,
                normalize: true,
            });
            ws.load(url);
            return {
                kind: 'audio',
                inst: ws,
                objUrl: url,
                play: () => ws.play(),
                pause: () => ws.pause(),
                isPlaying: () => !!ws.isPlaying?.(),
                seekToStart: () => { try { ws.seekTo(0); } catch {} },
                onFinish: (cb) => ws.on('finish', cb),
                destroy: () => { try { ws.destroy(); } catch {} },
            };
        } catch (err) {
            console.error('[ab] no se pudo montar WaveSurfer:', err);
            container.innerHTML = '<p class="ab-take__placeholder">No se pudo cargar la toma de audio.</p>';
            return null;
        }
    },

    async _renderAbTakes(analysis) {
        const section = document.getElementById('analysis-ab-section');
        if (!section) return;

        this._destroyAbTakes();

        const take = await getAfterPracticeTake(this._afterPracticeKey(analysis));
        const takeBlob = take?.blob;
        const takeAblob = this.currentAnalysisAudioBlob;
        const hasB = takeBlob instanceof Blob;
        const hasA = takeAblob instanceof Blob;

        // Sin toma B el paso 07 queda oculto (aún no hay nada que comparar).
        // Si hay B pero no A, mostramos igual el paso con solo B para que se
        // pueda escuchar la toma post-experimento.
        if (!hasB) {
            section.classList.add('hidden');
            return;
        }

        section.classList.remove('hidden');

        const containerA = document.getElementById('ab-wave-a');
        const containerB = document.getElementById('ab-wave-b');
        const paneA = section.querySelector('.ab-take[data-take="a"]');
        const paneB = section.querySelector('.ab-take[data-take="b"]');
        const btnA = section.querySelector('[data-action="ab-play-a"]');
        const btnB = section.querySelector('[data-action="ab-play-b"]');
        const btnAlt = section.querySelector('[data-action="ab-alternate"]');
        if (!containerA || !containerB) return;

        // Captions dinámicas según lo que haya de cada lado.
        const captionA = paneA?.querySelector('.ab-take__caption');
        const captionB = paneB?.querySelector('.ab-take__caption');
        if (captionA) {
            captionA.textContent = hasA
                ? (this._isMidiBlob(takeAblob) ? 'Grabación original (MIDI)' : 'Grabación original del análisis')
                : 'Toma original no disponible';
        }
        if (captionB) {
            captionB.textContent = this._isMidiBlob(takeBlob)
                ? 'Toma post-experimento (MIDI)'
                : 'Toma post-experimento';
        }

        // Panel A: si no hay A, mostramos placeholder y ocultamos el botón play.
        let playerA = null;
        if (hasA) {
            playerA = await this._buildAbPlayer(
                containerA, takeAblob,
                'rgba(78, 196, 255, 0.85)',
            );
            btnA?.removeAttribute('hidden');
        } else {
            containerA.innerHTML = '<p class="ab-take__placeholder">No hay grabación original guardada para este análisis.</p>';
            btnA?.setAttribute('hidden', '');
        }

        // Panel B: siempre debería tener contenido si hasB.
        const playerB = await this._buildAbPlayer(
            containerB, takeBlob,
            'rgba(169, 112, 255, 0.85)',
        );

        // El botón "escuchar A → B" solo tiene sentido si ambos players existen.
        if (!playerA || !playerB) {
            btnAlt?.setAttribute('hidden', '');
        } else {
            btnAlt?.removeAttribute('hidden');
        }

        this._ab = {
            playerA,
            playerB,
            urlA: playerA?.objUrl || null,
            urlB: playerB?.objUrl || null,
            mode: 'idle',
        };

        // Handlers unificados sobre el adapter — mismo código sirve para audio
        // y MIDI.
        const setPlayingUI = (which) => {
            [btnA, btnB].forEach(b => b?.classList.remove('is-playing'));
            if (which === 'a') btnA?.classList.add('is-playing');
            if (which === 'b') btnB?.classList.add('is-playing');
        };
        const clearAltUI = () => btnAlt?.classList.remove('is-active');
        const stopBoth = () => {
            try { playerA?.pause(); } catch {}
            try { playerB?.pause(); } catch {}
            setPlayingUI(null);
            clearAltUI();
            if (this._ab) this._ab.mode = 'idle';
        };

        playerA?.onFinish(() => {
            if (this._ab?.mode === 'alt-a-then-b' && playerB) {
                this._ab.mode = 'alt-b';
                playerB.seekToStart();
                playerB.play();
                setPlayingUI('b');
            } else {
                setPlayingUI(null);
                if (this._ab) this._ab.mode = 'idle';
            }
        });
        playerB?.onFinish(() => {
            setPlayingUI(null);
            clearAltUI();
            if (this._ab) this._ab.mode = 'idle';
        });

        section.onclick = (ev) => {
            const t = ev.target.closest('[data-action]');
            if (!t) return;
            const action = t.getAttribute('data-action');
            if (action === 'ab-play-a') {
                if (!playerA) return;
                if (playerA.isPlaying()) { stopBoth(); return; }
                try { playerB?.pause(); } catch {}
                clearAltUI();
                this._ab.mode = 'a';
                playerA.play();
                setPlayingUI('a');
            } else if (action === 'ab-play-b') {
                if (!playerB) return;
                if (playerB.isPlaying()) { stopBoth(); return; }
                try { playerA?.pause(); } catch {}
                clearAltUI();
                this._ab.mode = 'b';
                playerB.play();
                setPlayingUI('b');
            } else if (action === 'ab-alternate') {
                if (!playerA || !playerB) return;
                if (this._ab?.mode?.startsWith('alt')) { stopBoth(); return; }
                try { playerB.pause(); } catch {}
                playerA.seekToStart();
                playerB.seekToStart();
                this._ab.mode = 'alt-a-then-b';
                playerA.play();
                setPlayingUI('a');
                btnAlt?.classList.add('is-active');
            } else if (action === 'ab-discard') {
                stopBoth();
                this._afterPracticeDiscardTake(analysis);
            }
        };
    },

    // "Tu oído vs los datos" — Fase A SRL. Aparece SOLO si vino autoevaluación
    // previa y el modelo llenó beliefVsDetection (REGLA 10). Si el usuario saltó
    // el modal o el modelo no llenó el campo, la sección queda oculta.
    _renderBeliefVsDetection(text) {
        const section = document.getElementById('analysis-belief-section');
        const el = document.getElementById('analysis-belief-text');
        if (!section || !el) return;
        const t = String(text || '').trim();
        if (!t) {
            section.classList.add('hidden');
            el.textContent = '';
            return;
        }
        el.textContent = t;
        section.classList.remove('hidden');
    },

    // Pregunta metacognitiva final — Fase A SRL (REGLA 11). Es lo último que
    // ve el pianista; provoca reflexión, no cierra el análisis.
    _renderMetacognitiveQuestion(text) {
        const section = document.getElementById('analysis-metaq-section');
        const el = document.getElementById('analysis-metaq-text');
        if (!section || !el) return;
        const t = String(text || '').trim();
        if (!t) {
            section.classList.add('hidden');
            el.textContent = '';
            return;
        }
        el.textContent = t;
        section.classList.remove('hidden');
    },

    // "Tu principal foco" — 1 sola línea destacada. Formulada como oportunidad
    // por REGLA 9 (no diagnóstico). Oculta si viene vacío del LLM.
    _renderPrimaryFocus(text) {
        const section = document.getElementById('analysis-primary-focus-section');
        const el = document.getElementById('analysis-primary-focus-text');
        if (!section || !el) return;
        const t = String(text || '').trim();
        if (!t) {
            section.classList.add('hidden');
            el.textContent = '';
            return;
        }
        el.textContent = t;
        section.classList.remove('hidden');
    },

    // Ejercicio de esta semana — nuevo formato structured (steps + checkQuestion)
    // con back-compat total a description prosa (respuestas históricas).
    _renderPracticeExercise(exercise) {
        const el = document.getElementById('practice-suggestions');
        if (!el) return;
        if (!exercise || typeof exercise !== 'object') {
            el.innerHTML = '<p class="no-data">Sin ejercicio recomendado.</p>';
            return;
        }

        const title = String(exercise.title || '').trim();
        const dur = Number(exercise.durationMin);
        const durationBadge = Number.isFinite(dur) && dur > 0
            ? `<span class="suggestion-duration"><i class="fas fa-clock"></i> ${Math.round(dur)} min</span>`
            : '';

        const stepsArr = Array.isArray(exercise.steps)
            ? exercise.steps.filter(s => typeof s === 'string' && s.trim())
            : [];
        const checkQ = String(exercise.checkQuestion || '').trim();
        const desc = String(exercise.description || '').trim();

        // Preferimos el formato nuevo (steps + checkQuestion) si vinieron; si
        // no, caemos a la prosa description del schema histórico.
        let body;
        if (stepsArr.length) {
            const stepsHtml = stepsArr.slice(0, 4)
                .map(s => `<li>${escapeHtml(s)}</li>`)
                .join('');
            const checkHtml = checkQ
                ? `<div class="exercise-check">
                       <span class="exercise-check__label">Qué comprobar</span>
                       <p class="exercise-check__question">${escapeHtml(checkQ)}</p>
                   </div>`
                : '';
            body = `
                <div class="exercise-steps">
                    <span class="exercise-steps__label">Qué hacer</span>
                    <ol class="exercise-steps__list">${stepsHtml}</ol>
                </div>
                ${checkHtml}
            `;
        } else if (desc) {
            // Back-compat: prosa description del schema viejo. Limpiar bullets
            // sueltos que el LLM haya escapado dentro del string.
            const cleaned = desc.split(/\r?\n/)
                .map(l => l.replace(/^\s*(?:[-*•·▪●]|\d+[.)])\s+/, '').trim())
                .filter(Boolean)
                .join(' ');
            body = `<div class="suggestion-description">${escapeHtml(cleaned)}</div>`;
        } else {
            el.innerHTML = '<p class="no-data">Sin ejercicio recomendado.</p>';
            return;
        }

        el.innerHTML = `
            <div class="suggestion-card">
                <div class="suggestion-title">
                    <i class="fas fa-star"></i>
                    ${escapeHtml(title)}
                    ${durationBadge}
                </div>
                ${body}
            </div>
        `;
    },

    // Render de la sección "Observaciones estructuradas" — un card por cada
    // observación del LLM, con las tres capas explícitas (dato/interpretación/
    // recomendación). Refuerza visualmente la REGLA 7 del prompt: el pianista
    // ve que la recomendación pasó por una interpretación tentativa, no un
    // diagnóstico directo desde un número.
    _renderLayeredObservations(observations) {
        const section = document.getElementById('analysis-observations-section');
        const list = document.getElementById('analysis-observations-list');
        if (!section || !list) return;

        const items = Array.isArray(observations) ? observations : [];
        if (!items.length) {
            section.classList.add('hidden');
            list.innerHTML = '';
            return;
        }

        const confidenceLabel = { high: 'alta', medium: 'media', low: 'baja' };
        // Rejections previas del usuario — se marcan visualmente y el botón
        // cambia a "rechazada". No dejamos que las oculten (feedback visual sano),
        // pero se guardan y el próximo prompt las evita (ver AIAnalysisEngine).
        const rejected = this.getObservationRejections();
        list.innerHTML = items.map((o, idx) => {
            const conf = ['high', 'medium', 'low'].includes(o.confidence) ? o.confidence : 'medium';
            const hash = this._observationHash(o);
            const isRejected = rejected.some(r => r.hash === hash);
            return `
                <article class="layered-obs layered-obs--${conf} ${isRejected ? 'is-rejected' : ''}" data-obs-idx="${idx}" data-obs-hash="${escapeHtml(hash)}">
                    <header class="layered-obs__header">
                        <span class="layered-obs__confidence">confianza: ${confidenceLabel[conf]}</span>
                        <button type="button" class="layered-obs__reject-btn" data-action="reject-obs" data-obs-idx="${idx}" title="${isRejected ? 'Ya rechazaste esta observación' : 'Marcar como no aplica'}" aria-label="Marcar observación como no aplica">
                            ${isRejected ? '<i class="fas fa-ban" aria-hidden="true"></i> rechazada' : '<i class="fas fa-circle-xmark" aria-hidden="true"></i> no aplica'}
                        </button>
                    </header>
                    <div class="layered-obs__row layered-obs__row--fact">
                        <span class="layered-obs__tag">Dato</span>
                        <p class="layered-obs__text">${escapeHtml(String(o.fact || ''))}</p>
                    </div>
                    <div class="layered-obs__row layered-obs__row--interp">
                        <span class="layered-obs__tag">Interpretación</span>
                        <p class="layered-obs__text">${escapeHtml(String(o.interpretation || ''))}</p>
                    </div>
                    <div class="layered-obs__row layered-obs__row--rec">
                        <span class="layered-obs__tag">Recomendación</span>
                        <p class="layered-obs__text">${escapeHtml(String(o.recommendation || ''))}</p>
                    </div>
                    <div class="layered-obs__reject-form hidden" data-obs-idx="${idx}">
                        <label for="obs-reject-reason-${idx}">¿Por qué no aplica? (opcional — ayuda a que no se repita)</label>
                        <textarea id="obs-reject-reason-${idx}" rows="2" maxlength="200" placeholder="Ej: mi piano tiene el registro grave apagado, no es decisión mía"></textarea>
                        <div class="layered-obs__reject-actions">
                            <button type="button" class="layered-obs__reject-cancel" data-action="reject-obs-cancel" data-obs-idx="${idx}">Cancelar</button>
                            <button type="button" class="layered-obs__reject-confirm" data-action="reject-obs-confirm" data-obs-idx="${idx}">Confirmar rechazo</button>
                        </div>
                    </div>
                </article>
            `;
        }).join('');

        // Delegación: un solo listener por render (idempotente porque reemplazamos innerHTML entero).
        list.onclick = (ev) => {
            const btn = ev.target.closest('[data-action]');
            if (!btn) return;
            const action = btn.getAttribute('data-action');
            const idx = Number(btn.getAttribute('data-obs-idx'));
            const article = list.querySelector(`article[data-obs-idx="${idx}"]`);
            if (!article) return;
            if (action === 'reject-obs') {
                if (article.classList.contains('is-rejected')) return;
                const form = article.querySelector('.layered-obs__reject-form');
                form?.classList.toggle('hidden');
                setTimeout(() => form?.querySelector('textarea')?.focus(), 40);
            } else if (action === 'reject-obs-cancel') {
                article.querySelector('.layered-obs__reject-form')?.classList.add('hidden');
            } else if (action === 'reject-obs-confirm') {
                const reason = article.querySelector('textarea')?.value?.trim() || '';
                const hash = article.getAttribute('data-obs-hash') || '';
                const obsData = items[idx] || {};
                this.recordObservationRejection({
                    hash,
                    fact: String(obsData.fact || '').slice(0, 200),
                    interpretation: String(obsData.interpretation || '').slice(0, 200),
                    reason: reason.slice(0, 200),
                    timestamp: Date.now(),
                });
                article.classList.add('is-rejected');
                article.querySelector('.layered-obs__reject-form')?.classList.add('hidden');
                const rejectBtn = article.querySelector('[data-action="reject-obs"]');
                if (rejectBtn) {
                    rejectBtn.innerHTML = '<i class="fas fa-ban" aria-hidden="true"></i> rechazada';
                    rejectBtn.title = 'Ya rechazaste esta observación';
                }
                this.showNotification('Rechazo guardado — no volverá a aparecer', 'success');
            }
        };

        section.classList.remove('hidden');
    },

    // Hash simple para identificar una observation entre sesiones. Toma el
    // primer chunk del fact + interpretation, normaliza (lowercase + trim),
    // suficiente para dedup exacto y "casi-exacto" del mismo tema (el modelo
    // varía redacción pero mantiene el punto central).
    _observationHash(o) {
        const raw = `${String(o?.fact || '')}::${String(o?.interpretation || '')}`
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 160);
        // Hash djb2 corto para llave estable (32 chars hex).
        let hash = 5381;
        for (let i = 0; i < raw.length; i++) {
            hash = ((hash << 5) + hash) + raw.charCodeAt(i);
            hash = hash & 0xffffffff;
        }
        return `${(hash >>> 0).toString(16)}_${raw.slice(0, 40).replace(/[^a-z0-9]+/g, '')}`;
    },

    // Storage de rechazos — por usuario. Cap 40 para que no crezca infinito;
    // los más viejos se descartan cuando se pasa (FIFO), así el modelo no
    // recibe una biblioteca gigante en cada prompt.
    getObservationRejections() {
        const arr = this.safeGetLocalStorage(this.userKey('pianostudy-obs-rejections'), []);
        return Array.isArray(arr) ? arr : [];
    },

    recordObservationRejection(entry) {
        if (!entry || !entry.hash) return;
        let list = this.getObservationRejections();
        // Dedup por hash — si ya existe, actualizamos motivo/timestamp.
        list = list.filter(r => r.hash !== entry.hash);
        list.unshift(entry);
        if (list.length > 40) list = list.slice(0, 40);
        this.safeSetLocalStorage(this.userKey('pianostudy-obs-rejections'), list);
    },

    // Panel "IAs y motores usados" — colapsable, plegado por defecto (per user
    // request), con conteo visible en el summary. Se renderiza a partir de
    // los datos que ya guardamos en currentAnalysis (providersUsed/Failed,
    // aiAnalysis.source, auditoryLayer.usage, reliability).
    _renderEnginesPanel() {
        const panel = document.getElementById('analysis-engines-details');
        if (!panel || !this.currentAnalysis) return;
        const { audioAnalysis = {}, aiAnalysis = {}, auditoryLayer, reliability, geminiRequested } = this.currentAnalysis;

        const providersUsed = Array.isArray(audioAnalysis.providersUsed) ? audioAnalysis.providersUsed : [];
        const providersFailed = Array.isArray(audioAnalysis.providersFailed) ? audioAnalysis.providersFailed : [];
        const source = String(aiAnalysis.source || '');
        const midiCount = Array.isArray(audioAnalysis.midiNotes) ? audioAnalysis.midiNotes.length : 0;

        // Motor de análisis local — Essentia por subalgoritmo + Basic Pitch.
        const essentiaOk = providersUsed.includes('essentia-init')
            && ['tempo', 'key', 'loudness'].every(x => providersUsed.includes(x));
        const essentiaPartial = providersUsed.includes('essentia-init') && !essentiaOk;
        let essentiaLabel;
        if (essentiaOk) essentiaLabel = { icon: '✓', cls: 'ok', text: 'Essentia (tempo, tonalidad, dinámica)' };
        else if (essentiaPartial) essentiaLabel = { icon: '⚠', cls: 'warn', text: 'Essentia (parcial, algún subalgoritmo falló)' };
        else essentiaLabel = { icon: '✗', cls: 'fail', text: 'Essentia no disponible — se usó fallback casero' };

        const basicPitchUsed = providersUsed.some(p => String(p).startsWith('basic-pitch'));
        const basicPitchFailed = providersFailed.some(p => String(p).includes('basic-pitch'));
        let basicPitchLabel;
        if (basicPitchUsed) basicPitchLabel = { icon: '✓', cls: 'ok', text: `Basic Pitch (${midiCount} notas transcritas)` };
        else if (basicPitchFailed) basicPitchLabel = { icon: '✗', cls: 'fail', text: 'Basic Pitch no devolvió notas' };
        else basicPitchLabel = { icon: '—', cls: 'warn', text: 'Basic Pitch no se ejecutó' };

        // LLM que sintetizó el feedback — se deriva del source del aiAnalysis.
        // Nombres de modelo alineados con los defaults reales de cada proxy
        // (ver groq-proxy/index.ts, gemini-proxy/index.ts, openrouter-proxy/index.ts).
        const llmMap = {
            'ai-groq':             { name: 'Groq', model: 'compound', cls: 'ok' },
            'ai-groq+audio':       { name: 'Groq', model: 'compound', cls: 'ok' },
            'ai-gemini':           { name: 'Gemini', model: 'gemini-flash-latest', cls: 'ok' },
            'ai-gemini+audio':     { name: 'Gemini', model: 'gemini-flash-latest', cls: 'ok' },
            'ai-openrouter':       { name: 'OpenRouter (free)', model: 'dots-studio/dots-3-note-preview:free', cls: 'ok' },
            'ai-openrouter+audio': { name: 'OpenRouter (free)', model: 'dots-studio/dots-3-note-preview:free + escucha Gemini', cls: 'ok' },
            'fallback-parse-error':    { name: 'Fallback', model: 'JSON inválido del LLM', cls: 'fail' },
            'fallback-schema-invalid': { name: 'Fallback', model: 'schema inválido del LLM', cls: 'fail' },
            'fallback-network':        { name: 'Fallback', model: 'ningún LLM respondió', cls: 'fail' },
        };
        const llm = llmMap[source] || { name: 'Desconocido', model: source, cls: 'warn' };
        const llmIcon = llm.cls === 'ok' ? '✓' : (llm.cls === 'warn' ? '⚠' : '✗');

        // Escucha profunda con Gemini — 4 estados posibles: apagado por toggle,
        // deshabilitado por config, corrió OK, corrió y falló.
        let audioLabel;
        if (!geminiRequested) {
            audioLabel = { icon: '—', cls: 'off', text: 'Escucha profunda apagada (toggle OFF)' };
        } else if (!GEMINI_AUDIO_CONFIG.enabled) {
            audioLabel = { icon: '—', cls: 'off', text: 'Escucha profunda deshabilitada por configuración' };
        } else if (auditoryLayer?.usage) {
            const u = auditoryLayer.usage;
            audioLabel = {
                icon: '✓', cls: 'ok',
                text: `Gemini ${GEMINI_AUDIO_CONFIG.modelName} — ${u.segments_sent} clip(s), ${u.audio_seconds_sent}s enviados`,
            };
        } else {
            audioLabel = { icon: '✗', cls: 'fail', text: 'Escucha profunda no disponible en este análisis' };
        }

        // Confiabilidad por señal.
        const relRows = [];
        if (reliability?.tempo) {
            const t = reliability.tempo;
            const val = t.value ? `${t.value} BPM` : '—';
            relRows.push(`<li class="engines-rel engines-rel--${t.reliability}"><span class="engines-rel__label">tempo</span> <span class="engines-rel__tier">${t.reliability}</span> <span class="engines-rel__detail">${escapeHtml(val)} · conf ${t.confidence}</span></li>`);
        }
        if (reliability?.key) {
            const k = reliability.key;
            const val = k.value ? `${k.value}${k.mode ? ' ' + k.mode : ''}` : 'no determinada';
            relRows.push(`<li class="engines-rel engines-rel--${k.reliability}"><span class="engines-rel__label">tonalidad</span> <span class="engines-rel__tier">${k.reliability}</span> <span class="engines-rel__detail">${escapeHtml(val)} · conf ${k.confidence}</span></li>`);
        }
        if (reliability?.transcription) {
            const tr = reliability.transcription;
            relRows.push(`<li class="engines-rel engines-rel--${tr.level}"><span class="engines-rel__label">transcripción</span> <span class="engines-rel__tier">${tr.level}</span> <span class="engines-rel__detail">score ${tr.score}${tr.available ? '' : ' · no disponible'}</span></li>`);
        }

        // Conteo para el summary.
        const chips = [essentiaLabel, basicPitchLabel, { icon: llmIcon, cls: llm.cls }, audioLabel];
        const okCount = chips.filter(c => c.cls === 'ok').length;
        const warnCount = chips.filter(c => c.cls === 'warn' || c.cls === 'off').length;
        const failCount = chips.filter(c => c.cls === 'fail').length;
        const quality = reliability?.overall_data_quality || null;

        const summary = `
            <span class="engines-summary__title"><i class="fas fa-microchip"></i> IAs y motores usados</span>
            <span class="engines-summary__counts">
                ${okCount ? `<span class="engines-count engines-count--ok">${okCount} ✓</span>` : ''}
                ${warnCount ? `<span class="engines-count engines-count--warn">${warnCount} ⚠</span>` : ''}
                ${failCount ? `<span class="engines-count engines-count--fail">${failCount} ✗</span>` : ''}
                ${quality ? `<span class="engines-count engines-count--quality engines-count--quality-${quality}">calidad: ${quality}</span>` : ''}
            </span>
        `;

        const body = `
            <ul class="engines-list">
                <li class="engines-line"><span class="engines-line__label">Análisis local</span>
                    <span class="engines-chip engines-chip--${essentiaLabel.cls}">${essentiaLabel.icon} ${escapeHtml(essentiaLabel.text)}</span>
                    <span class="engines-chip engines-chip--${basicPitchLabel.cls}">${basicPitchLabel.icon} ${escapeHtml(basicPitchLabel.text)}</span>
                </li>
                <li class="engines-line"><span class="engines-line__label">LLM (síntesis del feedback)</span>
                    <span class="engines-chip engines-chip--${llm.cls}">${llmIcon} ${escapeHtml(llm.name)}${llm.model ? ' — ' + escapeHtml(llm.model) : ''}</span>
                </li>
                <li class="engines-line"><span class="engines-line__label">Escucha profunda (Gemini)</span>
                    <span class="engines-chip engines-chip--${audioLabel.cls}">${audioLabel.icon} ${escapeHtml(audioLabel.text)}</span>
                </li>
                ${relRows.length ? `<li class="engines-line engines-line--rel"><span class="engines-line__label">Confiabilidad por señal</span><ul class="engines-rel-list">${relRows.join('')}</ul></li>` : ''}
            </ul>
        `;

        const summaryEl = panel.querySelector('summary');
        const bodyEl = panel.querySelector('.engines-panel-body');
        if (summaryEl) summaryEl.innerHTML = summary;
        if (bodyEl) bodyEl.innerHTML = body;
    },

    loadRecordingsForAnalysis() {
        const select = document.getElementById('analysis-recording-select');
        if (!select) return;

        select.innerHTML = '<option value="">Selecciona una grabación...</option>';

        if (this.currentRecording instanceof Blob) {
            const opt = document.createElement('option');
            opt.value = 'current';
            opt.textContent = `Grabación actual (${this.formatDuration(this.currentRecordingDuration || 0)})`;
            select.appendChild(opt);
        }

        (this.tempRecordings || []).forEach((rec) => {
            if (!rec) return;
            if (!(rec.blob instanceof Blob) && !rec.filePath) return;
            const opt = document.createElement('option');
            opt.value = String(rec.id);
            opt.textContent = `${rec.name} (${this.formatDuration(rec.duration || 0)})`;
            select.appendChild(opt);
        });
    },

    async getRecordingBlobForAnalysis(selectionValue) {
        if (selectionValue === 'current') {
            return this.currentRecording instanceof Blob ? this.currentRecording : null;
        }
        const rec = (this.tempRecordings || []).find(r => String(r.id) === String(selectionValue));
        if (!rec) return null;
        if (rec.blob instanceof Blob) return rec.blob;
        if (rec.filePath) {
            const { blob, error } = await downloadRecordingBlob(rec.filePath);
            if (error || !blob) {
                console.error('downloadRecordingBlob error:', error);
                return null;
            }
            rec.blob = blob;
            return blob;
        }
        return null;
    },

    // Fase B3 SRL: heurística para saber si un objetivo escrito por el usuario
    // es "vago" y merece la miniconsulta de delimitación. Vago = corto Y sin
    // marcadores de especificidad (BPM, compás, tune concreto, mano).
    _objectiveIsVague(text) {
        const t = String(text || '').trim();
        if (t.length < 4) return false;         // demasiado corto — está tipeando aún
        if (t.length > 90) return false;        // ya es específico si dice tanto
        const specific = /\b\d+\s*(bpm|compás|compases|comp\.|tempo)|\bcompás\s*\d+|\ba\s*\d+\s*bpm|mano\s*(derecha|izquierda)|(m\.?d\.?|m\.?i\.?)\b/i;
        if (specific.test(t)) return false;
        return true;
    },

    // Fase B3 SRL: dispara la miniconsulta a Groq/Gemini si el objetivo es vago.
    // Debouncable — el llamador maneja el timer. Cachea el último objetivo
    // consultado para no repetir requests idénticos mientras el usuario tipea.
    async maybeDelimitObjective(rawText) {
        const container = document.getElementById('objective-delimit-container');
        const chipsEl = document.getElementById('objective-delimit-chips');
        const statusEl = document.getElementById('objective-delimit-status');
        if (!container || !chipsEl || !statusEl) return;

        const text = String(rawText || '').trim();
        if (!this._objectiveIsVague(text)) {
            container.classList.add('hidden');
            chipsEl.innerHTML = '';
            this._lastDelimitedObjective = null;
            return;
        }
        if (text === this._lastDelimitedObjective) return;
        this._lastDelimitedObjective = text;

        // Estado "buscando" — le da feedback al usuario mientras espera Groq.
        container.classList.remove('hidden');
        chipsEl.innerHTML = '';
        statusEl.textContent = '🔎 Buscando preguntas para afinar el objetivo…';
        statusEl.className = 'objective-delimit__label objective-delimit__status--loading';

        try {
            const aiEngine = this.aiEngine || new (await import('../modules/AIAnalysisEngine.js')).AIAnalysisEngine();
            if (!this.aiEngine) this.aiEngine = aiEngine;
            const style = (document.getElementById('analysis-style')?.value || '').trim();
            const level = (document.getElementById('analysis-level')?.value || '').trim();
            const questions = await aiEngine.delimitObjective(text, { style, level });
            if (!Array.isArray(questions) || questions.length === 0) {
                // Silencio en caso de vacío: mejor no mostrar chips huecas.
                container.classList.add('hidden');
                return;
            }
            // Si el usuario mientras tanto cambió el texto y ya no es vago, abortamos.
            const currentText = document.getElementById('analysis-objective')?.value?.trim() || '';
            if (currentText !== text) return;

            statusEl.textContent = '🔎 Para afinar tu objetivo (clickeá una pregunta para agregarla):';
            statusEl.className = 'objective-delimit__label';
            chipsEl.innerHTML = questions.map((q, i) => `
                <button type="button" class="objective-delimit-chip" data-q-idx="${i}">${escapeHtml(q)}</button>
            `).join('');
            chipsEl.onclick = (ev) => {
                const btn = ev.target.closest('[data-q-idx]');
                if (!btn) return;
                const idx = Number(btn.getAttribute('data-q-idx'));
                const question = questions[idx];
                if (!question) return;
                const input = document.getElementById('analysis-objective');
                if (!input) return;
                // Concatena la pregunta al objetivo actual como marca a completar.
                // El usuario tiene que responder inline en el mismo input.
                const current = input.value.trim();
                const separator = current && !current.endsWith('.') && !current.endsWith('—') ? ' — ' : ' ';
                input.value = `${current}${separator}${question}`.slice(0, 140);
                input.focus();
                // Después de responder cambia el texto y disparará blur/input de nuevo.
            };
        } catch (err) {
            console.warn('delimitObjective falló:', err);
            container.classList.add('hidden');
        }
    },

    // Fase A del reposicionamiento SRL: modal previo al análisis que le pide
    // al pianista una predicción (rating 1-5, área más floja, hipótesis libre).
    // Todos opcionales; el botón "Saltar por hoy" resuelve con null y el pipeline
    // sigue igual que hoy. Si el pianista completa algo, se pasa a analyzePerformance
    // y el modelo llena la sección beliefVsDetection contrastando lo que dijo el
    // pianista con lo que detectan los datos (REGLA 10 del prompt).
    promptSelfEvaluation() {
        return new Promise((resolve) => {
            const overlay = document.getElementById('self-eval-modal');
            const ratingInput = document.getElementById('self-eval-rating');
            const ratingOut = document.getElementById('self-eval-rating-value');
            const predictionInput = document.getElementById('self-eval-prediction');
            const predictionCount = document.getElementById('self-eval-prediction-count');
            const chips = Array.from(overlay?.querySelectorAll('.self-eval-chip') || []);
            const submitBtn = document.getElementById('self-eval-submit');
            const skipBtn = document.getElementById('self-eval-skip');

            if (!overlay || !ratingInput || !submitBtn || !skipBtn) {
                // Si por alguna razón el modal no está en el DOM, no bloqueamos:
                // seguimos como antes sin autoevaluación.
                resolve(null);
                return;
            }

            // Reset a valores neutros por si abrimos el modal más de una vez en la sesión.
            ratingInput.value = '3';
            if (ratingOut) ratingOut.textContent = '3/5';
            if (predictionInput) predictionInput.value = '';
            if (predictionCount) predictionCount.textContent = '0 / 200';
            chips.forEach(c => {
                c.classList.remove('is-active');
                c.setAttribute('aria-checked', 'false');
            });
            let selectedChip = '';

            const onRatingInput = () => {
                if (ratingOut) ratingOut.textContent = `${ratingInput.value}/5`;
            };
            const onPredictionInput = () => {
                const len = predictionInput?.value?.length || 0;
                if (predictionCount) predictionCount.textContent = `${len} / 200`;
            };
            const onChipClick = (ev) => {
                const btn = ev.currentTarget;
                const val = btn.getAttribute('data-value') || '';
                // Toggle: si el mismo chip está activo, deseleccionar (permite dejarlo en blanco).
                if (selectedChip === val) {
                    selectedChip = '';
                    btn.classList.remove('is-active');
                    btn.setAttribute('aria-checked', 'false');
                    return;
                }
                selectedChip = val;
                chips.forEach(c => {
                    const isActive = c === btn;
                    c.classList.toggle('is-active', isActive);
                    c.setAttribute('aria-checked', isActive ? 'true' : 'false');
                });
            };
            const onKeydown = (ev) => {
                if (ev.key === 'Escape') { cleanup(); resolve(null); }
            };

            const cleanup = () => {
                overlay.classList.add('hidden');
                ratingInput.removeEventListener('input', onRatingInput);
                predictionInput?.removeEventListener('input', onPredictionInput);
                chips.forEach(c => c.removeEventListener('click', onChipClick));
                submitBtn.removeEventListener('click', onSubmit);
                skipBtn.removeEventListener('click', onSkip);
                document.removeEventListener('keydown', onKeydown);
            };

            const onSubmit = () => {
                const rating = Number(ratingInput.value);
                const prediction = (predictionInput?.value || '').trim();
                const result = {
                    rating: Number.isFinite(rating) ? rating : null,
                    weakArea: selectedChip || null,
                    prediction: prediction || null,
                    timestamp: Date.now(),
                };
                // Si el usuario no tocó nada útil (rating neutro y todo vacío),
                // tratamos como "saltar" para no meter ruido al prompt.
                const meaningful = result.weakArea || result.prediction || (Number.isFinite(rating) && rating !== 3);
                cleanup();
                resolve(meaningful ? result : null);
            };
            const onSkip = () => { cleanup(); resolve(null); };

            ratingInput.addEventListener('input', onRatingInput);
            predictionInput?.addEventListener('input', onPredictionInput);
            chips.forEach(c => c.addEventListener('click', onChipClick));
            submitBtn.addEventListener('click', onSubmit);
            skipBtn.addEventListener('click', onSkip);
            document.addEventListener('keydown', onKeydown);

            overlay.classList.remove('hidden');
            setTimeout(() => predictionInput?.focus(), 60);
        });
    },

    async startAnalysis() {
        const select = document.getElementById('analysis-recording-select');
        const selection = String(select?.value || '');
        if (!selection) return;

        const audioBlob = await this.getRecordingBlobForAnalysis(selection);
        if (!audioBlob) {
            this.showNotification('Grabación no encontrada', 'error');
            return;
        }

        // Fase A SRL: pedir autoevaluación previa (opcional).
        // Si el usuario salta, selfEval === null y el análisis funciona igual que antes.
        const selfEval = await this.promptSelfEvaluation();

        const statusEl = document.getElementById('analysis-status');
        const resultsEl = document.getElementById('analysis-results');
        statusEl?.classList.remove('hidden');
        resultsEl?.classList.add('hidden');

        try {
            this.updateAnalysisProgress(15);
            // Detectar si la grabación seleccionada es MIDI (fue subida como .mid).
            // La usamos para saltar Essentia/basic-pitch/Gemini-audio: con MIDI
            // ya tenemos notas exactas y no hay audio que "escuchar".
            // "current" es una opción sintética del dropdown que no vive en
            // tempRecordings, así que ahí caemos al mime type del blob (los
            // blobs generados por MidiRecorder salen con type 'audio/midi').
            const selectedRec = (this.tempRecordings || []).find(r => String(r.id) === String(selection));
            const isMidi = selectedRec?.format === 'midi'
                || (selectedRec?.filePath && String(selectedRec.filePath).endsWith('.mid'))
                || (selection === 'current' && audioBlob?.type === 'audio/midi');

            let audioAnalysis;
            if (isMidi) {
                audioAnalysis = await midiBlobToAnalysis(audioBlob);
            } else {
                await this.audioAnalyzer.init();
                audioAnalysis = await this.audioAnalyzer.analyzeAudio(audioBlob, { enableMidiTranscription: true });
            }
            this.updateAnalysisProgress(40);

            // Contexto declarado por el usuario en la UI de análisis. Todos opcionales;
            // los que no llenó, se omiten del prompt (la IA infiere). Nota: metadata.style
            // dispara STYLE_GUIDANCE si coincide con una key soportada.
            const targetTempoRaw = document.getElementById('analysis-target-tempo')?.value;
            const parsedTargetTempo = Number(targetTempoRaw);
            const metadata = {
                style: (document.getElementById('analysis-style')?.value || '').trim(),
                level: (document.getElementById('analysis-level')?.value || '').trim(),
                objective: (document.getElementById('analysis-objective')?.value || '').trim(),
                targetTempo: Number.isFinite(parsedTargetTempo) && parsedTargetTempo > 0
                    ? parsedTargetTempo
                    : null,
                notes: (document.getElementById('analysis-notes')?.value || '').trim(),
            };

            // ─── Capa de confiabilidad ──────────────────────────────────────
            // Evalúa qué señales del análisis son afirmables antes de llegar
            // al LLM. NO corrige datos; los envuelve con tiers. El prompt
            // (REGLA 6 del systemPrompt) lee este bloque y ajusta qué puede
            // afirmar. Ver assets/js/modules/AnalysisReliability.js.
            const reliability = assessAnalysis(audioAnalysis);
            console.info('[reliability]', reliability);

            // ─── Escucha profunda con Gemini (Fase 4 del plan hybrid) ────────
            // Segunda capa auditiva OPCIONAL. Falla en silencio: si algo se
            // rompe, seguimos con análisis local + Groq como siempre. Respeta
            // el toggle "Escucha profunda (Gemini)" (default ON).
            let auditoryLayer = null;
            const geminiOn = this._isGeminiAudioEnabled();
            // La escucha profunda con Gemini requiere audio real — con MIDI
            // saltamos esta capa entera; las notas exactas ya son mejor input.
            if (GEMINI_AUDIO_CONFIG.enabled && geminiOn && !isMidi) {
                try {
                    const derived = deriveFeatures(audioAnalysis);
                    const segments = selectSegments(audioAnalysis, derived);
                    if (segments.length > 0) {
                        const audioBuffer = await this.getAudioBuffer(audioBlob);
                        const clips = await clipSegments(audioBuffer, segments);
                        if (clips.length > 0) {
                            auditoryLayer = await analyzeAudioClips(clips, metadata);
                            if (auditoryLayer?.usage) {
                                // Log técnico (Fase 12 — observabilidad, sin exponer al usuario).
                                console.info('[gemini-audio] usage', auditoryLayer.usage);
                            }
                        }
                    }
                } catch (err) {
                    console.warn('Escucha profunda (Gemini) falló, sigo sin ella:', err);
                    auditoryLayer = null;
                }
            } else if (!geminiOn) {
                console.info('[gemini-audio] deshabilitado por toggle del usuario');
            }
            this.updateAnalysisProgress(65);

            const aiEngine = this.aiEngine || new AIAnalysisEngine();
            // Memoria del estudiante: agregada desde el histórico local del usuario,
            // sin llamadas extra a la IA. Le da al análisis nuevo continuidad con las
            // sesiones previas — la IA sabe qué le venías comentando y qué ejercicios
            // ya le recomendó, así no repite lo mismo cada vez.
            // Fase B2: incluir las observations que el pianista rechazó explícitamente
            // para que el prompt no las repita (el bloque aparece dentro de
            // CONTEXTO DEL ESTUDIANTE).
            const studentMemory = AIAnalysisEngine.buildStudentMemory(
                this.analysisHistory,
                { rejections: this.getObservationRejections() },
            );

            const aiAnalysis = await aiEngine.analyzePerformance(
                audioAnalysis, metadata, studentMemory,
                auditoryLayer?.observations || null,
                reliability,
                selfEval,
            );
            this.updateAnalysisProgress(100);

            this.currentAnalysis = {
                recordingId: selection,
                recordingName: selection === 'current' ? 'Grabación actual' : `Grabación ${selection}`,
                audioAnalysis,
                aiAnalysis,
                auditoryLayer,
                reliability,
                selfEvaluation: selfEval,
                metadata,
                geminiRequested: geminiOn,
                timestamp: Date.now()
            };
            this.currentAnalysisAudioBlob = audioBlob;

            statusEl?.classList.add('hidden');
            this.displayAnalysisResults();
        } catch (error) {
            console.error('Error during analysis:', error);
            statusEl?.classList.add('hidden');
            this.showNotification('Error al analizar la grabación', 'error');
        }
    },

    updateAnalysisProgress(percent) {
        const progressBar = document.getElementById('analysis-progress');
        if (progressBar) progressBar.style.width = `${percent}%`;
    },

    async getAudioBuffer(blob) {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const arrayBuffer = await blob.arrayBuffer();
        return await audioContext.decodeAudioData(arrayBuffer);
    },

    // Recorrido en modo pestañas: solo el paso activo se muestra, el
    // resto queda oculto por CSS. El rail horizontal de arriba y el pager
    // inferior son los controles de navegación. Sincroniza:
    //   · visibilidad de los ítems del rail según .hidden de cada paso
    //   · paso activo (.is-current en el paso + .is-active en el rail)
    //   · pager "Anterior / N de M / Siguiente"
    //   · scroll horizontal del rail para que el activo quede visible
    // Idempotente: registra listeners una sola vez (guard con
    // _journeyRailInitialized), luego solo refresca.
    _syncJourneyRail() {
        const journey = document.querySelector('.analysis-journey');
        const rail = document.querySelector('.journey-rail');
        const flow = document.querySelector('.analysis-flow');
        const steps = Array.from(document.querySelectorAll('.analysis-flow .flow-step[data-step]'));
        if (!journey || !rail || !flow || !steps.length) return;

        // Pager. Muestra "Paso NN · Título" usando el número semántico del
        // data-step (mismo que la pastilla activa del rail — así no confunden).
        // Se inserta JUSTO DESPUÉS del rail (arriba del contenido) para que
        // los controles Anterior/Siguiente estén siempre visibles cerca del
        // rail, en vez de quedar perdidos abajo del paso activo.
        let pager = journey.querySelector('.journey-pager');
        if (!pager) {
            pager = document.createElement('div');
            pager.className = 'journey-pager';
            pager.innerHTML = `
                <button type="button" class="journey-pager__btn" data-pager="prev" aria-label="Paso anterior">
                    <i class="fas fa-chevron-left"></i><span>Anterior</span>
                </button>
                <span class="journey-pager__indicator" aria-live="polite">
                    <strong data-pager="current">01</strong>
                    <span data-pager="title" class="journey-pager__title"></span>
                </span>
                <button type="button" class="journey-pager__btn" data-pager="next" aria-label="Paso siguiente">
                    <span>Siguiente</span><i class="fas fa-chevron-right"></i>
                </button>
            `;
            // Insertamos el pager justo antes del panel Explorar (si existe)
            // o antes del flow — así el orden final es:
            //   rail → pager → explorar → contenido de los pasos.
            const explore = journey.querySelector('.analysis-explore');
            journey.insertBefore(pager, explore || flow);
        }

        // Paleta del pager por paso (matchea --step-accent / --rail-accent).
        const PAGER_COLORS = {
            '1': '#4ec4ff', '2': '#a970ff', '3': 'var(--accent-orange)',
            '4': '#ffd60a', '5': 'var(--accent-green)', '6': '#38e8b8',
            '7': '#a970ff', '8': '#4ec4ff', '9': '#ff5b8a',
        };

        // Razón por la que un paso puede quedar oculto (los renderers ponen
        // .hidden en la <section> cuando no hay datos). El texto se muestra
        // como tooltip en la pastilla y como mensaje en el pager si el
        // usuario intenta abrir un paso deshabilitado.
        const HIDDEN_REASONS = {
            '1': 'No completaste la autoevaluación previa antes de analizar.',
            '2': 'El análisis no generó evidencia visible.',
            '3': 'El análisis no identificó un hallazgo principal.',
            '4': 'El modelo no propuso una pregunta de reflexión esta vez.',
            '5': 'El análisis no incluyó ejercicio de práctica.',
            '6': 'El paso "después de practicar" está siempre disponible.',
            '7': 'Todavía no grabaste tu toma B (después del experimento).',
            '8': 'El modelo no devolvió observaciones detalladas.',
            '9': 'El modelo no propuso un próximo paso concreto.',
        };

        const visibleSteps = () => steps.filter(s => !s.classList.contains('hidden'));

        const setActive = (stepNum) => {
            const list = visibleSteps();
            if (!list.length) return;
            const target = list.find(s => s.getAttribute('data-step') === String(stepNum)) || list[0];

            steps.forEach(s => s.classList.remove('is-current'));
            target.classList.add('is-current');

            rail.querySelectorAll('.journey-rail__step').forEach(item => {
                item.classList.toggle(
                    'is-active',
                    item.getAttribute('data-rail-step') === target.getAttribute('data-step'),
                );
            });

            const idx = list.indexOf(target);
            const stepNumRaw = target.getAttribute('data-step');
            const cur = pager.querySelector('[data-pager="current"]');
            const ttl = pager.querySelector('[data-pager="title"]');
            const prev = pager.querySelector('[data-pager="prev"]');
            const next = pager.querySelector('[data-pager="next"]');
            // Pintamos "Paso NN" con dos dígitos para que coincida visualmente
            // con las pastillas del rail (01, 02, 03…).
            if (cur) cur.textContent = String(stepNumRaw).padStart(2, '0');
            if (ttl) ttl.textContent = target.querySelector('.flow-step__title')?.textContent?.trim() || '';
            if (prev) prev.disabled = idx <= 0;
            if (next) next.disabled = idx >= list.length - 1;
            // Color del pager tomando el acento del paso activo.
            pager.style.setProperty('--pager-accent', PAGER_COLORS[stepNumRaw] || 'var(--accent-blue)');

            // Centra el ítem activo del rail en pantallas donde no entra todo.
            const activeRailItem = rail.querySelector(
                `.journey-rail__step[data-rail-step="${target.getAttribute('data-step')}"]`,
            );
            activeRailItem?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
        };

        const refresh = () => {
            steps.forEach(s => {
                const num = s.getAttribute('data-step');
                const isHidden = s.classList.contains('hidden');
                const item = rail.querySelector(`.journey-rail__step[data-rail-step="${num}"]`);
                if (!item) return;
                // Todas las pastillas quedan VISIBLES. Las que no tienen datos
                // se marcan como .is-disabled con la razón en tooltip nativo.
                item.classList.toggle('is-disabled', isHidden);
                if (isHidden) {
                    item.setAttribute('aria-disabled', 'true');
                    item.setAttribute('title', HIDDEN_REASONS[num] || 'Sin datos para este paso.');
                    item.dataset.hiddenReason = HIDDEN_REASONS[num] || 'Sin datos para este paso.';
                } else {
                    item.removeAttribute('aria-disabled');
                    item.removeAttribute('title');
                    delete item.dataset.hiddenReason;
                }
                if (item.parentElement) item.parentElement.classList.remove('is-hidden');
            });
            // Si el paso activo dejó de estar visible, saltar al primer disponible.
            const list = visibleSteps();
            const stillCurrent = list.find(s => s.classList.contains('is-current'));
            if (!stillCurrent && list.length) setActive(list[0].getAttribute('data-step'));
        };

        // Cada vez que se muestran resultados, arrancamos en el primer paso
        // visible (el usuario espera empezar por 01, no seguir donde lo dejó
        // un análisis anterior).
        const first = visibleSteps()[0];
        if (first) setActive(first.getAttribute('data-step'));
        else refresh();

        if (this._journeyRailInitialized) return;
        this._journeyRailInitialized = true;

        rail.addEventListener('click', (ev) => {
            const a = ev.target.closest('.journey-rail__step');
            if (!a) return;
            ev.preventDefault();
            // Pastilla deshabilitada (paso sin datos): mostrar la razón en el
            // indicador del pager en vez de intentar activar el paso.
            if (a.classList.contains('is-disabled')) {
                const num = a.getAttribute('data-rail-step');
                const reason = a.dataset.hiddenReason || HIDDEN_REASONS[num] || 'Sin datos para este paso.';
                const ttl = pager.querySelector('[data-pager="title"]');
                const cur = pager.querySelector('[data-pager="current"]');
                if (cur) cur.textContent = String(num).padStart(2, '0');
                if (ttl) ttl.textContent = reason;
                pager.classList.add('is-showing-reason');
                clearTimeout(this._pagerReasonTimer);
                this._pagerReasonTimer = setTimeout(() => {
                    pager.classList.remove('is-showing-reason');
                    // Restaurar el paso activo real
                    const list = visibleSteps();
                    const current = list.find(s => s.classList.contains('is-current'));
                    if (current) setActive(current.getAttribute('data-step'));
                }, 3200);
                return;
            }
            setActive(a.getAttribute('data-rail-step'));
        });

        pager.addEventListener('click', (ev) => {
            const btn = ev.target.closest('[data-pager]');
            if (!btn || btn.disabled) return;
            const kind = btn.getAttribute('data-pager');
            if (kind !== 'prev' && kind !== 'next') return;
            const list = visibleSteps();
            const currentIdx = list.findIndex(s => s.classList.contains('is-current'));
            if (kind === 'prev' && currentIdx > 0) setActive(list[currentIdx - 1].getAttribute('data-step'));
            if (kind === 'next' && currentIdx < list.length - 1) setActive(list[currentIdx + 1].getAttribute('data-step'));
        });

        // Cuando un renderer oculta/muestra un paso (p.ej. paso 07 aparece
        // al grabar toma B), re-sincroniza rail + pager.
        const mo = new MutationObserver(refresh);
        steps.forEach(s => mo.observe(s, { attributes: true, attributeFilter: ['class'] }));
    },

    displayAnalysisResults() {
        if (!this.currentAnalysis) return;
        const { audioAnalysis, aiAnalysis } = this.currentAnalysis;

        document.getElementById('analysis-results')?.classList.remove('hidden');

        const badgeEl = document.getElementById('analysis-source-badge');
        if (badgeEl) {
            const source = String(aiAnalysis?.source || '');
            // Mensaje único para cualquier fallback (parse, schema, network):
            // el usuario no distingue entre "JSON malformado" y "sin conexión",
            // y la app ya reintentó internamente antes de mostrar esto. El
            // source real queda en aiAnalysis.source para debug/telemetría.
            const FALLBACK_MSG = 'No pudimos obtener una respuesta completa de la IA. Volvé a intentar en unos segundos.';
            const badges = {
                'ai-groq':              { cls: 'is-real', icon: 'fa-check-circle', text: 'Análisis con IA (Groq) — respuesta específica para tu grabación' },
                'ai-gemini':            { cls: 'is-real', icon: 'fa-check-circle', text: 'Análisis con IA (Gemini) — respuesta específica para tu grabación' },
                'ai-openrouter':        { cls: 'is-real', icon: 'fa-check-circle', text: 'Análisis con IA (OpenRouter) — respuesta específica para tu grabación' },
                'ai-groq+audio':        { cls: 'is-real', icon: 'fa-check-circle', text: 'Análisis con IA (Groq) + escucha profunda con Gemini — respuesta específica para tu grabación' },
                'ai-gemini+audio':      { cls: 'is-real', icon: 'fa-check-circle', text: 'Análisis con IA (Gemini) + escucha profunda — respuesta específica para tu grabación' },
                'ai-openrouter+audio':  { cls: 'is-real', icon: 'fa-check-circle', text: 'Análisis con IA (OpenRouter) + escucha profunda con Gemini — respuesta específica para tu grabación' },
                'fallback-parse-error':    { cls: 'is-fallback', icon: 'fa-triangle-exclamation', text: FALLBACK_MSG },
                'fallback-schema-invalid': { cls: 'is-fallback', icon: 'fa-triangle-exclamation', text: FALLBACK_MSG },
                'fallback-network':        { cls: 'is-fallback', icon: 'fa-triangle-exclamation', text: FALLBACK_MSG },
            };
            const b = badges[source] || badges['fallback-network'];
            const used = Array.isArray(audioAnalysis?.providersUsed) ? audioAnalysis.providersUsed : [];
            const failed = Array.isArray(audioAnalysis?.providersFailed) ? audioAnalysis.providersFailed : [];
            const engineChip = (used.length || failed.length)
                ? `<div class="analysis-engines">
                        <span class="analysis-engines__label">Motores de análisis:</span>
                        ${used.map(p => `<span class="analysis-engine-chip is-ok">✓ ${escapeHtml(p)}</span>`).join('')}
                        ${failed.map(p => `<span class="analysis-engine-chip is-fail">✗ ${escapeHtml(p)}</span>`).join('')}
                   </div>`
                : '';
            badgeEl.className = `analysis-source-badge ${b.cls}`;
            badgeEl.innerHTML = `<div class="analysis-source-badge__row"><i class="fas ${b.icon}"></i> <span>${b.text}</span></div>${engineChip}`;
        }

        this._renderEnginesPanel();

        const tempoBpm = Number(audioAnalysis?.tempo?.bpm || audioAnalysis?.tempo || 0);
        const tempoConfidence = Number(audioAnalysis?.tempo?.confidence || 0);
        const keyName = audioAnalysis?.key?.key || audioAnalysis?.pitch || '--';
        const keyScale = audioAnalysis?.key?.scale || '';
        const keyStrength = Number(audioAnalysis?.key?.strength || 0);
        const dynamic = Number(audioAnalysis?.loudness?.dynamicComplexity || 0);

        // Tempo, tonalidad y score se calculan (la IA los usa internamente) pero
        // no se muestran al usuario. Solo pintamos la duración.
        const durEl = document.getElementById('recording-duration');
        if (durEl) durEl.textContent = this.formatDuration(Math.floor(audioAnalysis.duration));

        // El bloque "Notas detectadas (Basic Pitch)" era útil para la IA pero
        // ruido para el pianista — se oculta siempre. La visualización real de
        // las notas (para grabaciones MIDI) va en el piano-roll de "Reproductor
        // con marcas" (_initAnalysisWavesurfer).
        const midiContainer = document.getElementById('midi-notes-container');
        const midiList = document.getElementById('midi-notes-list');
        if (midiContainer) midiContainer.classList.add('hidden');
        if (midiList) midiList.innerHTML = '';

        const musicalEl = document.getElementById('musical-analysis');
        if (musicalEl) {
            // Renderiza el análisis como párrafos separados por saltos de línea dobles.
            // Si la IA se escapa y mete marcadores de lista (-, *, •, 1. 2.),
            // los limpiamos y unimos las líneas como oraciones dentro del párrafo,
            // así el tono coach en prosa se ve como prosa y no como un checklist.
            const raw = String(aiAnalysis.musicalAnalysis || '').trim();
            const paragraphs = raw
                .split(/\n{2,}|\r{2,}/)
                .map(block => {
                    const lines = block
                        .split(/\r?\n/)
                        .map(l => l.replace(/^\s*(?:[-*•·▪●]|\d+[.)])\s+/, '').trim())
                        .filter(Boolean);
                    return lines.join(' ');
                })
                .filter(Boolean);
            musicalEl.innerHTML = paragraphs.length
                ? paragraphs.map(p => `<p>${escapeHtml(p)}</p>`).join('')
                : '<p class="no-data">Sin análisis disponible.</p>';
        }

        // Lo que estás haciendo bien — máx 2 puntos concretos (schema REGLA 8).
        this._renderStrengths(aiAnalysis?.strengths || []);

        // Paso 01 del recorrido — Tu percepción (autoevaluación previa).
        // Se pinta como primer bloque del flujo con lo que el pianista ya
        // respondió en el modal; si saltó, la sección queda oculta.
        this._renderPerception(this.currentAnalysis?.selfEvaluation);

        // Paso 06 del recorrido — Después de practicar.
        // Reseteamos borrador/edit al cambiar de análisis para que el estado
        // temporal de otro análisis no se mezcle con este. La persistencia
        // real vive en localStorage y se recupera dentro de _renderAfterPractice.
        this._afterPracticeDraft = null;
        this._afterPracticeEditing = false;
        this._renderAfterPractice(this.currentAnalysis);

        // Fase 3 — Zona de grabación de toma B + comparación A/B.
        // Cancelamos silenciosamente cualquier grabación colgada del análisis
        // previo (audio o MIDI) y destruimos players anteriores antes de
        // montar los del análisis nuevo.
        if (this._afterPracticeRec?.mediaRecorder) {
            try {
                if (this._afterPracticeRec.mediaRecorder.state !== 'inactive') {
                    this._afterPracticeRec.mediaRecorder.stop();
                }
                this._afterPracticeRec.stream?.getTracks().forEach(t => t.stop());
                clearInterval(this._afterPracticeRec.timerInterval);
            } catch {}
            this._afterPracticeRec = null;
        }
        if (this._afterPracticeMidiRec?.isRecording) {
            try {
                this._afterPracticeMidiRec.stopRecording();
                clearInterval(this._afterPracticeMidiRec.timerInterval);
            } catch {}
        }
        this._destroyAbTakes();
        this._renderAfterPracticeRecording(this.currentAnalysis);
        this._renderAbTakes(this.currentAnalysis);

        // Tu oído vs los datos — Fase A SRL. Aparece solo si vino self-eval y
        // el modelo llenó beliefVsDetection (REGLA 10).
        this._renderBeliefVsDetection(aiAnalysis?.beliefVsDetection || '');

        // Observaciones en tres niveles (REGLA 7 del prompt): fact → interpretation
        // → recommendation. Sección visible solo si el LLM devolvió al menos una;
        // si no pudo articular ninguna con las tres capas honestas, no aparece
        // (mejor no mostrar que forzar prosa vacía).
        this._renderLayeredObservations(aiAnalysis?.observations || []);

        // Tu principal foco — puente narrativo hacia el ejercicio (REGLA 8).
        // Se renderiza JUSTO antes del ejercicio (orden del DOM), sin repetir
        // lo que dice el ejercicio ni musicalAnalysis ni observations.
        this._renderPrimaryFocus(aiAnalysis?.primaryFocus || '');

        this._renderPracticeExercise(aiAnalysis?.practiceExercise);

        // Objetivo próxima sesión — se muestra solo si vino del modelo. Se conecta
        // con la memoria del estudiante en el próximo análisis (el modelo verá
        // los ejercicios previos y puede chequear si el objetivo se cumplió).
        const nextGoalSection = document.getElementById('analysis-next-goal-section');
        const nextGoalText = document.getElementById('analysis-next-goal-text');
        const goal = String(aiAnalysis?.nextGoal || '').trim();
        if (nextGoalSection && nextGoalText) {
            if (goal) {
                nextGoalText.textContent = goal;
                nextGoalSection.classList.remove('hidden');
            } else {
                nextGoalSection.classList.add('hidden');
                nextGoalText.textContent = '';
            }
        }

        // Pregunta metacognitiva final — Fase A SRL (REGLA 11). Es lo último
        // que ve el pianista antes del reproductor y el chat.
        this._renderMetacognitiveQuestion(aiAnalysis?.metacognitiveQuestion || '');

        // Reproductor WaveSurfer con regiones — vive siempre visible en el
        // dock (#analysis-player-dock) arriba del chat, así que su contenedor
        // ya tiene dimensiones reales al inicializar. No hace falta activar
        // temporalmente ningún paso del recorrido.
        this._initAnalysisWavesurfer();

        // Reset chat
        this.analysisChat = [];
        this.renderAnalysisChat();

        // Rail: refresca visibilidad según qué pasos quedaron ocultos por los
        // renderers (paso 01 sin selfEval, 04 sin metaq, 07 sin toma B, 08 sin
        // observaciones, 09 sin nextGoal). Primera llamada monta observers.
        this._syncJourneyRail();
    },

    _initAnalysisWavesurfer() {
        this._teardownAnalysisWavesurfer();

        const container = document.getElementById('analysis-wavesurfer');
        if (!container || !(this.currentAnalysisAudioBlob instanceof Blob)) return;

        // WaveSurfer no puede renderizar MIDI. Para grabaciones MIDI armamos
        // un piano roll SVG con reproducción por síntesis (triángulos + ADSR
        // simple vía Web Audio), replicando la UX de la rama audio: momentos
        // clicables, click para seek, drag para marcar región de foco, botón
        // play/pausa y loop de fragmento reciclando los mismos elementos.
        const isMidi = String(this.currentAnalysis?.audioAnalysis?.source || '') === 'midi-input';
        if (isMidi) {
            const timelineEl = document.getElementById('analysis-wavesurfer-timeline');
            if (timelineEl) timelineEl.innerHTML = '';   // el piano roll trae su propio eje
            const audioAnalysis = this.currentAnalysis?.audioAnalysis || {};
            const roll = new MidiPianoRoll(container, {
                notes: audioAnalysis.midiNotes || [],
                duration: Number(audioAnalysis.duration || 0),
                height: 160,
            });
            this.analysisMidiPianoRoll = roll;
            this.analysisUserRegion = null;

            const noteEl = document.getElementById('analysis-moment-note');
            const timeEl = document.getElementById('analysis-time-label');
            const updateTime = () => {
                if (!timeEl) return;
                timeEl.textContent = `${this.formatDuration(roll.getCurrentTime())} / ${this.formatDuration(roll.getDuration())}`;
            };
            this._setAnalysisPlayLabel(false);
            updateTime();
            roll.on('play', () => this._setAnalysisPlayLabel(true));
            roll.on('pause', () => this._setAnalysisPlayLabel(false));
            roll.on('finish', () => this._setAnalysisPlayLabel(false));
            roll.on('audioprocess', updateTime);
            roll.on('seeking', updateTime);
            roll.on('ready', () => {
                updateTime();
                const moments = Array.isArray(this.currentAnalysis?.aiAnalysis?.moments)
                    ? this.currentAnalysis.aiAnalysis.moments
                    : [];
                roll.setMoments(moments);
            });
            roll.on('moment-click', (m) => {
                if (noteEl) noteEl.textContent = String(m?.note || '');
            });
            roll.on('region-created', (region) => {
                this.analysisUserRegion = region;
                this._updateAnalysisFocusUi();
            });
            roll.on('region-cleared', () => {
                this.analysisUserRegion = null;
                this._updateAnalysisFocusUi();
            });

            // Botones del transporte — reutilizan los mismos IDs. Uso guard
            // '_analysisMidiWired' distinto al de wavesurfer para no colisionar
            // (si el usuario cambia entre grabaciones el estado se reinicia).
            const playBtn = document.getElementById('analysis-play-btn');
            if (playBtn) {
                const newPlay = playBtn.cloneNode(true);
                playBtn.replaceWith(newPlay);
                newPlay.addEventListener('click', () => this.analysisMidiPianoRoll?.playPause());
            }
            const playRegionBtn = document.getElementById('analysis-play-region-btn');
            if (playRegionBtn) {
                const newBtn = playRegionBtn.cloneNode(true);
                playRegionBtn.replaceWith(newBtn);
                newBtn.addEventListener('click', () => {
                    const r = this.analysisUserRegion;
                    if (r) this.analysisMidiPianoRoll?.playRegion(r);
                });
            }
            const clearRegionBtn = document.getElementById('analysis-clear-region-btn');
            if (clearRegionBtn) {
                const newBtn = clearRegionBtn.cloneNode(true);
                clearRegionBtn.replaceWith(newBtn);
                newBtn.addEventListener('click', () => {
                    this.analysisMidiPianoRoll?.clearUserRegion();
                });
            }
            const chipClearBtn = document.querySelector('#analysis-chat-focus-chip .focus-chip-clear');
            if (chipClearBtn) {
                const newBtn = chipClearBtn.cloneNode(true);
                chipClearBtn.replaceWith(newBtn);
                newBtn.addEventListener('click', () => {
                    this.analysisMidiPianoRoll?.clearUserRegion();
                });
            }
            this._updateAnalysisFocusUi();
            return;
        }

        const rootStyles = getComputedStyle(document.documentElement);
        const accent = rootStyles.getPropertyValue('--accent-green').trim() || '#00ff41';
        const textPrimary = rootStyles.getPropertyValue('--text-primary').trim() || '#ffffff';
        const textSecondary = rootStyles.getPropertyValue('--text-secondary').trim() || '#aaaaaa';

        const ws = WaveSurfer.create({
            container,
            waveColor: 'rgba(59, 168, 105, 0.55)',
            progressColor: accent,
            cursorColor: textPrimary,
            cursorWidth: 2,
            height: 140,
            barWidth: 2,
            barGap: 1,
            barRadius: 2,
            normalize: true,
            plugins: [
                // TimelinePlugin removido — la regla superpuesta al card se
                // veía desconectada del contenido. El transporte
                // (analysis-time-label) ya muestra el tiempo actual.
                HoverPlugin.create({
                    lineColor: textPrimary,
                    lineWidth: 1,
                    labelBackground: 'rgba(0, 0, 0, 0.75)',
                    labelColor: '#ffffff',
                    labelSize: '11px',
                }),
            ],
        });

        const regionsPlugin = ws.registerPlugin(RegionsPlugin.create());
        this.analysisWavesurfer = ws;
        this.analysisRegionsPlugin = regionsPlugin;
        // Slot único para la región que dibuja el usuario. Sirve para: (a)
        // pasar el rango a AIAnalysisEngine.answerQuestion como focusRegion,
        // y (b) mostrar/ocultar el chip "Preguntando sobre X:XX–Y:YY".
        // Distinta de las regiones que la IA genera (moments), que son fijas.
        this.analysisUserRegion = null;
        // Habilita drag-selection para que el usuario pueda marcar cualquier
        // fragmento libre. Color azul para diferenciarlo del verde de Grabar
        // y del código de colores de los moments (good/improve/neutral).
        regionsPlugin.enableDragSelection({ color: 'rgba(64, 128, 255, 0.28)' });

        const noteEl = document.getElementById('analysis-moment-note');
        const timeEl = document.getElementById('analysis-time-label');

        const updateTime = () => {
            if (!timeEl) return;
            timeEl.textContent = `${this.formatDuration(ws.getCurrentTime())} / ${this.formatDuration(ws.getDuration())}`;
        };
        this._setAnalysisPlayLabel(false);
        ws.on('play', () => this._setAnalysisPlayLabel(true));
        ws.on('pause', () => this._setAnalysisPlayLabel(false));
        ws.on('finish', () => this._setAnalysisPlayLabel(false));
        ws.on('audioprocess', updateTime);
        ws.on('seeking', updateTime);

        ws.on('ready', () => {
            updateTime();
            const moments = Array.isArray(this.currentAnalysis?.aiAnalysis?.moments)
                ? this.currentAnalysis.aiAnalysis.moments
                : [];
            const total = ws.getDuration();
            const palette = {
                good:    'rgba(0, 200, 100, 0.28)',
                improve: 'rgba(255, 160, 0, 0.28)',
                neutral: 'rgba(160, 160, 160, 0.22)',
            };
            // Los moments necesitan NO capturar mouse events, sino
            // `enableDragSelection` no arranca sobre esas zonas. Wavesurfer
            // regions v7 crea CADA región con `pointer-events: all` HARDCODED
            // en el style (la opción `interact` es fake, no existe). Fix
            // real: forzar `pointer-events: none` en el DOM element después
            // de crear la región. Y `pointer-events: none` en el .content
            // interno (la caja del texto) que hereda por default. El hover/
            // click de la nota se reemplaza con lookup manual abajo.
            const momentSpans = [];
            for (const m of moments) {
                const start = Math.max(0, Math.min(total, Number(m?.timeStart) || 0));
                const end = Math.max(start + 0.1, Math.min(total, Number(m?.timeEnd) || start + 1));
                const kind = ['good', 'improve', 'neutral'].includes(m?.kind) ? m.kind : 'neutral';
                const color = palette[kind];
                const region = regionsPlugin.addRegion({
                    start,
                    end,
                    color,
                    drag: false,
                    resize: false,
                    content: String(m?.note || '').slice(0, 80),
                });
                // Wavesurfer setea pointer-events:all en el style inline al
                // renderizar; sobreescribimos después. Element ya existe
                // porque addRegion lo crea sincrónico cuando ya hay duration.
                if (region.element) {
                    region.element.style.pointerEvents = 'none';
                    // El content (caja de texto flotante) también, para que no
                    // capture eventos aunque quede visible arriba de la región.
                    const contentEl = region.element.querySelector('[part="region-content"]');
                    if (contentEl) contentEl.style.pointerEvents = 'none';
                }
                momentSpans.push({ start, end, note: String(m?.note || '') });
            }

            // Reemplazo del hover nativo por lookup manual sobre el contenedor.
            // Encuentra el moment más cercano a la posición del cursor y lo
            // muestra en el chip de nota. Se detiene cuando el cursor sale
            // del waveform.
            if (noteEl && momentSpans.length && container) {
                const containerRect = () => container.getBoundingClientRect();
                const findMomentAt = (timeSec) => {
                    for (const m of momentSpans) {
                        if (timeSec >= m.start && timeSec <= m.end) return m;
                    }
                    return null;
                };
                container.addEventListener('pointermove', (e) => {
                    const rect = containerRect();
                    if (rect.width <= 0) return;
                    const x = e.clientX - rect.left;
                    const ratio = Math.max(0, Math.min(1, x / rect.width));
                    const t = ratio * total;
                    const m = findMomentAt(t);
                    if (m) noteEl.textContent = m.note;
                });
                container.addEventListener('click', (e) => {
                    const rect = containerRect();
                    if (rect.width <= 0) return;
                    const x = e.clientX - rect.left;
                    const ratio = Math.max(0, Math.min(1, x / rect.width));
                    const t = ratio * total;
                    const m = findMomentAt(t);
                    if (m) noteEl.textContent = m.note;
                });
            }
        });

        const playBtn = document.getElementById('analysis-play-btn');
        if (playBtn) {
            const newPlay = playBtn.cloneNode(true);
            playBtn.replaceWith(newPlay);
            newPlay.addEventListener('click', () => {
                if (this.analysisWavesurfer) this.analysisWavesurfer.playPause();
            });
        }

        // region-created: la dispara enableDragSelection cuando el usuario
        // termina de arrastrar. Distingue la región del usuario de las de la
        // IA por color (las de IA se crearon con drag:false,resize:false).
        regionsPlugin.on('region-created', (region) => {
            if (region.drag === false || region.resize === false) return; // región de IA
            // Solo una región de usuario a la vez: borrar la anterior si existía.
            if (this.analysisUserRegion && this.analysisUserRegion !== region) {
                try { this.analysisUserRegion.remove(); } catch { /* ya no existe */ }
            }
            this.analysisUserRegion = region;
            this._updateAnalysisFocusUi();
            region.on('remove', () => {
                if (this.analysisUserRegion === region) {
                    this.analysisUserRegion = null;
                    this._updateAnalysisFocusUi();
                }
            });
            region.on('update-end', () => this._updateAnalysisFocusUi());
        });

        const playRegionBtn = document.getElementById('analysis-play-region-btn');
        if (playRegionBtn) {
            const newBtn = playRegionBtn.cloneNode(true);
            playRegionBtn.replaceWith(newBtn);
            newBtn.addEventListener('click', () => {
                const r = this.analysisUserRegion;
                if (!r) return;
                try { r.play(true); } catch (e) { console.warn('play region falló:', e); }
            });
        }
        const clearRegionBtn = document.getElementById('analysis-clear-region-btn');
        if (clearRegionBtn) {
            const newBtn = clearRegionBtn.cloneNode(true);
            clearRegionBtn.replaceWith(newBtn);
            newBtn.addEventListener('click', () => {
                if (this.analysisUserRegion) {
                    try { this.analysisUserRegion.remove(); } catch { /* ya no */ }
                    this.analysisUserRegion = null;
                    this._updateAnalysisFocusUi();
                }
            });
        }
        const chipClearBtn = document.querySelector('#analysis-chat-focus-chip .focus-chip-clear');
        if (chipClearBtn) {
            const newBtn = chipClearBtn.cloneNode(true);
            chipClearBtn.replaceWith(newBtn);
            newBtn.addEventListener('click', () => {
                if (this.analysisUserRegion) {
                    try { this.analysisUserRegion.remove(); } catch { /* ya no */ }
                    this.analysisUserRegion = null;
                }
                this._updateAnalysisFocusUi();
            });
        }
        this._updateAnalysisFocusUi();

        const loadPromise = typeof ws.loadBlob === 'function'
            ? ws.loadBlob(this.currentAnalysisAudioBlob)
            : ws.load(this.createTrackedObjectURL(this.currentAnalysisAudioBlob));
        Promise.resolve(loadPromise).catch((e) => {
            console.error('Analysis WaveSurfer load error:', e);
            this.showNotification('No se pudo cargar el audio del análisis', 'error');
        });
    },

    _teardownAnalysisWavesurfer() {
        try {
            this.analysisWavesurfer?.destroy();
        } catch {
            // Ignore destroy errors — the instance may already be gone.
        }
        try {
            this.analysisMidiPianoRoll?.destroy();
        } catch {
            // idem para el piano roll
        }
        this.analysisWavesurfer = null;
        this.analysisRegionsPlugin = null;
        this.analysisMidiPianoRoll = null;
        this.analysisUserRegion = null;
        const noteEl = document.getElementById('analysis-moment-note');
        if (noteEl) noteEl.textContent = '';
        this._updateAnalysisFocusUi();
    },

    // Refresca los tres controles del "fragmento en foco":
    //   - Chip debajo del chat ("Preguntando sobre X:XX–Y:YY")
    //   - Botones Loop/Limpiar en el transporte del reproductor
    // Se llama cada vez que la región del usuario cambia (crear/mover/borrar).
    _updateAnalysisFocusUi() {
        const chip = document.getElementById('analysis-chat-focus-chip');
        const playRegionBtn = document.getElementById('analysis-play-region-btn');
        const clearRegionBtn = document.getElementById('analysis-clear-region-btn');
        const region = this.analysisUserRegion;
        if (!region) {
            if (chip) chip.hidden = true;
            if (playRegionBtn) playRegionBtn.hidden = true;
            if (clearRegionBtn) clearRegionBtn.hidden = true;
            return;
        }
        const start = Number(region.start) || 0;
        const end = Number(region.end) || start;
        const rangeEl = chip?.querySelector('[data-role="focus-range"]');
        if (rangeEl) {
            rangeEl.textContent = `${this.formatDuration(start)} – ${this.formatDuration(end)}`;
        }
        if (chip) chip.hidden = false;
        if (playRegionBtn) playRegionBtn.hidden = false;
        if (clearRegionBtn) clearRegionBtn.hidden = false;
    },

    _setAnalysisPlayLabel(isPlaying) {
        const btn = document.getElementById('analysis-play-btn');
        if (!btn) return;
        const icon = btn.querySelector('i');
        const label = btn.querySelector('[data-role="analysis-play-label"]');
        if (icon) icon.className = isPlaying ? 'fas fa-pause' : 'fas fa-play';
        if (label) label.textContent = isPlaying ? 'Pause' : 'Play';
    },

    saveAnalysis() {
        if (!this.currentAnalysis) return;

        this.analysisHistory = Array.isArray(this.analysisHistory) ? this.analysisHistory : [];
        this.analysisHistory.unshift(this.currentAnalysis);
        this.safeSetLocalStorage(this.userKey('pianostudy-analysis-history'), this.analysisHistory);
        this.renderAnalysisHistory();
        this.renderCalibrationPanel();
        this.persistCurrentAnalysisAudio();
        this.showNotification('Análisis guardado', 'success');
    },

    loadAnalysisHistory() {
        if (!this.getActiveUsername()) {
            this.analysisHistory = [];
            this.renderAnalysisHistory();
            this.renderCalibrationPanel();
            return;
        }
        const stored = this.safeGetLocalStorage(this.userKey('pianostudy-analysis-history'), []);
        this.analysisHistory = Array.isArray(stored) ? stored : [];
        this.renderAnalysisHistory();
        this.renderCalibrationPanel();
    },

    // Fase B1 SRL: renderiza el panel "Cómo mejora tu oído".
    // Se oculta completamente si el usuario aún no tiene 2+ sesiones con
    // autoevaluación (no queremos mostrar el panel vacío o con "faltan datos"
    // como intro — mejor invisible hasta que aporta).
    renderCalibrationPanel() {
        const panel = document.getElementById('analysis-calibration-panel');
        const body = document.getElementById('analysis-calibration-body');
        const toggle = document.getElementById('analysis-calibration-toggle');
        const content = document.getElementById('analysis-calibration-content');
        if (!panel || !body || !toggle || !content) return;

        const list = Array.isArray(this.analysisHistory) ? this.analysisHistory : [];
        const entries = list
            .filter(a => a?.selfEvaluation && typeof a.selfEvaluation === 'object')
            .map(a => AIAnalysisEngine._computeCalibrationEntry(a))
            .filter(Boolean);

        if (entries.length < 2) {
            // Con <2 sesiones el panel no aporta. Ocultarlo por completo.
            panel.classList.add('hidden');
            body.classList.add('hidden');
            toggle.setAttribute('aria-expanded', 'false');
            toggle.textContent = 'Mostrar';
            return;
        }

        panel.classList.remove('hidden');

        const summary = AIAnalysisEngine.computeCalibrationSummary(entries);
        if (!summary || !summary.hasData) {
            content.innerHTML = `<p class="calibration-needs-more">Necesitás al menos 2 sesiones con autoevaluación para ver la calibración.</p>`;
        } else {
            const trendCls = `calibration-trend--${summary.trend}`;
            const trendCopy = {
                mejorando: `📈 Tu oído se está acercando al análisis (${summary.deltaPct > 0 ? '+' : ''}${summary.deltaPct}% vs sesiones anteriores).`,
                bajando: `📉 Tu autoevaluación se está alejando del análisis (${summary.deltaPct}% vs sesiones anteriores). Puede ser natural mientras probás cosas nuevas.`,
                estable: `➖ Tu autoevaluación se mantiene estable respecto del análisis.`,
            }[summary.trend] || '';

            const barsHtml = summary.recentEntries.map((e) => {
                const cls = `calibration-mini-chart__bar--${e.ratingConvergence || 'unknown'}`;
                const height = e.ratingConvergence === 'high' ? '100%'
                    : e.ratingConvergence === 'partial' ? '60%'
                    : e.ratingConvergence === 'low' ? '30%'
                    : '15%';
                const label = e.ratingConvergence === 'high' ? 'Convergencia alta'
                    : e.ratingConvergence === 'partial' ? 'Convergencia parcial'
                    : e.ratingConvergence === 'low' ? 'Convergencia baja'
                    : 'Sin datos suficientes';
                return `<div class="calibration-mini-chart__bar ${cls}" style="height: ${height};" title="${escapeHtml(label)} — ${new Date(e.timestamp).toLocaleDateString()}"></div>`;
            }).join('');

            content.innerHTML = `
                <div class="calibration-stats">
                    <div class="calibration-stat">
                        <div class="calibration-stat__value">${summary.highConvergencePct}%</div>
                        <span class="calibration-stat__label">Tu oído acierta</span>
                    </div>
                    <div class="calibration-stat">
                        <div class="calibration-stat__value">${summary.areaMatchPct}%</div>
                        <span class="calibration-stat__label">Área que identificaste</span>
                    </div>
                    <div class="calibration-stat">
                        <div class="calibration-stat__value">${summary.totalSessions}</div>
                        <span class="calibration-stat__label">Sesiones con auto-eval</span>
                    </div>
                </div>
                <div class="calibration-trend ${trendCls}">${escapeHtml(trendCopy)}</div>
                <div>
                    <span class="calibration-stat__label" style="display:block; margin-bottom: 0.35rem;">Últimas ${summary.recentEntries.length} sesiones (verde = tu evaluación coincidió con los datos)</span>
                    <div class="calibration-mini-chart">${barsHtml}</div>
                </div>
            `;
        }

        // Toggle listener (idempotente — reemplazamos handler cada render).
        toggle.onclick = () => {
            const expanded = toggle.getAttribute('aria-expanded') === 'true';
            const next = !expanded;
            toggle.setAttribute('aria-expanded', String(next));
            toggle.textContent = next ? 'Ocultar' : 'Mostrar';
            body.classList.toggle('hidden', !next);
        };
    },

    renderAnalysisHistory() {
        const container = document.getElementById('analysis-history-list');
        if (!container) return;

        if (!this.getActiveUsername()) {
            container.innerHTML = `<div class="auth-required-banner">
                <p>Inicia sesión para ver tu historial de análisis</p>
                <button class="auth-header-btn auth-header-btn--primary" onclick="document.getElementById('auth-open-login')?.click()">Ingresar</button>
            </div>`;
            return;
        }

        if (!this.analysisHistory.length) {
            container.innerHTML = '<p class="no-data">No hay análisis guardados todavía</p>';
            return;
        }

        container.innerHTML = this.analysisHistory.map(analysis => {
            const date = new Date(analysis.timestamp);
            const score = analysis.aiAnalysis?.overallScore ?? '--';
            const tempo = Number(analysis.audioAnalysis?.tempo?.bpm || analysis.audioAnalysis?.tempo || 0) || '--';
            return `
                <div class="history-item">
                    <div class="history-header">
                        <div>
                            <div class="history-title">${escapeHtml(analysis.recordingName || 'Grabación')}</div>
                            <div class="history-date">${escapeHtml(date.toLocaleDateString())}</div>
                        </div>
                        <div class="history-actions">
                            <button class="btn-small" data-action="analysis-view" data-id="${escapeHtml(String(analysis.timestamp))}">
                                <i class="fas fa-eye"></i> Ver
                            </button>
                            <button class="btn-small btn-danger" data-action="analysis-delete" data-id="${escapeHtml(String(analysis.timestamp))}">
                                <i class="fas fa-trash"></i> Borrar
                            </button>
                        </div>
                    </div>
                    <div class="history-preview">
                        <span>Puntuación: ${escapeHtml(String(score))}/10</span>
                        <span>Tempo: ${escapeHtml(String(tempo))} BPM</span>
                    </div>
                </div>
            `;
        }).join('');
    },

    async deleteAnalysisEntry(timestamp) {
        const ts = Number(timestamp);
        if (!Number.isFinite(ts)) return;

        const item = (this.analysisHistory || []).find(a => Number(a?.timestamp) === ts);
        if (!item) return;

        if (!await this.showConfirm('¿Borrar este análisis?')) return;

        try {
            this.analysisHistory = (this.analysisHistory || []).filter(a => Number(a?.timestamp) !== ts);
            this.safeSetLocalStorage(this.userKey('pianostudy-analysis-history'), this.analysisHistory);

            await this.deleteAnalysisAudioFromDb(ts);

            if (Number(this.currentAnalysis?.timestamp) === ts) {
                this.resetAnalysis();
            }

            this.renderAnalysisHistory();
            this.showNotification('Análisis borrado', 'success');
        } catch (e) {
            console.error('deleteAnalysisEntry error:', e);
            this.showNotification('No se pudo borrar el análisis', 'error');
        }
    },

    resetAnalysis() {
        document.getElementById('analysis-results')?.classList.add('hidden');
        const select = document.getElementById('analysis-recording-select');
        if (select) select.value = '';
        const btn = document.getElementById('start-analysis-btn');
        if (btn) btn.disabled = true;
        this.currentAnalysis = null;
        this.currentAnalysisAudioBlob = null;
        this._teardownAnalysisWavesurfer();
        const badgeEl = document.getElementById('analysis-source-badge');
        if (badgeEl) {
            badgeEl.className = 'analysis-source-badge';
            badgeEl.innerHTML = '';
        }
    },

    async viewHistoricalAnalysis(timestamp) {
        const ts = Number(timestamp);
        if (!Number.isFinite(ts)) return;
        const item = (this.analysisHistory || []).find(a => Number(a?.timestamp) === ts);
        if (!item) return;

        this.currentAnalysis = item;
        this.currentAnalysisAudioBlob = await this.loadAnalysisAudioFromDb(ts);
        this.showSection('ai-analysis');
        this.displayAnalysisResults();
    },

    // Detecta si un mensaje del asistente vino del fallback local en vez de la
    // IA real. El fallback siempre arranca con esta frase fija — ver
    // AIAnalysisEngine.getFallbackAnswer(..., true).
    _isChatFallbackText(text) {
        return String(text || '').trimStart().startsWith('No pude conectar con la IA');
    },

    // Chips de follow-up. Estáticos (no le pedimos otra ronda al modelo por
    // cada respuesta — sería otro request y más latencia). La lista es genérica
    // pero cubre bien las próximas preguntas típicas después de una respuesta
    // del análisis, y siempre se ofrecen las tres más relevantes según el
    // fragmento en foco y el estado del análisis.
    _analysisChatSuggestions() {
        const suggestions = [];
        if (this.analysisUserRegion) {
            suggestions.push('¿Qué está pasando exactamente en este fragmento?');
            suggestions.push('Dame un ejercicio específico para practicar este pasaje.');
        } else {
            suggestions.push('Dame un ejercicio concreto para lo que me señalaste.');
            suggestions.push('¿Y para la mano izquierda qué me sugerís?');
        }
        const primary = String(this.currentAnalysis?.aiAnalysis?.primaryFocus || '').trim();
        if (primary) suggestions.push('¿Por qué elegiste ese foco principal?');
        else suggestions.push('¿En qué compás o rango me tengo que fijar?');
        return suggestions.slice(0, 3);
    },

    renderAnalysisChat() {
        const container = document.getElementById('analysis-chat-messages');
        if (!container) return;

        if (!this.analysisChat.length) {
            container.innerHTML = '<div class="chat-message assistant"><div class="chat-role">NeuralJam</div><div class="chat-text">Preguntame sobre tu interpretación (tempo, dinámica, coordinación, lo que quieras revisar de la grabación).</div></div>';
            return;
        }

        // La última respuesta del asistente lleva chips de follow-up (o botón
        // de reintentar si vino del fallback). Las anteriores se dejan limpias
        // para no llenar el hilo de botones.
        const lastAssistantIdx = (() => {
            for (let i = this.analysisChat.length - 1; i >= 0; i--) {
                if (this.analysisChat[i].role === 'assistant') return i;
            }
            return -1;
        })();

        container.innerHTML = this.analysisChat.map((m, idx) => {
            const role = m.role === 'user' ? 'Tú' : 'NeuralJam';
            const cls = m.role === 'user' ? 'user' : 'assistant';
            const isLastAssistant = idx === lastAssistantIdx && m.role === 'assistant';
            let extra = '';
            if (isLastAssistant) {
                if (this._isChatFallbackText(m.text)) {
                    extra = `<div class="chat-actions"><button type="button" class="chat-retry-btn" data-action="chat-retry"><i class="fas fa-rotate-right"></i> Reintentar</button></div>`;
                } else {
                    const chips = this._analysisChatSuggestions()
                        .map(q => `<button type="button" class="chat-suggestion" data-action="chat-suggest" data-q="${escapeHtml(q)}">${escapeHtml(q)}</button>`)
                        .join('');
                    extra = `<div class="chat-suggestions">${chips}</div>`;
                }
            }
            return `<div class="chat-message ${cls}"><div class="chat-role">${escapeHtml(role)}</div><div class="chat-text">${escapeHtml(m.text)}</div>${extra}</div>`;
        }).join('');

        // Delegación de eventos — reemplazamos innerHTML así que reasignar cada vez está OK.
        container.onclick = (ev) => {
            const btn = ev.target.closest('[data-action]');
            if (!btn) return;
            const action = btn.getAttribute('data-action');
            if (action === 'chat-suggest') {
                const q = btn.getAttribute('data-q') || '';
                const input = document.getElementById('analysis-chat-input');
                if (input) { input.value = q; input.focus(); }
                this.sendAnalysisChat();
            } else if (action === 'chat-retry') {
                this._retryLastAnalysisChat();
            }
        };

        container.scrollTop = container.scrollHeight;
    },

    async _retryLastAnalysisChat() {
        // Busca la última pregunta del usuario y la reenvía. Removemos la
        // respuesta anterior (que era el fallback) para que renderAnalysisChat
        // no muestre dos veces la misma cosa.
        if (!Array.isArray(this.analysisChat) || !this.analysisChat.length) return;
        let lastUserIdx = -1;
        for (let i = this.analysisChat.length - 1; i >= 0; i--) {
            if (this.analysisChat[i].role === 'user') { lastUserIdx = i; break; }
        }
        if (lastUserIdx === -1) return;
        const lastUser = this.analysisChat[lastUserIdx];
        // Removemos el fallback anterior + la pregunta original — se van a
        // reencolar en sendAnalysisChat con el mismo texto.
        this.analysisChat = this.analysisChat.slice(0, lastUserIdx);
        const input = document.getElementById('analysis-chat-input');
        if (input) input.value = lastUser.text;
        await this.sendAnalysisChat();
    },

    async sendAnalysisChat() {
        if (!this.currentAnalysis) {
            this.showNotification('Primero analiza una grabación', 'info');
            return;
        }

        const input = document.getElementById('analysis-chat-input');
        const sendBtn = document.getElementById('analysis-chat-send');
        const question = String(input?.value || '').trim();
        if (!question) return;

        this.analysisChat.push({ role: 'user', text: question });
        if (input) input.value = '';
        this.renderAnalysisChat();

        // Indicador visual "NeuralJam escribiendo…" — misma estética que el
        // widget de la esquina (3 puntitos cyan pulsando). Se agrega al DOM
        // fuera de analysisChat[] para no persistirlo, y se quita apenas
        // llegue la respuesta (o el error).
        const typingEl = this._showAnalysisTyping();
        if (sendBtn) sendBtn.disabled = true;
        if (input) input.disabled = true;

        const { audioAnalysis, aiAnalysis, reliability } = this.currentAnalysis;
        const engine = this.aiEngine || new AIAnalysisEngine();
        // Pasamos historial excluyendo la pregunta recién agregada (se pasa aparte).
        const historyForModel = this.analysisChat.slice(0, -1);
        // Si el usuario marcó un fragmento en la waveform, se lo pasamos al
        // motor como focusRegion para que enfoque la respuesta ahí.
        const focusRegion = this.analysisUserRegion
            ? { start: Number(this.analysisUserRegion.start) || 0, end: Number(this.analysisUserRegion.end) || 0 }
            : null;
        // Contexto rico para el chat — metadata declarada por el pianista,
        // reliability para que el chat aplique el mismo hedge que el análisis
        // principal, y memoria de sesiones previas (incluye rejections así el
        // chat tampoco insiste con observaciones que el usuario ya rechazó).
        const metadata = this.currentAnalysis.metadata || null;
        const studentMemory = AIAnalysisEngine.buildStudentMemory(
            this.analysisHistory || [],
            { rejections: this.getObservationRejections() },
        );
        const chatCtx = { metadata, reliability, studentMemory };

        // Streaming ON por default (dev). Se puede apagar con
        //   localStorage['pianoStudy.chat.streaming'] = 'off'
        // por si el usuario quiere el comportamiento viejo temporalmente.
        const streamingEnabled = (() => {
            try {
                const v = localStorage.getItem('pianoStudy.chat.streaming');
                return v !== 'off';
            } catch { return true; }
        })();

        let streamingSucceeded = false;
        if (streamingEnabled) {
            try {
                // Construimos el prompt reutilizando la lógica que ya
                // hace retrieval + guard de tokens + hedge por reliability.
                const { systemPrompt, userPrompt } = engine.buildQuestionPrompt(
                    audioAnalysis, aiAnalysis, question, historyForModel, focusRegion, chatCtx,
                );
                const provider = AIAnalysisEngine._getProvider('chat');

                // Se inserta un mensaje asistente vacío que vamos llenando
                // con los chunks — el render con streaming mueve la sensación
                // de latencia de "todo o nada" a "el bot está pensando/escribiendo".
                const idx = this.analysisChat.push({ role: 'assistant', text: '' }) - 1;
                typingEl?.remove();
                let rafPending = false;
                const scheduleRender = () => {
                    if (rafPending) return;
                    rafPending = true;
                    requestAnimationFrame(() => {
                        rafPending = false;
                        this.renderAnalysisChat();
                    });
                };
                await streamChat({
                    provider,
                    body: {
                        prompt: userPrompt,
                        systemPrompt,
                        temperature: 0.6,
                        maxTokens: 800,
                    },
                    onChunk: (_delta, fullText) => {
                        this.analysisChat[idx].text = fullText;
                        scheduleRender();
                    },
                    onDone: (fullText) => {
                        this.analysisChat[idx].text = fullText || this.analysisChat[idx].text;
                        this.renderAnalysisChat();
                    },
                });
                streamingSucceeded = this.analysisChat[idx]?.text?.length > 0;
                if (!streamingSucceeded) {
                    // El stream terminó sin texto — sacamos el mensaje vacío
                    // y caemos al método no-stream abajo.
                    this.analysisChat.splice(idx, 1);
                }
            } catch (err) {
                console.warn('Chat streaming falló, uso answerQuestion no-stream:', err?.message || err);
                // Si dejamos un mensaje vacío del intento fallido, lo removemos.
                const last = this.analysisChat[this.analysisChat.length - 1];
                if (last?.role === 'assistant' && !last.text) this.analysisChat.pop();
            }
        }

        try {
            if (!streamingSucceeded) {
                const answer = await engine.answerQuestion(
                    audioAnalysis, aiAnalysis, question, historyForModel, focusRegion, chatCtx,
                );
                this.analysisChat.push({ role: 'assistant', text: String(answer || '') });
            }
        } finally {
            typingEl?.remove();
            if (sendBtn) sendBtn.disabled = false;
            if (input) { input.disabled = false; input.focus(); }
            this.renderAnalysisChat();
        }
    },

    _showAnalysisTyping() {
        const container = document.getElementById('analysis-chat-messages');
        if (!container) return null;
        const el = document.createElement('div');
        el.className = 'chat-typing';
        el.innerHTML = '<span class="chat-typing-label">NEURALJAM</span><span class="chat-typing-dots"><span></span><span></span><span></span></span>';
        container.appendChild(el);
        container.scrollTop = container.scrollHeight;
        return el;
    },

    // NOTA: playAnalysisSegment fue removido — el reproductor del análisis ahora
    // es un WaveSurfer con regiones clicables (ver _initAnalysisWavesurfer).

    openAnalysisDb() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('pianostudy', 1);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('analysis_audio')) {
                    db.createObjectStore('analysis_audio', { keyPath: 'id' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    },

    async persistCurrentAnalysisAudio() {
        if (!this.currentAnalysis || !(this.currentAnalysisAudioBlob instanceof Blob)) return;
        const id = Number(this.currentAnalysis.timestamp);
        if (!Number.isFinite(id)) return;

        try {
            const db = await this.openAnalysisDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction('analysis_audio', 'readwrite');
                const store = tx.objectStore('analysis_audio');
                store.put({ id, blob: this.currentAnalysisAudioBlob });
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });
            db.close();
        } catch (e) {
            console.error('Error saving analysis audio to IndexedDB:', e);
        }
    },

    async loadAnalysisAudioFromDb(timestamp) {
        const id = Number(timestamp);
        if (!Number.isFinite(id)) return null;

        try {
            const db = await this.openAnalysisDb();
            const record = await new Promise((resolve, reject) => {
                const tx = db.transaction('analysis_audio', 'readonly');
                const store = tx.objectStore('analysis_audio');
                const req = store.get(id);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            db.close();
            return record?.blob instanceof Blob ? record.blob : null;
        } catch (e) {
            console.error('Error loading analysis audio from IndexedDB:', e);
            return null;
        }
    },

    async deleteAnalysisAudioFromDb(timestamp) {
        const id = Number(timestamp);
        if (!Number.isFinite(id)) return;

        try {
            const db = await this.openAnalysisDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction('analysis_audio', 'readwrite');
                const store = tx.objectStore('analysis_audio');
                store.delete(id);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });
            db.close();
        } catch (e) {
            console.error('Error deleting analysis audio from IndexedDB:', e);
        }
    },

    exportAnalysisPDF() {
        if (!this.currentAnalysis) return;

        const { recordingName, aiAnalysis, audioAnalysis } = this.currentAnalysis;

        // Construimos secciones opcionalmente para no dejar títulos vacíos
        // cuando el modelo no devolvió ese campo (igual que la UI, que oculta
        // las secciones sin datos con .hidden).
        const sections = [];

        sections.push('ANÁLISIS DE INTERPRETACIÓN MUSICAL');
        sections.push('');
        sections.push(`Grabación: ${recordingName || '—'}`);
        sections.push(`Duración: ${(audioAnalysis?.duration || 0).toFixed(1)}s`);

        if (aiAnalysis.musicalAnalysis) {
            sections.push('');
            sections.push('ANÁLISIS MUSICAL:');
            sections.push(aiAnalysis.musicalAnalysis);
        }

        const strengths = Array.isArray(aiAnalysis.strengths) ? aiAnalysis.strengths : [];
        if (strengths.length) {
            sections.push('');
            sections.push('ASPECTOS POSITIVOS:');
            strengths.forEach((s, i) => sections.push(`${i + 1}. ${s}`));
        }

        const observations = Array.isArray(aiAnalysis.observations) ? aiAnalysis.observations : [];
        if (observations.length) {
            sections.push('');
            sections.push('ÁREAS DE MEJORA:');
            observations.forEach((o, i) => {
                sections.push(`${i + 1}. Hecho: ${o.fact || '—'}`);
                if (o.interpretation) sections.push(`   Interpretación: ${o.interpretation}`);
                if (o.recommendation) sections.push(`   Recomendación: ${o.recommendation}`);
                if (o.confidence) sections.push(`   Confianza: ${o.confidence}`);
            });
        }

        if (aiAnalysis.primaryFocus) {
            sections.push('');
            sections.push('TU FOCO PRINCIPAL:');
            sections.push(aiAnalysis.primaryFocus);
        }

        const moments = Array.isArray(aiAnalysis.moments) ? aiAnalysis.moments : [];
        if (moments.length) {
            sections.push('');
            sections.push('MOMENTOS DESTACADOS:');
            const fmt = (t) => {
                const s = Math.max(0, Math.floor(Number(t) || 0));
                return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
            };
            moments.forEach((m) => {
                const range = `[${fmt(m.timeStart)}-${fmt(m.timeEnd)}]`;
                const kindLabel = m.kind === 'good' ? '+' : m.kind === 'improve' ? '!' : '·';
                sections.push(`${kindLabel} ${range} ${m.note || ''}`);
            });
        }

        const ex = aiAnalysis.practiceExercise;
        if (ex && (ex.title || ex.description || (Array.isArray(ex.steps) && ex.steps.length))) {
            sections.push('');
            sections.push('EJERCICIO DE PRÁCTICA:');
            const dur = Number(ex.durationMin);
            const header = Number.isFinite(dur) && dur > 0
                ? `${ex.title || 'Ejercicio'} (${dur} min)`
                : (ex.title || 'Ejercicio');
            sections.push(header);
            if (Array.isArray(ex.steps) && ex.steps.length) {
                ex.steps.forEach((step, i) => sections.push(`  ${i + 1}. ${step}`));
            } else if (ex.description) {
                sections.push(ex.description);
            }
            if (ex.checkQuestion) {
                sections.push(`Comprobación: ${ex.checkQuestion}`);
            }
        }

        if (aiAnalysis.nextGoal) {
            sections.push('');
            sections.push('PRÓXIMO OBJETIVO:');
            sections.push(aiAnalysis.nextGoal);
        }

        if (aiAnalysis.metacognitiveQuestion) {
            sections.push('');
            sections.push('PREGUNTA PARA VOS:');
            sections.push(aiAnalysis.metacognitiveQuestion);
        }

        if (aiAnalysis.beliefVsDetection) {
            sections.push('');
            sections.push('LO QUE CREÍSTE vs. LO QUE SE ESCUCHÓ:');
            sections.push(aiAnalysis.beliefVsDetection);
        }

        const content = sections.join('\n');

        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${sanitizeFileName(`analisis_${recordingName || 'grabacion'}`)}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        this.showNotification('Análisis exportado como texto (.txt)', 'success');
    },

    async initAudioContext() {
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 256;

            await this.refreshAudioDevices();
            this.startVisualization();

            // Mic OFF por defecto — el usuario lo activa explícitamente con #mic-toggle-btn
            // (o queda activado automáticamente al pulsar Grabar).
            this._updateMicToggleUI(false);
        } catch (error) {
            console.error('Error initializing audio context:', error);
        }
    },

    async toggleMic() {
        if (this.currentStream) {
            // Desactivar mic.
            try { this.currentStream.getTracks().forEach(t => t.stop()); } catch { /* noop */ }
            this.currentStream = null;
            if (this.microphone) { try { this.microphone.disconnect(); } catch { /* noop */ } this.microphone = null; }
            this._updateMicToggleUI(false);
            return;
        }
        const deviceId = document.getElementById('audio-device')?.value || '';
        await this.selectAudioDevice(deviceId);
        this._updateMicToggleUI(!!this.currentStream);
    },

    _updateMicToggleUI(active) {
        const btn = document.getElementById('mic-toggle-btn');
        if (!btn) return;
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        btn.classList.toggle('is-active', !!active);
        btn.innerHTML = active
            ? '<i class="fas fa-microphone"></i> Micrófono ON'
            : '<i class="fas fa-microphone-slash"></i> Activar micrófono';
    },

    async refreshAudioDevices() {
        try {
            // Primero solicitar permiso para acceder a los dispositivos
            await navigator.mediaDevices.getUserMedia({ audio: true })
                .then(stream => {
                    stream.getTracks().forEach(track => track.stop());
                });
            
            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioInputs = devices.filter(device => device.kind === 'audioinput');
            
            const select = document.getElementById('audio-device');
            select.innerHTML = '<option value="">Usar dispositivo por defecto</option>';
            
            audioInputs.forEach((device, index) => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.text = device.label || `Micrófono ${index + 1}`;
                select.appendChild(option);
            });
        } catch (error) {
            console.error('Error refreshing audio devices:', error);
            // Si hay error, al menos mostrar opción por defecto
            const select = document.getElementById('audio-device');
            select.innerHTML = '<option value="">Usar dispositivo por defecto</option>';
        }
    },

    async selectAudioDevice(deviceId) {
        if (this.currentStream) {
            this.currentStream.getTracks().forEach(track => track.stop());
            this.currentStream = null;
        }

        // deviceId vacío/undefined = usar micrófono por defecto.
        const audio = {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
        };
        if (deviceId) audio.deviceId = { exact: deviceId };

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio });
            
            if (this.microphone) {
                this.microphone.disconnect();
            }

            this.currentStream = stream;
            
            this.microphone = this.audioContext.createMediaStreamSource(stream);
            this.microphone.connect(this.analyser);
        } catch (error) {
            console.error('Error selecting audio device:', error);
        }
    },

    async toggleRecording() {
        if (this.isPlaying) {
            this.showNotification('Detén la reproducción antes de grabar', 'info');
            return;
        }

        if (this.isRecording) {
            this.stopRecording();
        } else {
            await this.startRecording();
        }
    },

    // ─── Fuente de entrada (audio | midi) ────────────────────────────────────
    // Wirea el selector Audio/MIDI del sección Grabar. Se llama una sola vez
    // desde bindEvents. El estado vive en this._inputSource ('audio' default).
    _initInputSourceUi() {
        if (this._inputSourceUiWired) return;
        this._inputSourceUiWired = true;
        this._inputSource = 'audio';

        const radios = document.querySelectorAll('input[name="input-source"]');
        radios.forEach(r => {
            r.addEventListener('change', (e) => {
                if (e.target.checked) this._setInputSource(e.target.value);
            });
        });

        document.getElementById('midi-refresh-btn')?.addEventListener('click', () => {
            this._refreshMidiDevices();
        });
    },

    _setInputSource(mode) {
        this._inputSource = mode === 'midi' ? 'midi' : 'audio';
        const audioRow = document.getElementById('audio-device-row');
        const midiRow = document.getElementById('midi-device-row');
        if (audioRow) audioRow.hidden = this._inputSource === 'midi';
        if (midiRow) midiRow.hidden = this._inputSource !== 'midi';
        if (this._inputSource === 'midi') this._refreshMidiDevices();
    },

    async _refreshMidiDevices() {
        const select = document.getElementById('midi-device');
        const statusEl = document.getElementById('midi-status');
        if (!select) return;
        try {
            if (!this._midiRecorder) this._midiRecorder = new MidiRecorder();
            await this._midiRecorder.requestAccess();
            const inputs = this._midiRecorder.listInputs();
            select.innerHTML = inputs.length
                ? inputs.map(i => `<option value="${escapeHtml(i.id)}">${escapeHtml(i.name)}</option>`).join('')
                : '<option value="">Ningún teclado detectado</option>';
            if (statusEl) {
                statusEl.textContent = inputs.length
                    ? `${inputs.length} dispositivo${inputs.length > 1 ? 's' : ''} MIDI`
                    : 'Conectá tu teclado y volvé a pulsar Detectar';
                statusEl.className = 'midi-status' + (inputs.length ? ' is-ok' : '');
            }
        } catch (err) {
            console.error('Web MIDI access denegado o no soportado:', err);
            if (statusEl) {
                statusEl.textContent = 'MIDI no disponible (probá Chrome/Edge)';
                statusEl.className = 'midi-status is-error';
            }
        }
    },

    async _startMidiRecording() {
        try {
            if (!this._midiRecorder) this._midiRecorder = new MidiRecorder();
            if (!this._midiRecorder.access) await this._midiRecorder.requestAccess();
            const inputId = document.getElementById('midi-device')?.value || null;
            this._midiRecorder.startRecording(inputId);
            this.isRecording = true;
            this.recordingStartTime = Date.now();
            document.getElementById('recording-indicator').classList.remove('hidden');
            this.startRecordingTimer();
            const recordBtn = document.getElementById('record-btn');
            recordBtn.classList.add('recording');
            recordBtn.innerHTML = '<i class="fas fa-stop"></i> Detener';
            document.getElementById('stop-btn').disabled = false;
        } catch (err) {
            console.error('Error iniciando grabación MIDI:', err);
            this.showNotification(err?.message || 'No pude iniciar la grabación MIDI', 'error');
        }
    },

    async _stopMidiRecording() {
        if (!this._midiRecorder) return;
        try {
            const result = await this._midiRecorder.stopRecording();
            if (!result || !result.blob) {
                this.showNotification('La grabación MIDI quedó vacía (¿tocaste alguna nota?)', 'info');
                return;
            }
            this.currentRecording = result.blob;
            const analyzeBtn = document.getElementById('analyze-recording-btn');
            if (analyzeBtn) analyzeBtn.disabled = false;
            // Sin waveform: MIDI no es audio, así que ocultamos el review de onda
            // y mostramos un placeholder informativo.
            this._hideRecordReview();
            this._showMidiReviewSummary(result);
            await this.addToTempRecordings(result.blob, 'midi');
        } catch (err) {
            console.error('Error al detener grabación MIDI:', err);
            this.showNotification('Error al finalizar grabación MIDI', 'error');
        }
    },

    _showMidiReviewSummary({ duration, noteCount }) {
        const review = document.getElementById('record-review');
        if (!review) return;
        // Reutilizamos el contenedor de review pero sin WaveSurfer.
        review.classList.remove('hidden');
        const waveEl = document.getElementById('record-review-wave');
        if (waveEl) {
            waveEl.innerHTML = `<div class="midi-review-placeholder">
                <i class="fas fa-keyboard"></i>
                <span>Grabación MIDI · ${noteCount} notas · ${duration.toFixed(1)}s</span>
            </div>`;
        }
    },

    async startRecording() {
        // Si viene un review de la grabación anterior, ocultarlo y volver al monitor en vivo.
        this._hideRecordReview();

        // Rama MIDI: captura del teclado por Web MIDI en vez de MediaRecorder.
        if (this._inputSource === 'midi') {
            await this._startMidiRecording();
            return;
        }

        // Si el usuario no activó el mic explícitamente, activarlo aquí para que
        // el visualizador se mueva mientras graba.
        if (!this.currentStream) {
            const deviceId = document.getElementById('audio-device')?.value || '';
            await this.selectAudioDevice(deviceId);
            this._updateMicToggleUI(!!this.currentStream);
        }

        try {
            const deviceId = document.getElementById('audio-device').value;
            
            // Si no hay dispositivo seleccionado, intentar usar el dispositivo por defecto
            let audioConstraints = {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            };
            
            // Si hay un dispositivo específico seleccionado, usarlo
            if (deviceId) {
                audioConstraints.deviceId = { exact: deviceId };
            }

            const stream = await navigator.mediaDevices.getUserMedia({
                audio: audioConstraints
            });

            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                ? 'audio/webm;codecs=opus'
                : 'audio/webm';
            this.mediaRecorder = new MediaRecorder(stream, { mimeType });
            this.audioChunks = [];
            this.recordingStartTime = Date.now();

            this.mediaRecorder.ondataavailable = (event) => {
                this.audioChunks.push(event.data);
            };

            this.mediaRecorder.onstop = () => {
                const audioBlob = new Blob(this.audioChunks, { type: this.mediaRecorder.mimeType || 'audio/webm' });
                this.currentRecording = audioBlob;
                document.getElementById('play-btn').disabled = false;
                document.getElementById('cut-phrases-btn').disabled = false;
                const analyzeBtn = document.getElementById('analyze-recording-btn');
                if (analyzeBtn) analyzeBtn.disabled = false;

                // Convertir el visualizador en vivo en un WaveSurfer de la última grabación (scrubable).
                // El WaveSurfer del cuadro grande reemplaza al modal antiguo showRecordingList().
                this._showRecordReviewWave(audioBlob);

                // Agregar a la lista de grabaciones temporales
                this.addToTempRecordings(audioBlob);

                // Detener el contador de tiempo
                this.stopRecordingTimer();
            };

            this.mediaRecorder.start();
            this.isRecording = true;
            
            // Mostrar indicador de grabación
            document.getElementById('recording-indicator').classList.remove('hidden');
            
            // Iniciar contador de tiempo
            this.startRecordingTimer();
            
            const recordBtn = document.getElementById('record-btn');
            recordBtn.classList.add('recording');
            recordBtn.innerHTML = '<i class="fas fa-stop"></i> Detener';
            
            document.getElementById('stop-btn').disabled = false;
        } catch (error) {
            console.error('Error starting recording:', error);
            this.showNotification('Error al iniciar grabación. Verifica los permisos del micrófono.', 'error');
        }
    },

    _showRecordReviewWave(audioBlob, label = 'Última grabación') {
        const liveMonitor = document.getElementById('live-monitor');
        const review = document.getElementById('record-review');
        const waveEl = document.getElementById('record-review-wave');
        const timelineEl = document.getElementById('record-review-timeline');
        const timeEl = document.getElementById('record-review-time');
        const playBtn = document.getElementById('record-review-play');
        const loopBtn = document.getElementById('record-review-loop');
        const speedSlider = document.getElementById('record-review-speed');
        const speedLabel = document.getElementById('record-review-speed-label');
        const clearRegionBtn = document.getElementById('record-review-clear-region');
        const labelEl = review?.querySelector('.visualizer-label');
        if (!waveEl || !review || !liveMonitor || !audioBlob) return;
        if (labelEl) labelEl.textContent = label;

        // Limpiar review anterior si existía.
        this._destroyRecordReviewWs();

        // Pausar mini WS de la lista para que solo suene uno a la vez.
        this._tempWavesurfers?.forEach(ws => { try { if (ws.isPlaying?.()) ws.pause(); } catch { /* noop */ } });

        liveMonitor.classList.add('hidden');
        review.classList.remove('hidden');

        const url = this.createTrackedObjectURL(audioBlob);
        this._recordReviewObjectUrl = url;

        // Esperar al reflow: si el contenedor pasó de display:none a visible, WaveSurfer
        // necesita que #record-review-wave ya tenga clientWidth > 0 antes de crearse,
        // si no pinta una onda de ancho 0 y no se ve nada.
        requestAnimationFrame(() => {
            waveEl.innerHTML = '';
            if (timelineEl) timelineEl.innerHTML = '';

            const regionsPlugin = RegionsPlugin.create();
            const hoverPlugin = HoverPlugin.create({
                lineColor: '#3ba869',
                lineWidth: 2,
                labelBackground: 'rgba(59, 168, 105, 0.9)',
                labelColor: '#fff',
                labelSize: '11px',
            });
            const plugins = [regionsPlugin, hoverPlugin];
            if (timelineEl) plugins.push(TimelinePlugin.create({ container: timelineEl, height: 14 }));

            let ws;
            try {
                ws = WaveSurfer.create({
                    container: waveEl,
                    url,
                    waveColor: 'rgba(59, 168, 105, 0.55)',
                    progressColor: '#3ba869',
                    cursorColor: '#00ff41',
                    cursorWidth: 1,
                    height: 96,
                    barWidth: 2,
                    barGap: 1,
                    barRadius: 2,
                    normalize: true,
                    plugins,
                });
            } catch (e) {
                console.error('Record review WaveSurfer create error:', e);
                this.showNotification('No se pudo cargar la grabación en el visualizador', 'error');
                return;
            }

            // Estado local para region/loop/velocidad.
            const state = {
                region: null,
                loop: loopBtn?.getAttribute('aria-pressed') === 'true',
                rate: Number(speedSlider?.value) || 1,
            };
            this._recordReviewState = state;

            const setTime = (cur) => {
                if (!timeEl) return;
                const total = ws.getDuration();
                timeEl.textContent = `${this._formatWaveTime(cur)} / ${this._formatWaveTime(total)}`;
            };

            ws.on('play',   () => playBtn && (playBtn.querySelector('i').className = 'fas fa-pause'));
            ws.on('pause',  () => playBtn && (playBtn.querySelector('i').className = 'fas fa-play'));
            ws.on('finish', () => { if (playBtn) playBtn.querySelector('i').className = 'fas fa-play'; setTime(0); });
            ws.on('audioprocess', (t) => {
                setTime(t);
                // Región SIEMPRE limita cuando existe (solo se escucha lo seleccionado).
                // Loop controla si al llegar al final se repite (región o toda la pista).
                if (state.region && t >= state.region.end) {
                    if (state.loop) ws.setTime(state.region.start);
                    else { ws.pause(); ws.setTime(state.region.start); }
                } else if (!state.region && state.loop) {
                    const total = ws.getDuration();
                    if (total && t >= total - 0.05) ws.setTime(0);
                }
            });
            ws.on('ready', () => {
                setTime(0);
                try { ws.setPlaybackRate(state.rate, true); } catch { /* noop */ }
            });
            ws.on('error', (err) => {
                console.error('Record review WaveSurfer load error:', err);
                this.showNotification('Error al decodificar el audio', 'error');
            });

            // Selección con drag: crea una región (verde translúcido). Solo una región activa a la vez.
            regionsPlugin.enableDragSelection({
                color: 'rgba(59, 168, 105, 0.20)',
            });
            const setActiveRegion = (region) => {
                if (state.region && state.region !== region) {
                    try { state.region.remove(); } catch { /* noop */ }
                }
                state.region = region;
                if (clearRegionBtn) clearRegionBtn.disabled = !region;
            };
            regionsPlugin.on('region-created', (region) => setActiveRegion(region));
            regionsPlugin.on('region-updated', (region) => { state.region = region; });
            regionsPlugin.on('region-clicked', (region, e) => {
                e?.stopPropagation?.();
                ws.setTime(region.start);
                ws.play();
            });

            // Play/Pause principal: si hay región y no estás dentro, arranca desde su inicio.
            if (playBtn) {
                playBtn.onclick = () => {
                    try {
                        if (ws.isPlaying()) {
                            ws.pause();
                            return;
                        }
                        // Si hay región y el cursor está fuera, saltar al inicio de la región.
                        if (state.region) {
                            const now = ws.getCurrentTime();
                            if (now < state.region.start || now >= state.region.end) {
                                ws.setTime(state.region.start);
                            }
                        }
                        ws.play();
                    } catch { /* noop */ }
                };
            }

            // Toggle Loop.
            if (loopBtn) {
                loopBtn.onclick = () => {
                    state.loop = !state.loop;
                    loopBtn.setAttribute('aria-pressed', state.loop ? 'true' : 'false');
                    loopBtn.classList.toggle('is-active', state.loop);
                };
            }

            // Velocidad.
            const applyRate = (r) => {
                state.rate = r;
                if (speedSlider) speedSlider.value = String(r);
                if (speedLabel) speedLabel.textContent = `${r.toFixed(2)}x`;
                try { ws.setPlaybackRate(r, true); } catch { /* noop */ }
            };
            if (speedSlider) {
                speedSlider.oninput = () => applyRate(Number(speedSlider.value) || 1);
                if (speedLabel) speedLabel.textContent = `${state.rate.toFixed(2)}x`;
            }
            const speedResetBtn = document.getElementById('record-review-speed-reset');
            if (speedResetBtn) {
                speedResetBtn.onclick = () => applyRate(1);
            }

            // Limpiar selección.
            if (clearRegionBtn) {
                clearRegionBtn.onclick = () => {
                    if (state.region) {
                        try { state.region.remove(); } catch { /* noop */ }
                        state.region = null;
                    }
                    clearRegionBtn.disabled = true;
                };
                clearRegionBtn.disabled = true;
            }

            this._recordReviewWs = ws;
            this._recordReviewRegions = regionsPlugin;
        });
    },

    _destroyRecordReviewWs() {
        if (this._recordReviewWs) {
            try { this._recordReviewWs.destroy(); } catch { /* noop */ }
            this._recordReviewWs = null;
        }
        if (this._recordReviewObjectUrl) {
            this.cleanupObjectURL(this._recordReviewObjectUrl);
            this._recordReviewObjectUrl = null;
        }
        this._recordReviewRegions = null;
        this._recordReviewState = null;

        // Reset UI state de los controles del cuadro grande.
        const loopBtn = document.getElementById('record-review-loop');
        const speedSlider = document.getElementById('record-review-speed');
        const speedLabel = document.getElementById('record-review-speed-label');
        const clearRegionBtn = document.getElementById('record-review-clear-region');
        if (loopBtn) {
            loopBtn.setAttribute('aria-pressed', 'false');
            loopBtn.classList.remove('is-active');
            loopBtn.onclick = null;
        }
        if (speedSlider) {
            speedSlider.value = '1';
            speedSlider.oninput = null;
        }
        if (speedLabel) speedLabel.textContent = '1.00x';
        if (clearRegionBtn) {
            clearRegionBtn.disabled = true;
            clearRegionBtn.onclick = null;
        }
        const speedResetBtn = document.getElementById('record-review-speed-reset');
        if (speedResetBtn) speedResetBtn.onclick = null;
    },

    _hideRecordReview() {
        this._destroyRecordReviewWs();
        const liveMonitor = document.getElementById('live-monitor');
        const review = document.getElementById('record-review');
        const timeEl = document.getElementById('record-review-time');
        const playBtn = document.getElementById('record-review-play');
        if (review) review.classList.add('hidden');
        if (liveMonitor) liveMonitor.classList.remove('hidden');
        if (timeEl) timeEl.textContent = '0:00 / 0:00';
        if (playBtn) {
            const icon = playBtn.querySelector('i');
            if (icon) icon.className = 'fas fa-play';
        }
    },

    stopRecording() {
        // Track study time and recordings
        const durationSec = this.recordingStartTime
            ? Math.max(0, Math.floor((Date.now() - this.recordingStartTime) / 1000))
            : 0;

        // Rama MIDI: no hay MediaRecorder que parar, delegamos al recorder MIDI.
        if (this._inputSource === 'midi') {
            this._stopMidiRecording();
        } else if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
            this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
        }

        this.isRecording = false;
        
        // Ocultar indicador de grabación
        document.getElementById('recording-indicator').classList.add('hidden');
        
        const recordBtn = document.getElementById('record-btn');
        recordBtn.classList.remove('recording');
        recordBtn.innerHTML = '<i class="fas fa-circle"></i> Grabar';

        // Progress tracking
        if (durationSec > 0) {
            this.progressTracker.addStudyTime(durationSec);
            this.progressTracker.incrementRecordings();
            this.progressTracker.checkAndUpdateStreak();
            this.checkBadgeUpgrades();
        }
    },

    startRecordingTimer() {
        this.recordingTimer = setInterval(() => {
            const elapsed = Date.now() - this.recordingStartTime;
            const seconds = Math.floor(elapsed / 1000);
            const minutes = Math.floor(seconds / 60);
            const displaySeconds = seconds % 60;
            
            const timeString = `${minutes.toString().padStart(2, '0')}:${displaySeconds.toString().padStart(2, '0')}`;
            document.getElementById('recording-time').textContent = timeString;
        }, 100);
    },

    stopRecordingTimer() {
        if (this.recordingTimer) {
            clearInterval(this.recordingTimer);
            this.recordingTimer = null;
        }
    },

    async loadRecordingsFromServer() {
        if (!this.getActiveUsername()) return;
        const { data, error } = await loadRecordingsFromDB();
        if (error) {
            console.error('loadRecordingsFromDB error:', error);
            return;
        }
        const localBlobs = {};
        this.tempRecordings.forEach(r => { if (r.blob) localBlobs[r.id] = r.blob; });
        this.tempRecordings = (data || []).map(r => ({
            id: r.id,
            name: r.name,
            blob: localBlobs[r.id] || null,
            duration: r.duration,
            createdAt: r.created_at || null,
            filePath: r.file_path,
            format: r.format || (String(r.file_path || '').endsWith('.mid') ? 'midi' : 'audio'),
            uploading: false
        }));
        this.updateTempRecordingsList();
    },

    async addToTempRecordings(audioBlob, format = 'audio') {
        if (!this.getActiveUsername()) {
            this.updateTempRecordingsList();
            return;
        }
        const duration = Math.floor((Date.now() - this.recordingStartTime) / 1000);
        const kindLabel = format === 'midi' ? 'MIDI' : 'Grabación';
        const name = `${kindLabel} ${new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`;

        // Keep a local blob reference for immediate playback
        const localRec = {
            id: `local-${Date.now()}`,
            name,
            blob: audioBlob,
            duration,
            filePath: null,
            format,
            createdAt: new Date().toISOString(),
            uploading: true
        };
        this.tempRecordings.unshift(localRec);
        this.updateTempRecordingsList();

        const { data, error } = await uploadRecording(audioBlob, name, duration, format);
        if (error) {
            console.error('uploadRecording error:', error);
            localRec.uploading = false;
            localRec.uploadError = true;
            this.updateTempRecordingsList();
            this.showNotification('Error al subir grabación. Se guardó localmente.', 'error');
            return;
        }
        // Replace local entry with server record
        const idx = this.tempRecordings.indexOf(localRec);
        if (idx !== -1) {
            this.tempRecordings[idx] = {
                id: data.id,
                name: data.name,
                blob: audioBlob,
                duration: data.duration,
                filePath: data.file_path,
                format: data.format || format,
                createdAt: data.created_at || localRec.createdAt,
                uploading: false
            };
        }
        this.updateTempRecordingsList();
        this.showNotification('Grabación guardada', 'success');
    },

    updateTempRecordingsList() {
        const container = document.getElementById('temp-recordings');
        const deleteAllBtn = document.getElementById('temp-delete-all-btn');
        const paginationEl = document.getElementById('temp-pagination');
        const countEl = document.getElementById('temp-filter-count');
        const filterFromEl = document.getElementById('temp-filter-from');
        const filterToEl = document.getElementById('temp-filter-to');

        this._destroyTempWavesurfers();

        if (!this.getActiveUsername()) {
            container.innerHTML = `<div class="auth-required-banner">
                <p>Inicia sesión para guardar tu progreso</p>
                <button class="auth-header-btn auth-header-btn--primary" onclick="document.getElementById('auth-open-login')?.click()">Ingresar</button>
            </div>`;
            if (deleteAllBtn) deleteAllBtn.style.display = 'none';
            if (paginationEl) paginationEl.innerHTML = '';
            if (countEl) countEl.textContent = '';
            return;
        }

        // Sincroniza los inputs de fecha con el estado (por si el render viene de otro origen).
        if (filterFromEl && filterFromEl.value !== (this._tempFilterFrom || '')) {
            filterFromEl.value = this._tempFilterFrom || '';
        }
        if (filterToEl && filterToEl.value !== (this._tempFilterTo || '')) {
            filterToEl.value = this._tempFilterTo || '';
        }

        const filtered = this._getFilteredTempRecordings();
        const total = filtered.length;
        const pageSize = this._tempPageSize || 8;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        if (this._tempPage > totalPages) this._tempPage = totalPages;
        if (this._tempPage < 1) this._tempPage = 1;
        const start = (this._tempPage - 1) * pageSize;
        const pageItems = filtered.slice(start, start + pageSize);

        // "Borrar todas" sigue afectando a todas las grabaciones (no al filtro).
        if (deleteAllBtn) deleteAllBtn.style.display = this.tempRecordings.length > 0 ? '' : 'none';

        // Contador visible con estado del filtro.
        if (countEl) {
            const hasFilter = this._tempFilterFrom || this._tempFilterTo;
            if (this.tempRecordings.length === 0) {
                countEl.textContent = '';
            } else if (hasFilter) {
                countEl.textContent = `${total} de ${this.tempRecordings.length} grabaciones`;
            } else {
                countEl.textContent = `${total} ${total === 1 ? 'grabación' : 'grabaciones'}`;
            }
        }

        if (total === 0) {
            const hasFilter = this._tempFilterFrom || this._tempFilterTo;
            container.innerHTML = hasFilter
                ? '<p class="no-recordings">No hay grabaciones en el rango seleccionado</p>'
                : '<p class="no-recordings">No hay grabaciones aún</p>';
            if (paginationEl) paginationEl.innerHTML = '';
            return;
        }

        container.innerHTML = pageItems.map(recording => {
            const isMidi = recording.format === 'midi'
                || (recording.filePath && String(recording.filePath).endsWith('.mid'));
            const hasAudio = !isMidi && !!(recording.blob || recording.filePath);
            const wavePlayer = hasAudio ? `
                <div class="temp-wave-player">
                    <div class="temp-wave" data-temp-wave-container data-id="${recording.id}"></div>
                    <span class="temp-wave-time" data-temp-wave-time data-id="${recording.id}">0:00 / 0:00</span>
                </div>` : '';
            const midiBadge = isMidi ? ' <span class="format-badge format-badge--midi" title="Grabación MIDI"><i class="fas fa-keyboard"></i> MIDI</span>' : '';
            const createdLabel = this._formatCreatedAt(recording.createdAt);
            return `
            <div class="recording-item${recording.uploading ? ' uploading' : ''}${isMidi ? ' is-midi' : ''}">
                <div class="recording-item-header">
                    <div class="recording-info">
                        <div class="recording-name">${escapeHtml(recording.name)}${midiBadge}${recording.uploading ? ' <span class="upload-badge"><i class="fas fa-cloud-upload-alt"></i></span>' : ''}</div>
                        <div class="recording-duration">${this.formatDuration(recording.duration)}</div>
                        ${createdLabel ? `<div class="recording-created"><i class="fas fa-calendar-alt"></i> ${createdLabel}</div>` : ''}
                    </div>
                    <div class="recording-actions">
                        <button class="btn-small" data-action="temp-play" data-id="${recording.id}" ${(!hasAudio || isMidi) ? 'disabled' : ''} title="Reproducir">
                            <i class="fas fa-play"></i>
                        </button>
                        <button class="btn-small" data-action="temp-stop" data-id="${recording.id}" ${isMidi ? 'disabled' : ''} title="Detener">
                            <i class="fas fa-stop"></i>
                        </button>
                        <button class="btn-small" data-action="temp-expand" data-id="${recording.id}" ${(!hasAudio || isMidi) ? 'disabled' : ''} title="Abrir en el reproductor grande">
                            <i class="fas fa-expand"></i>
                        </button>
                        <button class="btn-small" data-action="temp-edit" data-id="${recording.id}" ${isMidi ? 'disabled' : ''} title="Cortar frases (solo audio)">
                            <i class="fas fa-cut"></i>
                        </button>
                        <button class="btn-small btn-danger" data-action="temp-delete" data-id="${recording.id}" ${recording.uploading ? 'disabled' : ''} title="Eliminar">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
                ${wavePlayer}
            </div>
        `;
        }).join('');

        this._renderTempPagination(totalPages);
        this._initTempWavesurfers();
        this._refreshTempDatePickers();
    },

    _getFilteredTempRecordings() {
        const from = this._tempFilterFrom ? new Date(this._tempFilterFrom + 'T00:00:00') : null;
        // "Hasta" inclusive: sumamos 1 día y comparamos <.
        const to = this._tempFilterTo ? new Date(this._tempFilterTo + 'T00:00:00') : null;
        const toExclusive = to ? new Date(to.getTime() + 24 * 60 * 60 * 1000) : null;
        if (!from && !toExclusive) return this.tempRecordings.slice();
        return this.tempRecordings.filter(r => {
            if (!r.createdAt) return false;
            const t = new Date(r.createdAt).getTime();
            if (Number.isNaN(t)) return false;
            if (from && t < from.getTime()) return false;
            if (toExclusive && t >= toExclusive.getTime()) return false;
            return true;
        });
    },

    _formatCreatedAt(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        const date = d.toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' });
        const time = d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
        return `${date} · ${time}`;
    },

    _renderTempPagination(totalPages) {
        const el = document.getElementById('temp-pagination');
        if (!el) return;
        if (totalPages <= 1) { el.innerHTML = ''; return; }

        const current = this._tempPage;
        // Ventana compacta con elipsis: primero, current-1, current, current+1, último.
        const pages = new Set([1, totalPages, current - 1, current, current + 1]);
        const sorted = [...pages].filter(p => p >= 1 && p <= totalPages).sort((a, b) => a - b);

        let html = '';
        html += `<button type="button" class="temp-page-btn" data-action="temp-page" data-page="${current - 1}" ${current === 1 ? 'disabled' : ''} aria-label="Página anterior">‹</button>`;
        let prev = 0;
        for (const p of sorted) {
            if (p - prev > 1) html += `<span class="temp-page-ellipsis">…</span>`;
            html += `<button type="button" class="temp-page-btn ${p === current ? 'active' : ''}" data-action="temp-page" data-page="${p}">${p}</button>`;
            prev = p;
        }
        html += `<button type="button" class="temp-page-btn" data-action="temp-page" data-page="${current + 1}" ${current === totalPages ? 'disabled' : ''} aria-label="Página siguiente">›</button>`;
        el.innerHTML = html;
    },

    setTempFilter({ from, to } = {}) {
        this._tempFilterFrom = from || null;
        this._tempFilterTo = to || null;
        this._tempPage = 1;
        this.updateTempRecordingsList();
    },

    clearTempFilter() {
        if (this._tempFilterFromPicker) this._tempFilterFromPicker.clear();
        if (this._tempFilterToPicker) this._tempFilterToPicker.clear();
        const fromEl = document.getElementById('temp-filter-from');
        const toEl = document.getElementById('temp-filter-to');
        if (fromEl) fromEl.value = '';
        if (toEl) toEl.value = '';
        this.setTempFilter({ from: null, to: null });
    },

    _tempRecordingDatesSet() {
        // Devuelve un Set de fechas "YYYY-MM-DD" (hora local) para las que hay al menos una grabación.
        const s = new Set();
        (this.tempRecordings || []).forEach(r => {
            if (!r.createdAt) return;
            const d = new Date(r.createdAt);
            if (Number.isNaN(d.getTime())) return;
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            s.add(key);
        });
        return s;
    },

    _refreshTempDatePickers() {
        // Fuerza a Flatpickr a re-pintar los días para que los puntos de "día con grabación" se actualicen.
        this._tempFilterFromPicker?.redraw();
        this._tempFilterToPicker?.redraw();
    },

    initTempDatePickers() {
        const fromEl = document.getElementById('temp-filter-from');
        const toEl = document.getElementById('temp-filter-to');
        if (!fromEl || !toEl) return;

        // Si ya existían (re-init), destrúyelos.
        this._tempFilterFromPicker?.destroy();
        this._tempFilterToPicker?.destroy();

        const commonOpts = {
            locale: Spanish,
            dateFormat: 'Y-m-d',
            disableMobile: true, // Usa siempre el UI de Flatpickr, no el picker nativo del móvil.
            onDayCreate: (_dObj, _dStr, _fp, dayElem) => {
                const dates = this._tempRecordingDatesSet();
                const dt = dayElem.dateObj;
                if (!dt) return;
                const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
                if (dates.has(key)) {
                    dayElem.classList.add('has-recording');
                    dayElem.setAttribute('title', 'Hay grabación este día');
                }
            },
        };

        this._tempFilterFromPicker = flatpickr(fromEl, {
            ...commonOpts,
            onChange: (selectedDates, dateStr) => {
                this.setTempFilter({ from: dateStr || null, to: this._tempFilterTo });
                if (this._tempFilterToPicker && selectedDates[0]) {
                    this._tempFilterToPicker.set('minDate', selectedDates[0]);
                }
            },
        });

        this._tempFilterToPicker = flatpickr(toEl, {
            ...commonOpts,
            onChange: (selectedDates, dateStr) => {
                this.setTempFilter({ from: this._tempFilterFrom, to: dateStr || null });
                if (this._tempFilterFromPicker && selectedDates[0]) {
                    this._tempFilterFromPicker.set('maxDate', selectedDates[0]);
                }
            },
        });
    },

    setTempPage(page) {
        const p = Number(page);
        if (!Number.isFinite(p) || p < 1) return;
        this._tempPage = p;
        this.updateTempRecordingsList();
    },

    async expandTempRecording(id) {
        const recording = this.tempRecordings.find(r => String(r.id) === String(id));
        if (!recording) return;

        // Si no hay blob local, descargar desde el server.
        if (!(recording.blob instanceof Blob) && recording.filePath) {
            try {
                const url = getRecordingPublicUrl(recording.filePath);
                if (!url) throw new Error('No URL');
                this.showNotification('Cargando grabación…', 'info');
                const resp = await fetch(url);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                recording.blob = await resp.blob();
            } catch (e) {
                console.error('expandTempRecording download error:', e);
                this.showNotification('No se pudo cargar la grabación', 'error');
                return;
            }
        }

        if (!(recording.blob instanceof Blob)) {
            this.showNotification('El audio no está disponible', 'info');
            return;
        }

        this._showRecordReviewWave(recording.blob, recording.name);
        // Scroll suave hasta el reproductor grande para que la nueva onda quede a la vista.
        const review = document.getElementById('record-review');
        review?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },

    _formatWaveTime(secs) {
        const s = Math.max(0, Math.floor(Number(secs) || 0));
        const m = Math.floor(s / 60);
        const r = s % 60;
        return `${m}:${String(r).padStart(2, '0')}`;
    },

    _initTempWavesurfers() {
        // Instancia lazy: WaveSurfer solo por cada grabación cuando entra en viewport.
        // Reusa el patrón de licks (app-controllers.js:1290) para no descargar N audios de golpe.
        const container = document.getElementById('temp-recordings');
        if (!container) return;

        this._tempWavesurfers = new Map();
        this._tempWaveObjectUrls = new Map();

        this._tempWaveObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                const waveEl = entry.target;
                const id = waveEl.getAttribute('data-id');
                if (this._tempWavesurfers.has(id)) {
                    this._tempWaveObserver.unobserve(waveEl);
                    return;
                }
                const rec = this.tempRecordings.find(r => String(r.id) === String(id));
                if (!rec) return;

                let url;
                if (rec.blob instanceof Blob) {
                    url = this.createTrackedObjectURL(rec.blob);
                    this._tempWaveObjectUrls.set(id, url);
                } else if (rec.filePath) {
                    url = getRecordingPublicUrl(rec.filePath);
                }
                if (!url) return;

                const ws = WaveSurfer.create({
                    container: waveEl,
                    url,
                    waveColor: 'rgba(59, 168, 105, 0.55)',
                    progressColor: '#3ba869',
                    cursorColor: '#00ff41',
                    cursorWidth: 1,
                    height: 40,
                    barWidth: 2,
                    barGap: 1,
                    barRadius: 2,
                    normalize: true,
                });

                const playBtn = container.querySelector(`[data-action="temp-play"][data-id="${id}"] i`);
                const timeEl = container.querySelector(`[data-temp-wave-time][data-id="${id}"]`);
                const setTime = (cur) => {
                    if (!timeEl) return;
                    const total = ws.getDuration();
                    timeEl.textContent = `${this._formatWaveTime(cur)} / ${this._formatWaveTime(total)}`;
                };
                ws.on('play',  () => playBtn && (playBtn.className = 'fas fa-pause'));
                ws.on('pause', () => playBtn && (playBtn.className = 'fas fa-play'));
                ws.on('finish', () => {
                    if (playBtn) playBtn.className = 'fas fa-play';
                    setTime(0);
                });
                ws.on('audioprocess', (t) => setTime(t));
                ws.on('ready', () => setTime(0));

                this._tempWavesurfers.set(id, ws);
                this._tempWaveObserver.unobserve(waveEl);
            });
        }, { rootMargin: '150px' });

        container.querySelectorAll('[data-temp-wave-container]').forEach(el => {
            this._tempWaveObserver.observe(el);
        });
    },

    _destroyTempWavesurfers() {
        if (this._tempWaveObserver) {
            this._tempWaveObserver.disconnect();
            this._tempWaveObserver = null;
        }
        if (this._tempWavesurfers) {
            this._tempWavesurfers.forEach(ws => { try { ws.destroy(); } catch { /* noop */ } });
            this._tempWavesurfers.clear();
            this._tempWavesurfers = null;
        }
        if (this._tempWaveObjectUrls) {
            this._tempWaveObjectUrls.forEach(url => this.cleanupObjectURL(url));
            this._tempWaveObjectUrls.clear();
            this._tempWaveObjectUrls = null;
        }
    },

    playTempRecording(id) {
        const ws = this._tempWavesurfers?.get(String(id));
        if (ws) {
            // Pausa los demás para que solo suene uno a la vez.
            this._tempWavesurfers.forEach((other, k) => {
                if (k !== String(id) && other.isPlaying?.()) other.pause();
            });
            ws.playPause();
            return;
        }
        // Fallback: si el WS aún no se instanció (fuera de viewport), reproducir con Audio.
        const recording = this.tempRecordings.find(r => r.id === id);
        if (!recording) return;
        let url;
        let isObjectUrl = false;
        if (recording.blob instanceof Blob) {
            url = this.createTrackedObjectURL(recording.blob);
            isObjectUrl = true;
        } else if (recording.filePath) {
            url = getRecordingPublicUrl(recording.filePath);
        }
        if (!url) return;
        const audio = new Audio(url);
        audio.play();
        audio.onended = () => {
            if (isObjectUrl) this.cleanupObjectURL(url);
            recording.currentAudio = null;
        };
        recording.currentAudio = audio;
    },

    stopTempRecording(id) {
        const ws = this._tempWavesurfers?.get(String(id));
        if (ws) {
            try { ws.stop(); } catch { /* noop */ }
            return;
        }
        const recording = this.tempRecordings.find(r => r.id === id);
        if (recording && recording.currentAudio) {
            recording.currentAudio.pause();
            recording.currentAudio.currentTime = 0;
            recording.currentAudio = null;
        }
    },

    async editTempRecording(id) {
        const recording = this.tempRecordings.find(r => r.id === id);
        if (!recording) return;

        if (!recording.blob && recording.filePath) {
            this.showNotification('Descargando audio…', 'info');
            try {
                const url = getRecordingPublicUrl(recording.filePath);
                if (!url) throw new Error('No URL');
                const resp = await fetch(url);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                recording.blob = await resp.blob();
            } catch (e) {
                console.error('editTempRecording download error:', e);
                this.showNotification('No se pudo descargar el audio para editar', 'error');
                return;
            }
        }

        if (!recording.blob) {
            this.showNotification('El audio no está disponible para editar', 'info');
            return;
        }

        this.currentRecording = recording.blob;
        this.openPhraseEditor();
    },

    async deleteTempRecording(id) {
        const recording = this.tempRecordings.find(r => r.id === id);
        if (!recording) return;

        // If it's a local-only (upload failed) record, just remove from memory
        if (String(id).startsWith('local-') || !recording.filePath) {
            this.tempRecordings = this.tempRecordings.filter(r => r.id !== id);
            this.updateTempRecordingsList();
            return;
        }

        const { error } = await deleteRecording(id, recording.filePath);
        if (error) {
            this.showNotification(ERR_MSG, 'error');
            return;
        }
        this.tempRecordings = this.tempRecordings.filter(r => r.id !== id);
        this.updateTempRecordingsList();
        this.showNotification('Grabación eliminada', 'info');
    },

    async deleteAllTempRecordings() {
        if (this.tempRecordings.length === 0) return;
        if (!await this.showConfirm(`¿Borrar todas las ${this.tempRecordings.length} grabaciones temporales?`)) return;

        const toDelete = [...this.tempRecordings];
        for (const rec of toDelete) {
            if (!String(rec.id).startsWith('local-') && rec.filePath) {
                await deleteRecording(rec.id, rec.filePath);
            }
        }
        this.tempRecordings = [];
        this.updateTempRecordingsList();
        this.showNotification('Todas las grabaciones eliminadas', 'info');
    },

    playRecording() {
        if (!this.currentRecording) return;
        
        // Detener reproducción anterior si existe
        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio.currentTime = 0;
        }
        
        // Deshabilitar botón de grabar mientras se reproduce
        document.getElementById('record-btn').disabled = true;
        this.isPlaying = true;
        
        const url = this.createTrackedObjectURL(this.currentRecording);
        this.currentAudio = new Audio(url);
        this.currentAudio.play();

        this.currentAudio.onended = () => {
            this.cleanupObjectURL(url);
            document.getElementById('record-btn').disabled = false;
            this.isPlaying = false;
            document.getElementById('play-btn').disabled = false;
            document.getElementById('stop-btn').disabled = true;
        };
        
        this.currentAudio.onerror = () => {
            this.cleanupObjectURL(url);
            document.getElementById('record-btn').disabled = false;
            this.isPlaying = false;
            this.showNotification('Error al reproducir la grabación', 'error');
        };
    },

    stopPlayback() {
        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio.currentTime = 0;
            document.getElementById('record-btn').disabled = false;
            this.isPlaying = false;
        }
    },

    loadBackingTrack(event) {
        const file = event.target.files[0];
        if (file) {
            const url = this.createTrackedObjectURL(file);
            this.backingTrack = new Audio(url);
            this.backingTrack.onended = () => this.cleanupObjectURL(url);
        }
    },

    playBackingTrack() {
        if (this.backingTrack) {
            this.backingTrack.play();
        }
    },

    stopBackingTrack() {
        if (this.backingTrack) {
            this.backingTrack.pause();
            this.backingTrack.currentTime = 0;
        }
    },

    startVisualization() {
        if (!this.analyser) return;
        
        const canvas = document.getElementById('waveform');
        const ctx = canvas.getContext('2d');
        const bufferLength = this.analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        
        const draw = () => {
            requestAnimationFrame(draw);
            
            this.analyser.getByteTimeDomainData(dataArray);
            
            ctx.fillStyle = '#0a0a0a';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            
            ctx.lineWidth = 2;
            ctx.strokeStyle = '#00ff41';
            ctx.beginPath();
            
            const sliceWidth = canvas.width / bufferLength;
            let x = 0;
            
            for (let i = 0; i < bufferLength; i++) {
                const v = dataArray[i] / 128.0;
                const y = v * canvas.height / 2;
                
                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
                
                x += sliceWidth;
            }
            
            ctx.stroke();
            
            // Update level meters
            this.updateLevelMeters(dataArray);
        };
        
        draw();
    },

    updateLevelMeters(dataArray) {
        const leftLevel = document.getElementById('left-level');
        const rightLevel = document.getElementById('right-level');
        
        // Simple level calculation
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
            sum += Math.abs(dataArray[i] - 128);
        }
        const average = sum / dataArray.length;
        const percentage = Math.min(100, (average / 128) * 100);
        
        leftLevel.style.width = percentage + '%';
        rightLevel.style.width = percentage + '%';
    },

    showRecordingList() {
        const modalBody = document.getElementById('modal-body');
        modalBody.innerHTML = `
            <h3>Grabación Completada</h3>
            <p>¿Qué quieres hacer con esta grabación?</p>
            <div class="recording-options">
                <button class="btn-primary" data-action="recording-open-editor">
                    <i class="fas fa-cut"></i> Cortar Frases
                </button>
                <button class="btn-small" data-action="modal-close">
                    <i class="fas fa-times"></i> Cerrar
                </button>
            </div>
            <div class="recording-preview">
                <h4>Grabación actual:</h4>
                <audio controls data-src="current-recording"></audio>
            </div>
        `;
        
        document.getElementById('modal').classList.remove('hidden');

        const audioEl = document.querySelector('audio[data-src="current-recording"]');
        if (audioEl && this.currentRecording) {
            const url = this.createTrackedObjectURL(this.currentRecording);
            audioEl.src = url;
            audioEl.onended = () => this.cleanupObjectURL(url);
        }
    },

    openPhraseEditor() {
        if (!this.currentRecording) {
            this.showNotification('No hay grabación cargada para editar', 'info');
            return;
        }

        this._teardownPhraseEditor();
        this.selectedPhrases = this.selectedPhrases || [];

        const modalBody = document.getElementById('modal-body');
        modalBody.innerHTML = `
            <div class="phrase-editor">
                <h3 class="phrase-editor__title">Editor de frases</h3>
                <div class="phrase-editor__hint">
                    Arrastrá los bordes de la región para elegir el fragmento. La rueda del mouse hace zoom.
                </div>
                <div id="editor-waveform" class="phrase-editor__waveform"></div>
                <div id="editor-timeline" class="phrase-editor__timeline"></div>
                <div class="phrase-editor__transport">
                    <button class="btn-secondary" data-action="editor-toggle-play">
                        <i class="fas fa-play"></i>
                        <span data-role="editor-play-label">Play</span>
                    </button>
                    <button class="btn-secondary" data-action="editor-play-selection">
                        <i class="fas fa-crosshairs"></i> Reproducir selección
                    </button>
                    <label class="phrase-editor__loop">
                        <input type="checkbox" data-role="editor-loop-toggle" checked>
                        Loop selección
                    </label>
                    <span class="phrase-editor__time" data-role="editor-time">0:00.00 / 0:00.00</span>
                    <span class="phrase-editor__selection" data-role="editor-selection">Selección: —</span>
                </div>
                <div class="phrase-editor__add">
                    <input type="text" id="editor-phrase-name-input"
                        placeholder="Nombre (opcional — si lo dejás vacío se llama 'Frase N')" maxlength="60">
                    <button class="btn-primary" data-action="editor-add-phrase">
                        <i class="fas fa-plus"></i> Agregar frase
                    </button>
                </div>
                <div class="phrase-editor__list">
                    <h4>Frases seleccionadas</h4>
                    <div id="selected-phrases"></div>
                </div>
                <div class="phrase-editor__footer">
                    <button class="btn-primary" data-action="editor-save-licks">
                        <i class="fas fa-save"></i> Guardar en Licks
                    </button>
                    <button class="btn-secondary" data-action="modal-close">
                        <i class="fas fa-times"></i> Cerrar
                    </button>
                </div>
            </div>
        `;

        document.getElementById('modal').classList.remove('hidden');
        this.updatePhrasesList();

        const loopToggle = modalBody.querySelector('[data-role="editor-loop-toggle"]');
        if (loopToggle) {
            this.editorLoop = loopToggle.checked;
            loopToggle.addEventListener('change', (e) => {
                this.editorLoop = e.target.checked;
            });
        }

        const nameInput = modalBody.querySelector('#editor-phrase-name-input');
        if (nameInput) {
            nameInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.addPhrase();
                }
            });
        }

        this._initEditorWavesurfer();
    },

    _initEditorWavesurfer() {
        const container = document.getElementById('editor-waveform');
        if (!container) return;

        const rootStyles = getComputedStyle(document.documentElement);
        const accent = rootStyles.getPropertyValue('--accent-green').trim() || '#00ff41';
        const textPrimary = rootStyles.getPropertyValue('--text-primary').trim() || '#ffffff';
        const textSecondary = rootStyles.getPropertyValue('--text-secondary').trim() || '#aaaaaa';

        const ws = WaveSurfer.create({
            container,
            waveColor: 'rgba(59, 168, 105, 0.55)',
            progressColor: accent,
            cursorColor: textPrimary,
            cursorWidth: 2,
            height: 140,
            barWidth: 2,
            barGap: 1,
            barRadius: 2,
            normalize: true,
            plugins: [
                TimelinePlugin.create({
                    container: '#editor-timeline',
                    height: 22,
                    insertPosition: 'beforebegin',
                    style: { color: textSecondary, fontSize: '11px' },
                }),
                HoverPlugin.create({
                    lineColor: textPrimary,
                    lineWidth: 1,
                    labelBackground: 'rgba(0, 0, 0, 0.75)',
                    labelColor: '#ffffff',
                    labelSize: '11px',
                }),
                ZoomPlugin.create({ scale: 0.5, maxZoom: 100 }),
            ],
        });

        const regions = ws.registerPlugin(RegionsPlugin.create());

        this.editorWavesurfer = ws;
        this.editorRegions = regions;
        this.editorPlayingRegion = false;

        ws.on('ready', () => {
            const duration = ws.getDuration();
            const region = regions.addRegion({
                start: 0,
                end: Math.min(3, duration),
                color: 'rgba(0, 255, 65, 0.18)',
                drag: true,
                resize: true,
            });
            this.editorRegion = region;
            this._updateEditorSelectionLabel();
            this._updateEditorTimeLabel();

            region.on('update-end', () => this._updateEditorSelectionLabel());
            region.on('out', () => {
                if (this.editorLoop && this.editorPlayingRegion) {
                    region.play();
                }
            });
        });

        ws.on('audioprocess', () => {
            this._updateEditorTimeLabel();
            if (
                this.editorPlayingRegion &&
                this.editorLoop &&
                this.editorRegion &&
                this.editorWavesurfer
            ) {
                const cur = this.editorWavesurfer.getCurrentTime();
                if (cur >= this.editorRegion.end) {
                    this.editorWavesurfer.setTime(this.editorRegion.start);
                }
            }
        });
        ws.on('seeking', () => this._updateEditorTimeLabel());
        ws.on('play', () => this._setEditorPlayLabel(true));
        ws.on('pause', () => {
            this._setEditorPlayLabel(false);
            this.editorPlayingRegion = false;
        });
        ws.on('finish', () => {
            this._setEditorPlayLabel(false);
            this.editorPlayingRegion = false;
        });

        // loadBlob evita pasar por fetch(blob:...), que la CSP de este proyecto bloquea.
        const loadPromise = typeof ws.loadBlob === 'function'
            ? ws.loadBlob(this.currentRecording)
            : ws.load(this.createTrackedObjectURL(this.currentRecording));

        Promise.resolve(loadPromise).catch((e) => {
            console.error('WaveSurfer load error:', e);
            this.showNotification('No se pudo cargar el audio en el editor', 'error');
        });
    },

    _teardownPhraseEditor() {
        try {
            this.editorWavesurfer?.destroy();
        } catch {
            // Ignore destroy errors — the instance may already be gone.
        }
        this.editorWavesurfer = null;
        this.editorRegions = null;
        this.editorRegion = null;
        this.editorPlayingRegion = false;
    },

    _updateEditorSelectionLabel() {
        const el = document.querySelector('[data-role="editor-selection"]');
        if (!el || !this.editorRegion) return;
        const start = this.editorRegion.start;
        const end = this.editorRegion.end;
        const dur = Math.max(0, end - start);
        el.textContent = `Selección: ${this.formatDuration(start)} → ${this.formatDuration(end)} (${dur.toFixed(2)} s)`;
    },

    _updateEditorTimeLabel() {
        const el = document.querySelector('[data-role="editor-time"]');
        if (!el || !this.editorWavesurfer) return;
        const cur = this.editorWavesurfer.getCurrentTime();
        const total = this.editorWavesurfer.getDuration();
        el.textContent = `${this.formatDuration(cur)} / ${this.formatDuration(total)}`;
    },

    _setEditorPlayLabel(isPlaying) {
        const btn = document.querySelector('[data-action="editor-toggle-play"]');
        if (!btn) return;
        const icon = btn.querySelector('i');
        const label = btn.querySelector('[data-role="editor-play-label"]');
        if (icon) icon.className = isPlaying ? 'fas fa-pause' : 'fas fa-play';
        if (label) label.textContent = isPlaying ? 'Pause' : 'Play';
    },

    toggleEditorPlay() {
        if (!this.editorWavesurfer) return;
        this.editorPlayingRegion = false;
        this.editorWavesurfer.playPause();
    },

    playSelection() {
        if (!this.editorRegion || !this.editorWavesurfer) {
            this.showNotification('Esperá a que se cargue el audio', 'info');
            return;
        }
        const start = Math.max(0, this.editorRegion.start);
        const end = Math.max(start + 0.05, this.editorRegion.end);
        this.editorPlayingRegion = true;
        try {
            this.editorWavesurfer.setTime(start);
            if (this.editorLoop) {
                // Con loop activo dejamos correr al reproductor y el 'audioprocess'
                // hace el salto atrás al llegar al final de la región.
                this.editorWavesurfer.play();
            } else {
                // Sin loop, ws.play(start, end) pausa automáticamente al llegar al final.
                this.editorWavesurfer.play(start, end);
            }
        } catch (e) {
            console.error('playSelection error:', e);
            this.editorRegion.play?.();
        }
    },

    addPhrase() {
        if (!this.editorRegion) {
            this.showNotification('El editor todavía no está listo', 'info');
            return;
        }

        const nameInput = document.getElementById('editor-phrase-name-input');
        const typed = String(nameInput?.value || '').trim();
        const nextIndex = (this.selectedPhrases?.length || 0) + 1;
        const name = typed || `Frase ${nextIndex}`;

        const start = Math.max(0, this.editorRegion.start);
        const end = Math.max(start + 0.05, this.editorRegion.end);
        const duration = end - start;

        const phrase = {
            id: Date.now(),
            name,
            description: `Frase de ${this.formatDuration(duration)}`,
            style: 'custom',
            audioBlob: null,
            sourceBlob: this.currentRecording,
            startTime: start,
            duration,
        };

        this.selectedPhrases = this.selectedPhrases || [];
        this.selectedPhrases.push(phrase);
        this.updatePhrasesList();

        if (nameInput) nameInput.value = '';

        // Mover la región al siguiente hueco para facilitar seleccionar la próxima frase.
        const total = this.editorWavesurfer?.getDuration() || 0;
        if (total > 0) {
            const nextStart = Math.min(end, Math.max(0, total - 0.5));
            const nextEnd = Math.min(total, nextStart + Math.max(1, duration));
            try {
                this.editorRegion.setOptions({ start: nextStart, end: nextEnd });
            } catch {
                // Older wavesurfer versions no exponen setOptions — ignorar.
            }
            this._updateEditorSelectionLabel();
        }

        this.showNotification(`"${name}" agregada a la lista`, 'success');
    },

    initCurrentRecordingMetadata() {
        if (!this.currentRecording) {
            this.currentRecordingDuration = null;
            return;
        }

        try {
            const url = this.createTrackedObjectURL(this.currentRecording);
            const audio = new Audio(url);
            audio.preload = 'metadata';
            audio.addEventListener('loadedmetadata', () => {
                this.currentRecordingDuration = Number.isFinite(audio.duration) ? audio.duration : null;
                this.cleanupObjectURL(url);
            }, { once: true });
            audio.addEventListener('error', () => {
                this.currentRecordingDuration = null;
                this.cleanupObjectURL(url);
            }, { once: true });
        } catch {
            this.currentRecordingDuration = null;
        }
    },

    removePhrase(index) {
        if (!this.selectedPhrases || index < 0 || index >= this.selectedPhrases.length) return;
        this.selectedPhrases.splice(index, 1);
        this.updatePhrasesList();
    },

    encodeWavMono(float32Samples, sampleRate) {
        const numChannels = 1;
        const bytesPerSample = 2;
        const blockAlign = numChannels * bytesPerSample;
        const byteRate = sampleRate * blockAlign;
        const dataSize = float32Samples.length * bytesPerSample;
        const buffer = new ArrayBuffer(44 + dataSize);
        const view = new DataView(buffer);

        const writeString = (offset, str) => {
            for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
        };

        writeString(0, 'RIFF');
        view.setUint32(4, 36 + dataSize, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, 16, true);
        writeString(36, 'data');
        view.setUint32(40, dataSize, true);

        let offset = 44;
        for (let i = 0; i < float32Samples.length; i++) {
            let s = Math.max(-1, Math.min(1, float32Samples[i]));
            s = s < 0 ? s * 0x8000 : s * 0x7fff;
            view.setInt16(offset, s, true);
            offset += 2;
        }

        return new Blob([buffer], { type: 'audio/wav' });
    },

    async ensurePhraseHasExportedAudio(phrase) {
        if (phrase.audioBlob instanceof Blob) return phrase.audioBlob;
        if (!(phrase.sourceBlob instanceof Blob)) return null;

        try {
            if (!this.audioContext) this.initAudioContext();
            if (this.audioContext.state === 'suspended') await this.audioContext.resume();

            const arrBuf = await phrase.sourceBlob.arrayBuffer();
            const decoded = await this.audioContext.decodeAudioData(arrBuf.slice(0));

            const sr = decoded.sampleRate;
            const channels = decoded.numberOfChannels;
            const length = decoded.length;
            const mono = new Float32Array(length);
            for (let c = 0; c < channels; c++) {
                const ch = decoded.getChannelData(c);
                for (let i = 0; i < length; i++) mono[i] += ch[i];
            }
            if (channels > 1) {
                for (let i = 0; i < length; i++) mono[i] /= channels;
            }

            const safeStart = Math.max(0, Number(phrase.startTime) || 0);
            const safeDur   = Math.max(0.05, Number(phrase.duration) || 0);
            const startSample = Math.max(0, Math.floor(safeStart * sr));
            const endSample   = Math.min(mono.length, Math.floor((safeStart + safeDur) * sr));
            const slice = mono.slice(startSample, Math.max(startSample + 1, endSample));

            phrase.audioBlob = this.encodeWavMono(slice, sr);
        } catch (e) {
            console.error('ensurePhraseHasExportedAudio error:', e);
            phrase.audioBlob = null;
        }

        return phrase.audioBlob || null;
    },

    async savePhrasesToLicks() {
        if (!this.getActiveUsername()) {
            this.showNotification('Debes iniciar sesión para guardar licks', 'error');
            return;
        }
        if (!this.selectedPhrases || this.selectedPhrases.length === 0) {
            this.showNotification('No hay frases para guardar', 'info');
            return;
        }

        const phrasesCount = this.selectedPhrases.length;
        this.showNotification(`Procesando ${phrasesCount} frase${phrasesCount > 1 ? 's' : ''}…`, 'info');
        // Yield to the browser so the notification renders before heavy async work
        await new Promise(r => setTimeout(r, 50));

        let saved = 0;

        for (const phrase of this.selectedPhrases) {
            const wav = await this.ensurePhraseHasExportedAudio(phrase);
            if (!wav) {
                console.warn('savePhrasesToLicks: no se pudo exportar WAV para', phrase.name);
            }

            // Insert the lick row first to get its UUID
            const { data: lickRow, error: insertErr } = await insertLick({
                name: phrase.name || 'Frase',
                style: phrase.style || 'custom',
                notes: phrase.description || '',
                order_index: this.licks.length + saved
            });
            if (insertErr || !lickRow) {
                console.error('savePhrasesToLicks: insertLick falló', insertErr);
                continue;
            }

            // Upload the trimmed audio blob
            const trimmedBlob = phrase.audioBlob instanceof Blob ? phrase.audioBlob : null;
            if (trimmedBlob) {
                const { filePath, error: uploadErr } = await uploadLickAudio(trimmedBlob, lickRow.id);
                if (uploadErr) {
                    console.error('savePhrasesToLicks: uploadLickAudio falló', uploadErr);
                } else if (filePath) {
                    const { error: updErr } = await updateLick(lickRow.id, { file_path: filePath });
                    if (updErr) console.error('savePhrasesToLicks: updateLick falló', updErr);
                }
            }
            saved++;
        }

        this.selectedPhrases = [];
        this.updatePhrasesList();
        await this.loadLicks();

        if (saved < phrasesCount) {
            this.showNotification(`${saved} de ${phrasesCount} frases guardadas en Licks`, 'error');
        } else {
            this.showNotification(`${phrasesCount} frases guardadas en Licks`, 'success');
        }
    },

    updatePhrasesList() {
        const phrasesDiv = document.getElementById('selected-phrases');
        if (!this.selectedPhrases || this.selectedPhrases.length === 0) {
            phrasesDiv.innerHTML = '<p>No hay frases seleccionadas</p>';
            return;
        }
        
        phrasesDiv.innerHTML = this.selectedPhrases.map((phrase, index) => `
            <div class="phrase-item">
                <span>${escapeHtml(phrase.name)} (${this.formatDuration(phrase.startTime || 0)} - ${this.formatDuration((phrase.startTime || 0) + phrase.duration)})</span>
                <button class="btn-small" data-action="phrase-play" data-index="${index}">
                    <i class="fas fa-play"></i>
                </button>
                <button class="btn-small" data-action="phrase-remove" data-index="${index}">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        `).join('');
    },

    playPhrase(index) {
        const phrase = this.selectedPhrases[index];
        if (!phrase) return;
        const blobToPlay = phrase.audioBlob || phrase.sourceBlob;
        if (!blobToPlay) return;

        // Detener cualquier frase anterior en reproducción para no encimar audios.
        if (this._currentPhraseAudio) {
            try { this._currentPhraseAudio.pause(); } catch { /* noop */ }
            if (this._currentPhraseAudioUrl) this.cleanupObjectURL(this._currentPhraseAudioUrl);
            this._currentPhraseAudio = null;
            this._currentPhraseAudioUrl = null;
        }

        const url = this.createTrackedObjectURL(blobToPlay);
        const audio = new Audio(url);
        audio.preload = 'auto';
        this._currentPhraseAudio = audio;
        this._currentPhraseAudioUrl = url;

        // Si el audio es el blob completo (sourceBlob), hay que hacer seek al startTime
        // y detener al llegar a endTime. Si ya es el WAV recortado (audioBlob), reproducir
        // de corrido y limpiar al terminar.
        const usesSourceBlob = !(phrase.audioBlob instanceof Blob);
        const start = Math.max(0, Number(phrase.startTime) || 0);
        const dur = Math.max(0.05, Number(phrase.duration) || 0);
        const end = start + dur;

        const cleanup = () => {
            if (this._currentPhraseAudio === audio) {
                this._currentPhraseAudio = null;
                this._currentPhraseAudioUrl = null;
            }
            this.cleanupObjectURL(url);
        };

        audio.addEventListener('ended', () => cleanup(), { once: true });
        audio.addEventListener('error', () => cleanup(), { once: true });

        if (!usesSourceBlob) {
            // Blob ya recortado (por ensurePhraseHasExportedAudio o similar): reproducir de corrido.
            audio.play().catch(() => cleanup());
            return;
        }

        // Fuente completa: esperamos metadatos ANTES de hacer seek + play, si no el seek se ignora.
        const startPlayback = () => {
            try {
                audio.currentTime = start;
            } catch { /* algunos navegadores no permiten seek si duration es NaN todavía */ }
            audio.play().catch(() => cleanup());
        };

        if (audio.readyState >= 1 /* HAVE_METADATA */) {
            startPlayback();
        } else {
            audio.addEventListener('loadedmetadata', startPlayback, { once: true });
        }

        // Detener cuando el cursor pase el endTime real (no con setTimeout).
        const onTime = () => {
            if (audio.currentTime >= end) {
                try { audio.pause(); } catch { /* noop */ }
                audio.removeEventListener('timeupdate', onTime);
                cleanup();
            }
        };
        audio.addEventListener('timeupdate', onTime);
    },
};
