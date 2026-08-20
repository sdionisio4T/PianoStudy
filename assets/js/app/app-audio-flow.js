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
        this._initProviderToggle();
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

    // Toggle "Análisis con Gemini" — decide qué proveedor genera el texto
    // pedagógico. Default OFF (Groq). Persistido en la key global que lee
    // AIAnalysisEngine._getProvider() ('pianoStudy.aiProvider').
    // Es global (no por usuario) porque el flag es experimental / A/B corto.
    _initProviderToggle() {
        const toggle = document.getElementById('analysis-provider-toggle');
        if (!toggle) return;
        let stored = null;
        try { stored = localStorage.getItem('pianoStudy.aiProvider'); } catch { /* ignore */ }
        toggle.checked = stored === 'gemini';
        if (!toggle._providerWired) {
            toggle._providerWired = true;
            toggle.addEventListener('change', () => {
                try {
                    if (toggle.checked) {
                        localStorage.setItem('pianoStudy.aiProvider', 'gemini');
                    } else {
                        localStorage.removeItem('pianoStudy.aiProvider');
                    }
                } catch { /* ignore */ }
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
        const llmMap = {
            'ai-groq':         { name: 'Groq', model: 'compound-mini', cls: 'ok' },
            'ai-groq+audio':   { name: 'Groq', model: 'compound-mini', cls: 'ok' },
            'ai-gemini':       { name: 'Gemini', model: 'gemini-1.5-flash', cls: 'ok' },
            'ai-gemini+audio': { name: 'Gemini', model: 'gemini-1.5-flash', cls: 'ok' },
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
            await this.audioAnalyzer.init();
            const audioAnalysis = await this.audioAnalyzer.analyzeAudio(audioBlob, { enableMidiTranscription: true });
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
            if (GEMINI_AUDIO_CONFIG.enabled && geminiOn) {
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

    displayAnalysisResults() {
        if (!this.currentAnalysis) return;
        const { audioAnalysis, aiAnalysis } = this.currentAnalysis;

        document.getElementById('analysis-results')?.classList.remove('hidden');

        const badgeEl = document.getElementById('analysis-source-badge');
        if (badgeEl) {
            const source = String(aiAnalysis?.source || '');
            const badges = {
                'ai-groq':          { cls: 'is-real', icon: 'fa-check-circle', text: 'Análisis con IA (Groq) — respuesta específica para tu grabación' },
                'ai-gemini':        { cls: 'is-real', icon: 'fa-check-circle', text: 'Análisis con IA (Gemini) — respuesta específica para tu grabación' },
                'ai-groq+audio':    { cls: 'is-real', icon: 'fa-check-circle', text: 'Análisis con IA (Groq) + escucha profunda con Gemini — respuesta específica para tu grabación' },
                'ai-gemini+audio':  { cls: 'is-real', icon: 'fa-check-circle', text: 'Análisis con IA (Gemini) + escucha profunda — respuesta específica para tu grabación' },
                'fallback-parse-error':    { cls: 'is-fallback', icon: 'fa-triangle-exclamation', text: 'Respuesta genérica — la IA respondió pero no fue JSON parseable. Volvé a intentar en un minuto.' },
                'fallback-schema-invalid': { cls: 'is-fallback', icon: 'fa-triangle-exclamation', text: 'Respuesta genérica — la IA devolvió JSON con campos faltantes o inválidos. Volvé a intentar.' },
                'fallback-network': { cls: 'is-fallback', icon: 'fa-triangle-exclamation', text: 'Respuesta genérica — la IA no respondió. Revisá tu conexión y volvé a intentar.' },
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

        document.getElementById('detected-tempo').textContent = `${tempoBpm || '--'} BPM`;
        document.getElementById('detected-key').textContent = `${keyName}${keyScale ? ` ${keyScale}` : ''}`;
        document.getElementById('overall-score').textContent = `${aiAnalysis.overallScore}/10`;
        document.getElementById('recording-duration').textContent = this.formatDuration(Math.floor(audioAnalysis.duration));

        const bpmValueEl = document.getElementById('metric-bpm-value');
        const bpmConfBarEl = document.getElementById('metric-bpm-confidence');
        const bpmConfTextEl = document.getElementById('metric-bpm-confidence-text');
        if (bpmValueEl) bpmValueEl.textContent = `${tempoBpm || '--'} BPM`;
        if (bpmConfBarEl) bpmConfBarEl.style.width = `${Math.max(0, Math.min(100, tempoConfidence * 100))}%`;
        if (bpmConfTextEl) bpmConfTextEl.textContent = `Confianza ${(tempoConfidence * 100).toFixed(0)}%`;

        const keyValueEl = document.getElementById('metric-key-value');
        const keyStrengthBarEl = document.getElementById('metric-key-strength');
        const keyStrengthTextEl = document.getElementById('metric-key-strength-text');
        if (keyValueEl) keyValueEl.textContent = `${keyName}${keyScale ? ` ${keyScale}` : ''}`;
        if (keyStrengthBarEl) keyStrengthBarEl.style.width = `${Math.max(0, Math.min(100, keyStrength * 100))}%`;
        if (keyStrengthTextEl) keyStrengthTextEl.textContent = `Fuerza ${(keyStrength * 100).toFixed(0)}%`;

        const dynGaugeEl = document.getElementById('metric-dynamic-gauge');
        const dynTextEl = document.getElementById('metric-dynamic-text');
        if (dynGaugeEl) dynGaugeEl.style.width = `${Math.max(0, Math.min(100, dynamic * 100))}%`;
        if (dynTextEl) dynTextEl.textContent = `Complejidad ${(dynamic || 0).toFixed(2)}`;

        const midiContainer = document.getElementById('midi-notes-container');
        const midiList = document.getElementById('midi-notes-list');
        const midiNotes = Array.isArray(audioAnalysis?.midiNotes) ? audioAnalysis.midiNotes : [];
        if (midiContainer && midiList) {
            if (midiNotes.length > 0) {
                midiContainer.classList.remove('hidden');
                midiList.innerHTML = midiNotes.slice(0, 24).map((n) => {
                    const pitchMidi = Number(n?.pitchMidi ?? n?.pitch ?? 0);
                    const start = Number(n?.startTimeSeconds ?? n?.start ?? 0);
                    const dur = Number(n?.durationSeconds ?? n?.duration ?? 0);
                    const amp = Number(n?.amplitude ?? 0);
                    return `<div class="midi-note-item">MIDI ${escapeHtml(String(Math.round(pitchMidi)))} · ${escapeHtml(start.toFixed(2))}s → ${escapeHtml((start + dur).toFixed(2))}s · amp ${escapeHtml(amp.toFixed(2))}</div>`;
                }).join('');
            } else {
                midiContainer.classList.add('hidden');
                midiList.innerHTML = '';
            }
        }

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

        // Reproductor WaveSurfer con regiones para los momentos que marcó la IA.
        this._initAnalysisWavesurfer();

        // Reset chat
        this.analysisChat = [];
        this.renderAnalysisChat();
    },

    _initAnalysisWavesurfer() {
        this._teardownAnalysisWavesurfer();

        const container = document.getElementById('analysis-wavesurfer');
        if (!container || !(this.currentAnalysisAudioBlob instanceof Blob)) return;

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
                    container: '#analysis-wavesurfer-timeline',
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
            ],
        });

        const regionsPlugin = ws.registerPlugin(RegionsPlugin.create());
        this.analysisWavesurfer = ws;
        this.analysisRegionsPlugin = regionsPlugin;

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
                region.on('click', () => {
                    ws.setTime(start);
                    if (noteEl) noteEl.textContent = String(m?.note || '');
                });
                region.on('over', () => {
                    if (noteEl) noteEl.textContent = String(m?.note || '');
                });
            }
        });

        const playBtn = document.getElementById('analysis-play-btn');
        if (playBtn && !playBtn._analysisWired) {
            playBtn._analysisWired = true;
            playBtn.addEventListener('click', () => {
                if (this.analysisWavesurfer) this.analysisWavesurfer.playPause();
            });
        }

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
        this.analysisWavesurfer = null;
        this.analysisRegionsPlugin = null;
        const noteEl = document.getElementById('analysis-moment-note');
        if (noteEl) noteEl.textContent = '';
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

    renderAnalysisChat() {
        const container = document.getElementById('analysis-chat-messages');
        if (!container) return;

        if (!this.analysisChat.length) {
            container.innerHTML = '<div class="chat-message assistant"><div class="chat-role">IA</div><div class="chat-text">Pregúntame sobre tu interpretación (tempo, dinámica, coordinación, etc.).</div></div>';
            return;
        }

        container.innerHTML = this.analysisChat.map(m => {
            const role = m.role === 'user' ? 'Tú' : 'IA';
            const cls = m.role === 'user' ? 'user' : 'assistant';
            return `<div class="chat-message ${cls}"><div class="chat-role">${escapeHtml(role)}</div><div class="chat-text">${escapeHtml(m.text)}</div></div>`;
        }).join('');

        container.scrollTop = container.scrollHeight;
    },

    async sendAnalysisChat() {
        if (!this.currentAnalysis) {
            this.showNotification('Primero analiza una grabación', 'info');
            return;
        }

        const input = document.getElementById('analysis-chat-input');
        const question = String(input?.value || '').trim();
        if (!question) return;

        this.analysisChat.push({ role: 'user', text: question });
        if (input) input.value = '';
        this.renderAnalysisChat();

        const { audioAnalysis, aiAnalysis } = this.currentAnalysis;
        const engine = this.aiEngine || new AIAnalysisEngine();
        // Pasamos historial excluyendo la pregunta recién agregada (se pasa aparte).
        const historyForModel = this.analysisChat.slice(0, -1);
        const answer = await engine.answerQuestion(audioAnalysis, aiAnalysis, question, historyForModel);
        this.analysisChat.push({ role: 'assistant', text: String(answer || '') });
        this.renderAnalysisChat();
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
        const tempo = Number(audioAnalysis?.tempo?.bpm || audioAnalysis?.tempo || 0);
        const key = `${audioAnalysis?.key?.key || audioAnalysis?.pitch || '--'} ${audioAnalysis?.key?.scale || ''}`.trim();
        const dynamic = Number(audioAnalysis?.loudness?.dynamicComplexity || 0);

        // Construimos secciones opcionalmente para no dejar títulos vacíos
        // cuando el modelo no devolvió ese campo (igual que la UI, que oculta
        // las secciones sin datos con .hidden).
        const sections = [];

        sections.push('ANÁLISIS DE INTERPRETACIÓN MUSICAL');
        sections.push('');
        sections.push(`Grabación: ${recordingName || '—'}`);
        sections.push(`Duración: ${(audioAnalysis?.duration || 0).toFixed(1)}s`);
        sections.push(`Tempo: ${tempo} BPM`);
        sections.push(`Tonalidad: ${key}`);
        sections.push(`Complejidad dinámica: ${dynamic.toFixed(2)}`);
        sections.push(`Puntuación: ${aiAnalysis.overallScore}/10`);

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
        } catch (error) {
            console.error('Error initializing audio context:', error);
        }
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
        if (!deviceId) return;

        if (this.currentStream) {
            this.currentStream.getTracks().forEach(track => track.stop());
            this.currentStream = null;
        }
        
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    deviceId: deviceId,
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            });
            
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

    async startRecording() {
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
                
                // Agregar a la lista de grabaciones temporales
                this.addToTempRecordings(audioBlob);
                
                // Mostrar lista de grabaciones recientes
                this.showRecordingList();
                
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

    stopRecording() {
        // Track study time and recordings
        const durationSec = this.recordingStartTime
            ? Math.max(0, Math.floor((Date.now() - this.recordingStartTime) / 1000))
            : 0;

        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
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
            filePath: r.file_path,
            uploading: false
        }));
        this.updateTempRecordingsList();
    },

    async addToTempRecordings(audioBlob) {
        if (!this.getActiveUsername()) {
            this.updateTempRecordingsList();
            return;
        }
        const duration = Math.floor((Date.now() - this.recordingStartTime) / 1000);
        const name = `Grabación ${new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`;

        // Keep a local blob reference for immediate playback
        const localRec = {
            id: `local-${Date.now()}`,
            name,
            blob: audioBlob,
            duration,
            filePath: null,
            uploading: true
        };
        this.tempRecordings.unshift(localRec);
        this.updateTempRecordingsList();

        const { data, error } = await uploadRecording(audioBlob, name, duration);
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
                uploading: false
            };
        }
        this.updateTempRecordingsList();
        this.showNotification('Grabación guardada', 'success');
    },

    updateTempRecordingsList() {
        const container = document.getElementById('temp-recordings');
        const deleteAllBtn = document.getElementById('temp-delete-all-btn');

        if (!this.getActiveUsername()) {
            container.innerHTML = `<div class="auth-required-banner">
                <p>Inicia sesión para guardar tu progreso</p>
                <button class="auth-header-btn auth-header-btn--primary" onclick="document.getElementById('auth-open-login')?.click()">Ingresar</button>
            </div>`;
            if (deleteAllBtn) deleteAllBtn.style.display = 'none';
            return;
        }

        if (deleteAllBtn) deleteAllBtn.style.display = this.tempRecordings.length > 0 ? '' : 'none';

        if (this.tempRecordings.length === 0) {
            container.innerHTML = '<p class="no-recordings">No hay grabaciones aún</p>';
            return;
        }
        
        container.innerHTML = this.tempRecordings.map(recording => `
            <div class="recording-item${recording.uploading ? ' uploading' : ''}">
                <div class="recording-info">
                    <div class="recording-name">${escapeHtml(recording.name)}${recording.uploading ? ' <span class="upload-badge"><i class="fas fa-cloud-upload-alt"></i></span>' : ''}</div>
                    <div class="recording-duration">${this.formatDuration(recording.duration)}</div>
                </div>
                <div class="recording-actions">
                    <button class="btn-small" data-action="temp-play" data-id="${recording.id}" ${!recording.blob && !recording.filePath ? 'disabled' : ''}>
                        <i class="fas fa-play"></i>
                    </button>
                    <button class="btn-small" data-action="temp-stop" data-id="${recording.id}">
                        <i class="fas fa-stop"></i>
                    </button>
                    <button class="btn-small" data-action="temp-edit" data-id="${recording.id}">
                        <i class="fas fa-cut"></i>
                    </button>
                    <button class="btn-small btn-danger" data-action="temp-delete" data-id="${recording.id}" ${recording.uploading ? 'disabled' : ''}>
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        `).join('');
    },

    playTempRecording(id) {
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
        const blobToPlay = phrase.audioBlob || phrase.sourceBlob || phrase.audioBlob;
        if (!blobToPlay) return;
        const url = this.createTrackedObjectURL(blobToPlay);
        const audio = new Audio(url);
        const shouldSeek = !phrase.audioBlob;
        if (shouldSeek) audio.currentTime = Math.max(0, phrase.startTime || 0);
        audio.play();

        audio.onended = () => this.cleanupObjectURL(url);
        
        setTimeout(() => {
            audio.pause();
            this.cleanupObjectURL(url);
        }, Math.max(0, (phrase.duration || 0) * 1000));
    },
};
