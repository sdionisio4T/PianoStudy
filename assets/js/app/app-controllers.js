// app-controllers.js — lógica de features (YouTube study, licks, artistas,
// favoritos, progreso, timer de práctica, búsqueda). Mezclado sobre
// PianoStudyApp.prototype en app-init.js.

import { escapeHtml, sanitizeFileName } from '../utils/sanitizers.js';
import { ProgressTracker } from '../modules/ProgressTracker.js';
import {
    loadLicksFromDB, insertLick, deleteLick, getRecordingPublicUrl,
    insertPracticeSession, loadPracticeSessionsRange,
    skeletonHTML, errorHTML, ERR_MSG
} from '../modules/SupabaseDataManager.js';

export const controllersMixin = {
    setupStudyDropzone() {
        const dropzone = document.getElementById('study-dropzone');
        if (!dropzone) return;

        const speed = document.getElementById('study-speed');
        const speedLabel = document.getElementById('study-speed-label');
        if (speed) {
            const applySpeed = () => {
                const val = Number(speed.value);
                this.studyPlaybackRate = Number.isFinite(val) ? val : 1;
                if (speedLabel) speedLabel.textContent = `${this.studyPlaybackRate.toFixed(2)}x`;
                if (this.studyAudio) this.studyAudio.playbackRate = this.studyPlaybackRate;
            };
            speed.addEventListener('input', applySpeed);
            applySpeed();
        }

        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.classList.add('dragover');
        });

        dropzone.addEventListener('dragleave', () => {
            dropzone.classList.remove('dragover');
        });

        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');

            const id = e.dataTransfer?.getData('text/lick-id');
            if (!id) return;
            this.studyAddById(id);
        });
    },

    updateStudyLoopButton(btnEl) {
        const btn = btnEl || document.querySelector('[data-action="study-toggle-loop"]');
        if (!btn) return;
        btn.innerHTML = `<i class="fas fa-redo"></i> Loop: ${this.studyLoop ? 'ON' : 'OFF'}`;
    },

    loadYoutubeVideo() {
        const urlInput = document.getElementById('youtube-url-input');
        const url = String(urlInput?.value || '').trim();

        if (!url) {
            this.showNotification('Pega una URL de YouTube', 'info');
            return;
        }

        try {
            const videoId = this.youtubeManager.loadVideo(url);

            document.getElementById('youtube-player-container')?.classList.remove('hidden');
            if (urlInput) urlInput.value = '';

            this.youtubeManager.onTimeUpdate = (time) => {
                this.updateTimeDisplay(time);
            };

            const videoTitleEl = document.getElementById('video-title');
            if (videoTitleEl) videoTitleEl.textContent = `Video ID: ${videoId}`;

            this.showNotification('Video cargado correctamente', 'success');
        } catch (error) {
            console.error('Error loading YouTube video:', error);
            this.showNotification(error?.message || 'Error al cargar video', 'error');
        }
    },

    updateTimeDisplay(currentTime) {
        const totalTime = this.youtubeManager.getDuration();
        const curEl = document.getElementById('current-time');
        const totEl = document.getElementById('total-time');

        if (curEl) curEl.textContent = this.youtubeManager.formatTime(currentTime);
        if (totEl) totEl.textContent = this.youtubeManager.formatTime(totalTime);
    },

    markSegmentStart() {
        try {
            const startTime = this.youtubeManager.markStart();
            if (startTime !== null) {
                const el = document.getElementById('segment-start-display');
                if (el) el.textContent = this.youtubeManager.formatTime(startTime);

                this.updateSegmentPreview();
                this.showNotification('Inicio marcado', 'success');
            }
        } catch (error) {
            console.error('Error marking start:', error);
            this.showNotification('Error al marcar inicio', 'error');
        }
    },

    markSegmentEnd() {
        try {
            const endTime = this.youtubeManager.markEnd();
            if (endTime !== null) {
                const el = document.getElementById('segment-end-display');
                if (el) el.textContent = this.youtubeManager.formatTime(endTime);

                this.updateSegmentPreview();

                const playBtn = document.getElementById('play-segment-btn');
                const saveBtn = document.getElementById('save-youtube-phrase-btn');
                if (playBtn) playBtn.disabled = false;
                if (saveBtn) saveBtn.disabled = false;

                this.showNotification('Final marcado', 'success');
            }
        } catch (error) {
            console.error('Error marking end:', error);
            this.showNotification(error?.message || 'Error al marcar final', 'error');
        }
    },

    updateSegmentPreview() {
        const segment = this.youtubeManager.getSegmentData();
        if (!segment) return;

        document.getElementById('segment-preview')?.classList.remove('hidden');
        const durEl = document.getElementById('segment-duration-display');
        if (durEl) durEl.textContent = `${Math.floor(segment.duration)}s`;
    },

    playSegment() {
        try {
            this.youtubeManager.playSegment();
        } catch (error) {
            console.error('Error playing segment:', error);
            this.showNotification(error?.message || 'Error al reproducir segmento', 'error');
        }
    },

    async saveYoutubePhrase() {
        const name = String(document.getElementById('phrase-name-input')?.value || '').trim();
        const style = String(document.getElementById('phrase-style-select')?.value || '');
        const notes = String(document.getElementById('phrase-notes-input')?.value || '').trim();

        if (!name) {
            this.showNotification('Escribe un nombre para la frase', 'info');
            return;
        }

        if (!style) {
            this.showNotification('Selecciona un estilo', 'info');
            return;
        }

        const segmentData = this.youtubeManager.getSegmentData();
        if (!segmentData) {
            this.showNotification('Marca inicio y final primero', 'info');
            return;
        }

        const phrase = {
            id: Date.now(),
            name,
            style,
            notes,
            videoId: segmentData.videoId,
            videoTitle: segmentData.videoTitle,
            startTime: segmentData.start,
            endTime: segmentData.end,
            duration: segmentData.duration,
            timestamp: new Date().toISOString()
        };

        try {
            const stored = this.safeGetLocalStorage(this.userKey('pianostudy-youtube-phrases'), []);
            const list = Array.isArray(stored) ? stored : [];
            list.unshift(phrase);
            const ok = this.safeSetLocalStorage(this.userKey('pianostudy-youtube-phrases'), list);
            if (!ok) {
                this.showNotification('Error al guardar frase', 'error');
                return;
            }

            const nameEl = document.getElementById('phrase-name-input');
            const styleEl = document.getElementById('phrase-style-select');
            const notesEl = document.getElementById('phrase-notes-input');
            if (nameEl) nameEl.value = '';
            if (styleEl) styleEl.value = '';
            if (notesEl) notesEl.value = '';

            this.youtubeManager.clearSegment();
            document.getElementById('segment-preview')?.classList.add('hidden');
            const saveBtn = document.getElementById('save-youtube-phrase-btn');
            const playBtn = document.getElementById('play-segment-btn');
            if (saveBtn) saveBtn.disabled = true;
            if (playBtn) playBtn.disabled = true;

            await this.loadYoutubePhrases(document.getElementById('youtube-phrases-filter')?.value || 'all');
            this.showNotification('¡Frase guardada!', 'success');
        } catch (error) {
            console.error('Error saving YouTube phrase:', error);
            this.showNotification('Error al guardar frase', 'error');
        }
    },

    async loadYoutubePhrases(styleFilter = 'all') {
        try {
            const stored = this.safeGetLocalStorage(this.userKey('pianostudy-youtube-phrases'), []);
            const list = Array.isArray(stored) ? stored : [];
            const normalized = list
                .filter((p) => p && typeof p === 'object')
                .map((p) => ({
                    id: Number(p.id),
                    name: typeof p.name === 'string' ? p.name : String(p.name ?? ''),
                    style: typeof p.style === 'string' ? p.style : String(p.style ?? ''),
                    notes: typeof p.notes === 'string' ? p.notes : String(p.notes ?? ''),
                    videoId: typeof p.videoId === 'string' ? p.videoId : String(p.videoId ?? ''),
                    videoTitle: typeof p.videoTitle === 'string' ? p.videoTitle : String(p.videoTitle ?? ''),
                    startTime: Number(p.startTime) || 0,
                    endTime: Number(p.endTime) || 0,
                    duration: Number(p.duration) || 0,
                    timestamp: typeof p.timestamp === 'string' ? p.timestamp : new Date().toISOString()
                }))
                .filter((p) => Number.isFinite(p.id));

            this.youtubePhrases = (styleFilter && styleFilter !== 'all')
                ? normalized.filter(p => p.style === styleFilter)
                : normalized;

            this.renderYoutubePhrases();
        } catch (error) {
            console.error('Error loading YouTube phrases:', error);
            this.showNotification('Error al cargar frases', 'error');
        }
    },

    renderYoutubePhrases() {
        const container = document.getElementById('youtube-phrases-list');
        if (!container) return;

        const phrases = Array.isArray(this.youtubePhrases) ? this.youtubePhrases : [];
        if (phrases.length === 0) {
            container.innerHTML = '<p class="no-data">No hay frases guardadas todavía</p>';
            return;
        }

        container.innerHTML = phrases.map(phrase => `
            <div class="youtube-phrase-card" data-id="${phrase.id}">
                <div class="phrase-card-header">
                    <h4 class="phrase-card-title">${escapeHtml(phrase.name)}</h4>
                    <span class="phrase-card-style">${escapeHtml(phrase.style)}</span>
                </div>

                <p class="phrase-card-video">
                    <i class="fab fa-youtube"></i> ${escapeHtml(phrase.videoTitle || 'Video de YouTube')}
                </p>

                <div class="phrase-card-segment">
                    <span>⏱️ ${this.youtubeManager.formatTime(phrase.startTime)} - ${this.youtubeManager.formatTime(phrase.endTime)}</span>
                    <span>⏳ ${Math.floor(Number(phrase.duration) || 0)}s</span>
                </div>

                ${phrase.notes ? `
                    <p class="phrase-card-notes">${escapeHtml(phrase.notes)}</p>
                ` : ''}

                <div class="phrase-card-actions">
                    <button class="btn-small" data-action="youtube-play-phrase" data-id="${phrase.id}">
                        <i class="fas fa-play"></i> Ver en YouTube
                    </button>
                    <button class="btn-small" data-action="youtube-delete-phrase" data-id="${phrase.id}">
                        <i class="fas fa-trash"></i> Eliminar
                    </button>
                </div>
            </div>
        `).join('');
    },

    playYoutubePhrase(id) {
        const phrase = (this.youtubePhrases || []).find(p => Number(p.id) === Number(id));
        if (!phrase) return;

        try {
            const url = `https://youtube.com/watch?v=${phrase.videoId}`;
            this.youtubeManager.loadVideo(url);
            document.getElementById('youtube-player-container')?.classList.remove('hidden');

            this.youtubeManager.onTimeUpdate = (time) => {
                this.updateTimeDisplay(time);
            };

            setTimeout(() => {
                if (this.youtubeManager.player) {
                    this.youtubeManager.player.seekTo(phrase.startTime, true);
                    this.youtubeManager.player.playVideo();
                    document.getElementById('youtube-player')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }, 700);

            this.showNotification('Reproduciendo frase...', 'success');
        } catch (error) {
            console.error('Error playing phrase:', error);
            this.showNotification('Error al reproducir', 'error');
        }
    },

    async deleteYoutubePhrase(id) {
        const stored = this.safeGetLocalStorage(this.userKey('pianostudy-youtube-phrases'), []);
        const list = Array.isArray(stored) ? stored : [];
        const phrase = list.find(p => Number(p?.id) === Number(id));
        if (!phrase) return;

        if (!await this.showConfirm(`¿Eliminar "${phrase.name}"?`)) {
            return;
        }

        try {
            const next = list.filter(p => Number(p?.id) !== Number(id));
            this.safeSetLocalStorage(this.userKey('pianostudy-youtube-phrases'), next);
            await this.loadYoutubePhrases(document.getElementById('youtube-phrases-filter')?.value || 'all');
            this.showNotification('Frase eliminada', 'success');
        } catch (error) {
            console.error('Error deleting phrase:', error);
            this.showNotification('Error al eliminar', 'error');
        }
    },

    filterYoutubePhrases(style) {
        this.loadYoutubePhrases(style);
    },

    renderStudyQueue() {
        const queueEl = document.getElementById('study-queue');
        const titleEl = document.getElementById('study-now-title');
        if (!queueEl) return;

        if (this.studyQueue.length === 0) {
            queueEl.innerHTML = '';
            if (titleEl) titleEl.textContent = 'Arrastra un lick aquí';
            return;
        }

        queueEl.innerHTML = this.studyQueue.map((item, idx) => {
            const active = idx === this.studyIndex;
            return `
                <div class="study-queue-item ${active ? 'active' : ''}">
                    <div class="study-queue-item-title">
                        <strong>${escapeHtml(item.name)}</strong>
                        <small>${escapeHtml(item.style || 'custom')}</small>
                    </div>
                    <div class="study-queue-item-actions">
                        <button class="btn-small" data-action="study-pick" data-index="${idx}">
                            <i class="fas fa-play"></i>
                        </button>
                        <button class="btn-small btn-danger" data-action="study-remove" data-index="${idx}">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        if (titleEl) {
            const cur = this.studyQueue[this.studyIndex] || this.studyQueue[0];
            titleEl.textContent = cur ? cur.name : 'Arrastra un lick aquí';
        }
    },

    studyAddById(lickId) {
        const lick = this.licks.find(l => l.id === lickId);
        const hasLocalBlob = lick?.audioBlob instanceof Blob;
        if (!lick || (!hasLocalBlob && !lick.audioUrl)) {
            this.showNotification('Ese lick no tiene audio', 'info');
            return;
        }

        this.studyQueue.push({
            id: lick.id,
            name: lick.name,
            style: lick.style,
            startTime: lick.startTime || 0,
            duration: lick.duration || null,
            audioBlob: hasLocalBlob ? lick.audioBlob : null,
            audioUrl: lick.audioUrl || null
        });

        if (this.studyIndex === -1) this.studyIndex = 0;
        this.renderStudyQueue();
        this.showNotification('Agregado a la cola de estudio', 'success');
    },

    studyRemove(index) {
        if (!Number.isFinite(index)) return;
        if (index < 0 || index >= this.studyQueue.length) return;

        this.studyQueue.splice(index, 1);
        if (this.studyQueue.length === 0) {
            this.studyIndex = -1;
            this.studyStop();
        } else {
            if (this.studyIndex >= this.studyQueue.length) this.studyIndex = this.studyQueue.length - 1;
        }
        this.renderStudyQueue();
    },

    studyPick(index) {
        if (!Number.isFinite(index)) return;
        if (index < 0 || index >= this.studyQueue.length) return;
        this.studyIndex = index;
        this.renderStudyQueue();
        this.studyPlay();
    },

    studyClear() {
        this.studyQueue = [];
        this.studyIndex = -1;
        this.studyStop();
        this.renderStudyQueue();
    },

    studyStop() {
        if (this.studyAudio) {
            this.studyAudio.pause();
            this.studyAudio.currentTime = 0;
            this.studyAudio = null;
        }
        if (this.studyAudioUrl) {
            if (this.studyAudioUrl.startsWith('blob:')) {
                this.cleanupObjectURL(this.studyAudioUrl);
            }
            this.studyAudioUrl = null;
        }
    },

    studyPlay() {
        if (!this.studyQueue.length) {
            this.showNotification('Arrastra un lick a la cola primero', 'info');
            return;
        }
        if (this.studyIndex < 0) this.studyIndex = 0;

        const item = this.studyQueue[this.studyIndex];
        const itemHasBlob = item?.audioBlob instanceof Blob;
        if (!item || (!itemHasBlob && !item.audioUrl)) {
            this.showNotification('Este lick no tiene audio disponible', 'info');
            return;
        }

        this.studyStop();

        let url;
        let isObjectUrl = false;
        if (itemHasBlob) {
            url = this.createTrackedObjectURL(item.audioBlob);
            isObjectUrl = true;
        } else {
            url = item.audioUrl;
        }
        this.studyAudioUrl = url;
        const audio = new Audio(url);
        this.studyAudio = audio;

        audio.preload = 'auto';
        audio.playbackRate = this.studyPlaybackRate;
        audio.currentTime = Math.max(0, Number(item.startTime) || 0);

        const endAt = item.duration ? Math.max(0.05, Number(item.duration) || 0) : null;
        let stopTimer = null;
        if (endAt) {
            stopTimer = setTimeout(() => {
                try {
                    audio.pause();
                } finally {
                    if (this.studyLoop) {
                        this.studyPlay();
                    } else {
                        this.studyNext();
                    }
                }
            }, endAt * 1000);
        }

        audio.onended = () => {
            if (stopTimer) clearTimeout(stopTimer);
            if (this.studyLoop) {
                this.studyPlay();
            } else {
                this.studyNext();
            }
        };

        audio.onerror = () => {
            if (stopTimer) clearTimeout(stopTimer);
            this.showNotification('Error al reproducir en Study Player', 'error');
            this.studyStop();
        };

        this.renderStudyQueue();
        audio.play().catch(() => {
            if (stopTimer) clearTimeout(stopTimer);
            this.showNotification('No se pudo iniciar reproducción', 'error');
            this.studyStop();
        });
    },

    studyPause() {
        if (this.studyAudio) {
            this.studyAudio.pause();
        }
    },

    studyNext() {
        if (!this.studyQueue.length) return;
        this.studyIndex = (this.studyIndex + 1) % this.studyQueue.length;
        this.renderStudyQueue();
        this.studyPlay();
    },

    studyPrev() {
        if (!this.studyQueue.length) return;
        this.studyIndex = (this.studyIndex - 1 + this.studyQueue.length) % this.studyQueue.length;
        this.renderStudyQueue();
        this.studyPlay();
    },

    initPracticeTimerWidget() {
        const startBtn = document.getElementById('practice-timer-start');
        const stopBtn = document.getElementById('practice-timer-stop');
        const mobileStartBtn = document.getElementById('mobile-timer-start');
        const mobileStopBtn = document.getElementById('mobile-timer-stop');
        const headerBtn = document.getElementById('nav-timer-header');
        const mobileToggleBtn = document.getElementById('mobile-timer-toggle');

        if (startBtn) startBtn.addEventListener('click', () => this.practiceTimerStart());
        if (stopBtn) stopBtn.addEventListener('click', () => this.practiceTimerStop());
        if (mobileStartBtn) mobileStartBtn.addEventListener('click', () => this.practiceTimerStart());
        if (mobileStopBtn) mobileStopBtn.addEventListener('click', () => this.practiceTimerStop());
        if (headerBtn) headerBtn.addEventListener('click', () => this.toggleNavTimerCollapsed());
        if (mobileToggleBtn) mobileToggleBtn.addEventListener('click', () => this.toggleMobileTimerCollapsed());

        this.updatePracticeTimerUI();
    },

    toggleMobileTimerCollapsed() {
        this.mobileTimerCollapsed = !this.mobileTimerCollapsed;
        try {
            localStorage.setItem('pianostudy-timer-mobile-collapsed', this.mobileTimerCollapsed ? '1' : '0');
        } catch { /* ignore */ }
        this.updatePracticeTimerUI();
    },

    toggleNavTimerCollapsed() {
        this.navTimerCollapsed = !this.navTimerCollapsed;
        try {
            localStorage.setItem('pianostudy-timer-collapsed', this.navTimerCollapsed ? '1' : '0');
        } catch { /* ignore */ }
        this.updatePracticeTimerUI();
    },

    showPracticeCelebration(message) {
        if (!message) return;

        if (!this.practiceCelebrationEl) {
            const el = document.createElement('div');
            el.className = 'practice-celebration';
            el.setAttribute('role', 'status');
            el.setAttribute('aria-live', 'polite');
            document.body.appendChild(el);
            this.practiceCelebrationEl = el;
        }

        const el = this.practiceCelebrationEl;
        el.textContent = message;
        el.classList.remove('is-hiding');
        el.classList.add('is-showing');

        if (this.practiceCelebrationTimer) clearTimeout(this.practiceCelebrationTimer);
        this.practiceCelebrationTimer = setTimeout(() => {
            el.classList.remove('is-showing');
            el.classList.add('is-hiding');
        }, 3000);
    },

    checkPracticeMilestones(totalSeconds) {
        const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
        const milestones = [
            { s: 0, msg: '✅ Sesión iniciada. ¡Vamos!' },
            { s: 10 * 60, msg: '🎹 ¡10 minutos! Buen comienzo, sigue así.' },
            { s: 20 * 60, msg: '🔥 ¡20 minutos! Estás en zona de concentración.' },
            { s: 30 * 60, msg: '⭐ ¡30 minutos! Media hora de práctica pura.' },
            { s: 60 * 60, msg: '🏆 ¡1 HORA! Eso es dedicación de verdad. ¡Excelente sesión!' },
            { s: 2 * 60 * 60, msg: '🎵 ¡2 HORAS! Nivel profesional. Recuerda descansar también.' }
        ];

        for (const m of milestones) {
            if (m.s === 0) continue;
            if (sec === m.s && !this.practiceMilestonesShown.has(m.s)) {
                this.practiceMilestonesShown.add(m.s);
                this.showPracticeCelebration(m.msg);
            }
        }
    },

    practiceTimerStart() {
        if (!this.getActiveUsername()) {
            this.showNotification('Inicia sesión para registrar sesiones', 'info');
            return;
        }

        if (this.practiceTimerRunning) {
            this.practiceTimerPause();
            return;
        }

        const isResume = this.practiceTimerElapsedSec > 0;
        if (!isResume) {
            this.practiceMilestonesShown = new Set();
            this.showPracticeCelebration('⏱️ Sesión iniciada. ¡A practicar!');
        }

        this.practiceTimerRunning = true;
        this.practiceTimerStartMs = Date.now();

        if (this.practiceTimerInterval) clearInterval(this.practiceTimerInterval);
        this.practiceTimerInterval = setInterval(() => {
            this.updatePracticeTimerUI();
        }, 250);

        this.updatePracticeTimerUI();
    },

    practiceTimerPause() {
        if (!this.practiceTimerRunning) return;
        const delta = Math.max(0, Math.floor((Date.now() - this.practiceTimerStartMs) / 1000));
        this.practiceTimerElapsedSec += delta;
        this.practiceTimerStartMs = 0;
        this.practiceTimerRunning = false;

        if (this.practiceTimerInterval) {
            clearInterval(this.practiceTimerInterval);
            this.practiceTimerInterval = null;
        }
        this.updatePracticeTimerUI();
    },

    async practiceTimerStop() {
        if (!this.practiceTimerRunning && this.practiceTimerElapsedSec <= 0) return;
        if (!this.getActiveUsername()) {
            this.practiceTimerRunning = false;
            this.practiceTimerElapsedSec = 0;
            this.practiceTimerStartMs = 0;
            this.practiceMilestonesShown = new Set();
            this.updatePracticeTimerUI();
            return;
        }

        if (!await this.showConfirm('¿Terminar sesión y guardar el tiempo?')) return;

        const durationSec = this.getPracticeTimerCurrentSeconds();
        this.practiceTimerRunning = false;
        this.practiceTimerElapsedSec = 0;
        this.practiceTimerStartMs = 0;

        if (this.practiceTimerInterval) {
            clearInterval(this.practiceTimerInterval);
            this.practiceTimerInterval = null;
        }

        const sessionStr = this.formatHMS(durationSec);
        await this.savePracticeSession(durationSec);
        this.showPracticeCelebration(`✅ Sesión terminada. ¡Buen trabajo hoy! (${sessionStr})`);
        this.practiceMilestonesShown = new Set();
        this.updatePracticeTimerUI();
    },

    getPracticeTimerCurrentSeconds() {
        const runningDelta = this.practiceTimerRunning
            ? Math.max(0, Math.floor((Date.now() - this.practiceTimerStartMs) / 1000))
            : 0;
        return Math.max(0, this.practiceTimerElapsedSec + runningDelta);
    },

    updatePracticeTimerUI() {
        const navTimer = document.getElementById('nav-timer');
        const mobileBar = document.getElementById('mobile-timer-bar');

        const timeEl = document.getElementById('practice-timer-time');
        const todayEl = document.getElementById('practice-timer-today');
        const mobileTimeEl = document.getElementById('mobile-timer-time');

        const startBtn = document.getElementById('practice-timer-start');
        const stopBtn = document.getElementById('practice-timer-stop');
        const mobileStartBtn = document.getElementById('mobile-timer-start');
        const mobileStopBtn = document.getElementById('mobile-timer-stop');

        const sec = this.getPracticeTimerCurrentSeconds();
        const timeStr = this.formatHMS(sec);
        const todayStr = this.formatHMS(this.practiceTodayTotalSec);

        if (timeEl) timeEl.textContent = timeStr;
        if (todayEl) todayEl.textContent = todayStr;
        if (mobileTimeEl) mobileTimeEl.textContent = timeStr;

        const mobileTimeStripEl = document.getElementById('mobile-timer-time-strip');
        if (mobileTimeStripEl) mobileTimeStripEl.textContent = timeStr;

        if (navTimer) navTimer.classList.toggle('is-running', this.practiceTimerRunning);
        if (navTimer) navTimer.classList.toggle('is-collapsed', !!this.navTimerCollapsed);
        if (mobileBar) mobileBar.classList.toggle('is-running', this.practiceTimerRunning);
        if (mobileBar) mobileBar.classList.toggle('is-collapsed', !!this.mobileTimerCollapsed);

        if (this.practiceTimerRunning) {
            this.checkPracticeMilestones(sec);
        }

        const canUse = !!this.getActiveUsername();
        const canStart = canUse && !this.practiceTimerRunning;
        const canStop = canUse && (this.practiceTimerRunning || this.practiceTimerElapsedSec > 0);

        if (startBtn) startBtn.disabled = !canStart;
        if (stopBtn) stopBtn.disabled = !canStop;
        if (mobileStartBtn) mobileStartBtn.disabled = !canStart;
        if (mobileStopBtn) mobileStopBtn.disabled = !canStop;

        if (startBtn) startBtn.textContent = this.practiceTimerRunning ? '⏸' : '▶';
        if (mobileStartBtn) mobileStartBtn.textContent = this.practiceTimerRunning ? '⏸' : '▶';
    },

    async savePracticeSession(durationSec) {
        const sec = Math.max(0, Math.floor(Number(durationSec) || 0));
        if (sec <= 0) return;

        const { error } = await insertPracticeSession({
            duration_seconds: sec,
            date: this.getTodayDateStr()
        });

        if (error) {
            console.error('insertPracticeSession error:', error);
            this.showNotification('No se pudo guardar la sesión', 'error');
            return;
        }

        this.progressTracker.addStudyTime(sec);
        this.progressTracker.checkAndUpdateStreak();
        this.checkBadgeUpgrades();

        await this.refreshPracticeTotals();
        if (document.getElementById('progress')?.classList.contains('active')) {
            this.renderProgressSection();
        }
        this.showNotification('Sesión guardada', 'success');
    },

    async refreshPracticeTotals() {
        if (!this.getActiveUsername()) {
            this.practiceTodayTotalSec = 0;
            this.updatePracticeTimerUI();
            return;
        }

        const today = this.getTodayDateStr();
        const { data, error } = await loadPracticeSessionsRange({ fromDate: today, toDate: today });
        if (error) {
            console.error('loadPracticeSessionsRange error:', error);
            return;
        }
        const total = (data || []).reduce((acc, row) => acc + (Number(row?.duration_seconds) || 0), 0);
        this.practiceTodayTotalSec = Math.max(0, Math.floor(total));
        this.updatePracticeTimerUI();
    },

    likeArtist(artistName, event) {
        if (!artistName || typeof artistName !== 'string') {
            console.error('Nombre de artista inválido');
            return;
        }

        try {
            let likedArtists = this.safeGetLocalStorage(this.userKey('pianostudy-liked-artists'), []);
            if (!Array.isArray(likedArtists)) likedArtists = [];

            const btn = event?.target?.closest?.('.like-btn');

            if (!likedArtists.includes(artistName)) {
                likedArtists.push(artistName);
                const ok = this.safeSetLocalStorage(this.userKey('pianostudy-liked-artists'), likedArtists);
                if (!ok) {
                    this.showNotification('Error al guardar preferencia', 'error');
                    return;
                }
                if (btn) {
                    btn.classList.add('liked');
                    btn.innerHTML = '<i class="fas fa-heart"></i> Liked';
                }
                this.showNotification(`¡Te gustó ${artistName}!`, 'success');
            } else {
                likedArtists = likedArtists.filter(a => a !== artistName);
                const ok = this.safeSetLocalStorage(this.userKey('pianostudy-liked-artists'), likedArtists);
                if (!ok) {
                    this.showNotification('Error al guardar preferencia', 'error');
                    return;
                }
                if (btn) {
                    btn.classList.remove('liked');
                    btn.innerHTML = '<i class="fas fa-heart"></i> Like';
                }
                this.showNotification(`Quitaste like a ${artistName}`, 'info');
            }
        } catch (error) {
            console.error('Error al procesar likes:', error);
            this.showNotification('Error al guardar preferencia', 'error');
        }
    },

    shareArtist(artistName, description) {
        const shareText = `Escuchando a ${artistName} - ${description} en PianoStudy App`;
        const shareUrl = `https://www.youtube.com/results?search_query=${artistName.replace(' ', '+')}+piano`;
        
        if (navigator.share) {
            // Usar API de compartir nativa
            navigator.share({
                title: `PianoStudy - ${artistName}`,
                text: shareText,
                url: shareUrl
            });
        } else {
            // Copiar al portapapeles
            const textToCopy = `${shareText}\n${shareUrl}`;
            navigator.clipboard.writeText(textToCopy).then(() => {
                this.showNotification('¡Enlace copiado al portapapeles!', 'success');
            }).catch(() => {
                // Fallback: abrir en nueva ventana
                window.open(shareUrl, '_blank');
            });
        }
        
        // Agregar a piezas favoritas
        this.addToFavoritePieces(artistName, description, shareUrl);
    },

    addToFavoritePieces(artistName, description, url) {
        if (!artistName || typeof artistName !== 'string') return;
        if (description !== undefined && description !== null && typeof description !== 'string') return;
        if (!url || typeof url !== 'string') return;

        let favoritePieces = this.safeGetLocalStorage(this.userKey('pianostudy-favorite-pieces'), []);
        if (!Array.isArray(favoritePieces)) favoritePieces = [];
        
        const piece = {
            id: Date.now(),
            artistName: artistName,
            description: description,
            url: url,
            timestamp: new Date().toISOString(),
            listened: true,
            youtubeUrl: url // Agregar URL de YouTube para fácil acceso
        };
        
        // Evitar duplicados
        if (!favoritePieces.find(p => p.artistName === artistName && p.description === description)) {
            favoritePieces.unshift(piece);
            const ok = this.safeSetLocalStorage(this.userKey('pianostudy-favorite-pieces'), favoritePieces);
            if (!ok) {
                this.showNotification('Error al guardar favorito', 'error');
                return;
            }
            
            // Mostrar diálogo para agregar URL de la canción específica
            this.showAddSongUrlDialog(piece);
            
            this.showNotification(`¡${artistName} agregado a tus piezas favoritas!`, 'success');
            this.updateFavoritePiecesList();
        }
    },

    showAddSongUrlDialog(piece) {
        const modalBody = document.getElementById('modal-body');
        modalBody.innerHTML = `
            <h3>🎵 Agregar URL de la Canción</h3>
            <div class="form-group">
                <label>Artista: <strong>${escapeHtml(piece.artistName)}</strong></label>
            </div>
            <div class="form-group">
                <label>Descripción: <strong>${escapeHtml(piece.description)}</strong></label>
            </div>
            <div class="form-group">
                <label for="song-url">URL de la canción específica que te gustó:</label>
                <input type="url" id="song-url" placeholder="https://youtube.com/watch?v=..." 
                       style="width: 100%; padding: 0.5rem; background: var(--bg-tertiary); 
                              border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-primary);">
            </div>
            <div class="form-group">
                <label for="song-title">Título de la canción (opcional):</label>
                <input type="text" id="song-title" placeholder="Ej: Blue Monk" 
                       style="width: 100%; padding: 0.5rem; background: var(--bg-tertiary); 
                              border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-primary);">
            </div>
            <div class="form-actions">
                <button class="btn-primary" data-action="fav-save-song-url" data-id="${piece.id}">
                    <i class="fas fa-save"></i> Guardar URL
                </button>
                <button class="btn-secondary" data-action="modal-close">
                    <i class="fas fa-times"></i> Cancelar
                </button>
            </div>
        `;
        
        document.getElementById('modal').classList.remove('hidden');
    },

    saveSongUrl(pieceId) {
        if (!pieceId || typeof pieceId !== 'number') return;

        const songUrl = String(document.getElementById('song-url')?.value || '').trim();
        const songTitle = String(document.getElementById('song-title')?.value || '').trim();
        
        if (!songUrl) {
            this.showNotification('Por favor ingresa una URL válida', 'info');
            return;
        }
        
        // Actualizar la pieza favorita con la URL de la canción
        let favoritePieces = this.safeGetLocalStorage(this.userKey('pianostudy-favorite-pieces'), []);
        if (!Array.isArray(favoritePieces)) favoritePieces = [];
        const pieceIndex = favoritePieces.findIndex(p => p.id === pieceId);
        
        if (pieceIndex !== -1) {
            favoritePieces[pieceIndex].songUrl = songUrl;
            favoritePieces[pieceIndex].songTitle = songTitle || favoritePieces[pieceIndex].artistName;
            const ok = this.safeSetLocalStorage(this.userKey('pianostudy-favorite-pieces'), favoritePieces);
            if (!ok) {
                this.showNotification('Error al guardar favorito', 'error');
                return;
            }
            
            this.showNotification('URL de la canción guardada', 'success');
            this.updateFavoritePiecesList();
            this.closeModal();
        }
    },

    updateFavoritePiecesList() {
        const favoritePieces = this.safeGetLocalStorage(this.userKey('pianostudy-favorite-pieces'), []);
        const pieces = Array.isArray(favoritePieces) ? favoritePieces : [];
        
        // Actualizar sección de artistas si existe
        const artistsSection = document.getElementById('artists');
        if (artistsSection) {
            // Agregar sección de piezas favoritas
            let favoritesSection = document.getElementById('favorite-pieces');
            if (!favoritesSection) {
                favoritesSection = document.createElement('div');
                favoritesSection.id = 'favorite-pieces';
                favoritesSection.className = 'style-section';
                favoritesSection.innerHTML = `
                    <div class="favorites-header">
                        <h3><i class="fas fa-heart"></i> Mis Piezas Favoritas</h3>
                        <button class="btn-small" data-action="fav-manual-open">
                            <i class="fas fa-plus"></i> Agregar URL
                        </button>
                    </div>
                    <div class="favorite-pieces-list"></div>
                `;
                const artistsGrid = artistsSection.querySelector('.artists-grid');
                if (artistsGrid) {
                    artistsGrid.prepend(favoritesSection);
                }
            }
            
            const listContainer = favoritesSection.querySelector('.favorite-pieces-list');
            if (listContainer) {
                listContainer.innerHTML = pieces.map(piece => `
                    <div class="favorite-piece-item">
                        <div class="piece-info">
                            <h4>${escapeHtml(piece.artistName)}</h4>
                            <p>${escapeHtml(piece.description)}</p>
                            ${piece.songTitle ? `<small><strong>Canción:</strong> ${escapeHtml(piece.songTitle)}</small>` : ''}
                            <small>Escuchado: ${new Date(piece.timestamp).toLocaleDateString()}</small>
                        </div>
                        <div class="piece-actions">
                            <button class="btn-small youtube-btn" data-url="${escapeHtml(piece.url)}">
                                <i class="fab fa-youtube"></i> YouTube
                            </button>
                            ${piece.songUrl ? `
                                <button class="btn-small youtube-btn" data-url="${escapeHtml(piece.songUrl)}">
                                    <i class="fas fa-music"></i> Canción
                                </button>
                            ` : ''}
                            <button class="btn-small" data-action="fav-remove" data-id="${piece.id}">
                                <i class="fas fa-times"></i>
                            </button>
                        </div>
                    </div>
                `).join('');
            }
        }
    },

    removeFavoritePiece(pieceId) {
        if (!pieceId || typeof pieceId !== 'number') return;
        try {
            let favoritePieces = this.safeGetLocalStorage(this.userKey('pianostudy-favorite-pieces'), []);
            if (!Array.isArray(favoritePieces)) favoritePieces = [];
            favoritePieces = favoritePieces.filter(p => p.id !== pieceId);
            const ok = this.safeSetLocalStorage(this.userKey('pianostudy-favorite-pieces'), favoritePieces);
            if (!ok) {
                this.showNotification('Error al eliminar favorito', 'error');
                return;
            }
            this.showNotification('Pieza eliminada de favoritos', 'info');
            this.updateFavoritePiecesList();
        } catch (e) {
            console.error('Error eliminando favorito:', e);
            this.showNotification('Error al eliminar favorito', 'error');
        }
    },

    openManualFavoriteDialog() {
        const modalBody = document.getElementById('modal-body');
        modalBody.innerHTML = `
            <h3>Agregar pieza favorita</h3>
            <div class="form-group">
                <label for="fav-artist">Artista / Compositor:</label>
                <input type="text" id="fav-artist" placeholder="Ej: Thelonious Monk">
            </div>
            <div class="form-group">
                <label for="fav-title">Título (opcional):</label>
                <input type="text" id="fav-title" placeholder="Ej: Round Midnight">
            </div>
            <div class="form-group">
                <label for="fav-url">URL (YouTube):</label>
                <input type="url" id="fav-url" placeholder="https://www.youtube.com/watch?v=...">
            </div>
            <div class="form-actions">
                <button class="btn-primary" data-action="fav-save-manual">
                    <i class="fas fa-save"></i> Guardar
                </button>
                <button class="btn-secondary" data-action="modal-close">
                    <i class="fas fa-times"></i> Cancelar
                </button>
            </div>
        `;
        document.getElementById('modal').classList.remove('hidden');
    },

    saveManualFavorite() {
        const artistName = String(document.getElementById('fav-artist')?.value || '').trim();
        const songTitle = String(document.getElementById('fav-title')?.value || '').trim();
        const songUrl = String(document.getElementById('fav-url')?.value || '').trim();

        if (!songUrl) {
            this.showNotification('Por favor ingresa una URL', 'info');
            return;
        }

        let favoritePieces = this.safeGetLocalStorage(this.userKey('pianostudy-favorite-pieces'), []);
        if (!Array.isArray(favoritePieces)) favoritePieces = [];
        const piece = {
            id: Date.now(),
            artistName: artistName || (songTitle ? 'Favorito' : 'Favorito'),
            description: songTitle ? `Canción: ${songTitle}` : 'Canción guardada manualmente',
            url: songUrl,
            timestamp: new Date().toISOString(),
            listened: true,
            songUrl,
            songTitle: songTitle || undefined
        };

        favoritePieces.unshift(piece);
        const ok = this.safeSetLocalStorage(this.userKey('pianostudy-favorite-pieces'), favoritePieces);
        if (!ok) {
            this.showNotification('Error al guardar favorito', 'error');
            return;
        }

        this.showNotification('Pieza favorita agregada', 'success');
        this.updateFavoritePiecesList();
        this.closeModal();
    },

    showAddLickModal() {
        const modalBody = document.getElementById('modal-body');
        modalBody.innerHTML = `
            <h3>Agregar Nuevo Lick</h3>
            <form id="lick-form">
                <div class="form-group">
                    <label for="lick-name">Nombre:</label>
                    <input type="text" id="lick-name" required>
                </div>
                <div class="form-group">
                    <label for="lick-style">Estilo:</label>
                    <select id="lick-style" required>
                        <option value="blues">Blues</option>
                        <option value="bebop">Bebop</option>
                        <option value="hardbop">Hard-bop</option>
                        <option value="latinjazz">Latin Jazz</option>
                        <option value="soncubano">Son Cubano</option>
                        <option value="bolero">Bolero</option>
                        <option value="jazzcolombiano">Jazz Colombiano</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="lick-description">Descripción:</label>
                    <textarea id="lick-description" rows="3"></textarea>
                </div>
                <div class="form-group">
                    <label for="lick-audio">Audio (opcional):</label>
                    <input type="file" id="lick-audio" accept="audio/*">
                </div>
                <button type="submit" class="btn-primary">Guardar Lick</button>
            </form>
        `;
        
        document.getElementById('modal').classList.remove('hidden');
        
        document.getElementById('lick-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveLick();
        });
    },

    async saveLick() {
        if (!this.getActiveUsername()) {
            this.showNotification('Debes iniciar sesión para guardar licks', 'error');
            return;
        }

        const name = String(document.getElementById('lick-name')?.value || '').trim();
        const style = String(document.getElementById('lick-style')?.value || '').trim();
        const notes = String(document.getElementById('lick-description')?.value || '').trim();

        if (!name) {
            this.showNotification('Nombre de lick inválido', 'error');
            return;
        }

        const submitBtn = document.querySelector('#lick-form button[type="submit"]');
        if (submitBtn) submitBtn.disabled = true;

        const { data, error } = await insertLick({
            name,
            style,
            notes,
            order_index: this.licks.length
        });

        if (submitBtn) submitBtn.disabled = false;

        if (error) {
            this.showNotification(ERR_MSG, 'error');
            console.error('insertLick error:', error);
            return;
        }

        this.closeModal();
        this.showNotification('Lick guardado', 'success');
        await this.loadLicks();
    },

    async loadLicks() {
        const licksList = document.getElementById('licks-list');
        if (!licksList) return;

        this.cleanupContainerObjectURLs(licksList);

        if (!this.getActiveUsername()) {
            licksList.innerHTML = `<div class="auth-required-banner">
                <p>Inicia sesión para guardar tu progreso</p>
                <button class="auth-header-btn auth-header-btn--primary" onclick="document.getElementById('auth-open-login')?.click()">Ingresar</button>
            </div>`;
            return;
        }

        licksList.innerHTML = skeletonHTML(3);

        const { data, error } = await loadLicksFromDB();
        if (error) {
            licksList.innerHTML = errorHTML(ERR_MSG, () => this.loadLicks());
            return;
        }

        this.licks = (data || []).map(l => ({
            id: l.id,
            name: l.name || '',
            style: l.style || '',
            description: l.notes || '',
            audioBlob: null,
            audioUrl: l.file_path ? getRecordingPublicUrl(l.file_path) : null,
            filePath: l.file_path || null,
            order_index: l.order_index ?? 0,
            createdAt: l.created_at || new Date().toISOString()
        }));

        const filter = document.getElementById('style-filter');
        const filterValue = filter ? filter.value : 'all';
        
        const filteredLicks = filterValue === 'all' 
            ? this.licks 
            : this.licks.filter(lick => lick.style === filterValue);

        if (filteredLicks.length === 0) {
            licksList.innerHTML = `<div class="licks-controls">
                <button class="btn-small" data-action="lick-select-all"><i class="fas fa-check-square"></i> Seleccionar todos</button>
                <button class="btn-small" data-action="lick-deselect-all"><i class="fas fa-square"></i> Deseleccionar todos</button>
                <button class="btn-small btn-danger" data-action="lick-delete-selected"><i class="fas fa-trash"></i> Eliminar seleccionados (0)</button>
            </div><p class="empty-state-msg">Aún no tienes licks guardados. ¡Agrega el primero!</p>`;
            return;
        }
        
        // Agregar controles de selección múltiple
        const controlsHtml = `
            <div class="licks-controls">
                <button class="btn-small" data-action="lick-select-all">
                    <i class="fas fa-check-square"></i> Seleccionar todos
                </button>
                <button class="btn-small" data-action="lick-deselect-all">
                    <i class="fas fa-square"></i> Deseleccionar todos
                </button>
                <button class="btn-small btn-danger" data-action="lick-delete-selected">
                    <i class="fas fa-trash"></i> Eliminar seleccionados (${this.selectedLicks.size})
                </button>
            </div>
        `;
        
        licksList.innerHTML = controlsHtml + filteredLicks.map(lick => {
            const isSelected = this.selectedLicks.has(lick.id);
            const hasLocalBlob = lick.audioBlob instanceof Blob;
            const hasAudio = hasLocalBlob || !!lick.audioUrl;
            
            let audioElement = '';
            if (hasLocalBlob) {
                const url = this.createTrackedObjectURL(lick.audioBlob);
                audioElement = `<audio controls data-object-url="${url}" src="${url}"></audio>`;
            } else if (lick.audioUrl) {
                audioElement = `<audio controls src="${lick.audioUrl}"></audio>`;
            }
            
            return `
                <div class="lick-card ${isSelected ? 'selected' : ''}" draggable="true" data-lick-id="${lick.id}">
                    <div class="lick-header">
                        <input type="checkbox" class="lick-checkbox" 
                               ${isSelected ? 'checked' : ''} 
                               data-id="${lick.id}">
                        <h4>${escapeHtml(lick.name)}</h4>
                        <span class="style-tag">${escapeHtml(lick.style)}</span>
                        ${hasAudio ? '' : '<span class="style-tag">Sin audio</span>'}
                    </div>
                    <p>${escapeHtml(lick.description)}</p>
                    ${audioElement}
                    <div class="lick-actions">
                        <button class="btn-small" data-action="lick-play" data-id="${lick.id}" ${hasAudio ? '' : 'disabled'}>
                            <i class="fas fa-play"></i> Reproducir
                        </button>
                        <button class="btn-small" data-action="study-add" data-id="${lick.id}" ${hasAudio ? '' : 'disabled'}>
                            <i class="fas fa-plus"></i> Study
                        </button>
                        <button class="btn-small" data-action="lick-download" data-id="${lick.id}">
                            <i class="fas fa-download"></i> Descargar
                        </button>
                        <button class="btn-small" data-action="lick-delete" data-id="${lick.id}">
                            <i class="fas fa-trash"></i> Eliminar
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        licksList.querySelectorAll('.lick-card[draggable="true"]').forEach((card) => {
            card.addEventListener('dragstart', (e) => {
                const id = card.getAttribute('data-lick-id');
                if (e.dataTransfer && id) {
                    e.dataTransfer.setData('text/lick-id', id);
                    e.dataTransfer.effectAllowed = 'copy';
                }
            });
        });

        licksList.querySelectorAll('audio[data-object-url]').forEach((el) => {
            const url = el.getAttribute('data-object-url');
            if (url) el.onended = () => this.cleanupObjectURL(url);
        });
    },

    filterLicks(style) {
        this.loadLicks();
    },

    selectLick(lickId) {
        const lick = this.licks.find(l => l.id === lickId);
        if (lick) {
            this.showNotification(`Lick seleccionado: ${lick.name}`, 'info');
        }
    },

    playLick(lickId) {
        const lick = this.licks.find(l => l.id === lickId);
        if (!lick) return;

        const hasLocalBlob = lick.audioBlob instanceof Blob;
        if (!hasLocalBlob && !lick.audioUrl) {
            this.showNotification('Este lick no tiene audio disponible.', 'info');
            return;
        }

        // Stop any currently playing audio
        if (this.currentPlayingAudio) {
            this.currentPlayingAudio.pause();
            this.currentPlayingAudio = null;
        }

        let url;
        let isObjectUrl = false;
        if (hasLocalBlob) {
            url = this.createTrackedObjectURL(lick.audioBlob);
            isObjectUrl = true;
        } else {
            url = lick.audioUrl;
        }

        const audio = new Audio(url);
        audio.preload = 'auto';

        audio.addEventListener('ended', () => {
            this.currentPlayingAudio = null;
            if (isObjectUrl) this.cleanupObjectURL(url);
        });

        audio.addEventListener('error', () => {
            this.currentPlayingAudio = null;
            if (isObjectUrl) this.cleanupObjectURL(url);
            this.showNotification('Error al reproducir el lick.', 'error');
        });

        audio.currentTime = Math.max(0, lick.startTime || 0);
        audio.play();
        this.currentPlayingAudio = audio;

        if (lick.duration) {
            setTimeout(() => {
                if (this.currentPlayingAudio === audio) {
                    audio.pause();
                    this.currentPlayingAudio = null;
                    if (isObjectUrl) this.cleanupObjectURL(url);
                }
            }, lick.duration * 1000);
        }
    },

    // Funciones para selección múltiple
    toggleLickSelection(lickId) {
        if (this.selectedLicks.has(lickId)) {
            this.selectedLicks.delete(lickId);
        } else {
            this.selectedLicks.add(lickId);
        }
        const card = document.querySelector(`[data-lick-id="${lickId}"]`);
        if (card) {
            card.classList.toggle('selected', this.selectedLicks.has(lickId));
            const cb = card.querySelector('.lick-checkbox');
            if (cb) cb.checked = this.selectedLicks.has(lickId);
        }
        const counter = document.getElementById('selection-count');
        if (counter) {
            counter.textContent = this.selectedLicks.size > 0
                ? `${this.selectedLicks.size} seleccionado(s)`
                : '';
        }
    },

    selectAllLicks() {
        const filter = document.getElementById('style-filter');
        const filterValue = filter ? filter.value : 'all';
        
        const filteredLicks = filterValue === 'all' 
            ? this.licks 
            : this.licks.filter(lick => lick.style === filterValue);
        
        filteredLicks.forEach(lick => this.selectedLicks.add(lick.id));
        this.loadLicks();
    },

    deselectAllLicks() {
        this.selectedLicks.clear();
        this.loadLicks();
    },

    async deleteSelectedLicks() {
        if (this.selectedLicks.size === 0) {
            this.showNotification('No hay licks seleccionados para eliminar', 'info');
            return;
        }
        const countToDelete = this.selectedLicks.size;
        if (!await this.showConfirm(`¿Estás seguro de eliminar ${countToDelete} licks seleccionados?`)) return;

        const ids = [...this.selectedLicks];
        const results = await Promise.all(ids.map(id => deleteLick(id)));
        const failed = results.filter(r => r.error).length;

        this.selectedLicks.clear();
        if (failed > 0) this.showNotification(`${failed} licks no pudieron eliminarse`, 'error');
        else this.showNotification(`${countToDelete} licks eliminados`, 'success');
        await this.loadLicks();
    },

    downloadLick(lickId) {
        const lick = this.licks.find(l => l.id === lickId);
        if (lick && lick.audioBlob) {
            const url = this.createTrackedObjectURL(lick.audioBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${sanitizeFileName(lick.name)}.wav`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            this.cleanupObjectURL(url);
            
            this.showNotification(`Descargando ${lick.name}`, 'success');
        }
    },

    async deleteLick(lickId) {
        if (!await this.showConfirm('¿Estás seguro de eliminar este lick?')) return;
        const { error } = await deleteLick(lickId);
        if (error) {
            this.showNotification(ERR_MSG, 'error');
            return;
        }
        this.showNotification('Lick eliminado', 'info');
        await this.loadLicks();
    },

    performSearch() {
        const query = document.getElementById('search-input').value.toLowerCase();
        const results = document.getElementById('search-results');
        
        if (!query) {
            results.innerHTML = '<p>Ingresa un término de búsqueda</p>';
            return;
        }
        
        // Simple search implementation
        const searchResults = [];
        
        // Search in licks
        this.licks.forEach(lick => {
            if (lick.name.toLowerCase().includes(query) || 
                lick.description.toLowerCase().includes(query)) {
                searchResults.push({
                    type: 'lick',
                    title: lick.name,
                    description: lick.description,
                    style: lick.style
                });
            }
        });
        
        results.innerHTML = searchResults.map(result => `
            <div class="search-result-card">
                <h4>${escapeHtml(result.title)}</h4>
                <p>${escapeHtml(result.description)}</p>
                ${result.url ? `
                    <button class="btn-small" data-action="open-url" data-url="${escapeHtml(result.url)}">
                        <i class="fas fa-external-link-alt"></i> Abrir
                    </button>
                ` : ''}
            </div>
        `).join('');
    },

    updateRecommendations() {
        // Update recommended lick
        if (this.licks.length > 0) {
            const randomLick = this.licks[Math.floor(Math.random() * this.licks.length)];
            document.getElementById('recommended-lick').textContent = randomLick.name;
        } else {
            document.getElementById('recommended-lick').textContent = 'Agrega tu primer lick';
        }
        
        // Update artist recommendation
        const artists = [
            'Oscar Peterson - Maestro del swing',
            'Bill Evans - Pionero del jazz modal',
            'Chucho Valdés - Titán del jazz cubano',
            'Herbie Hancock - Innovador del jazz-funk'
        ];
        const randomArtist = artists[Math.floor(Math.random() * artists.length)];
        document.getElementById('artist-recommendation').textContent = randomArtist;
        this.artistsManager?.renderDashboardCard();
    },

    // ===== PROGRESS SECTION =====

    checkBadgeUpgrades() {
        const stats = this.progressTracker.getStats(this.licks.length);
        const upgrades = this.progressTracker.evaluateBadges(stats);
        upgrades.forEach((u, i) => {
            setTimeout(() => this.showBadgeToast(u), i * 500);
        });
    },

    showBadgeToast(upgrade) {
        const color = ProgressTracker.LEVEL_COLORS[upgrade.level] || '#667eea';
        const toast = document.createElement('div');
        toast.className = 'badge-toast';
        toast.style.borderLeft = `4px solid ${color}`;

        const existing = document.querySelectorAll('.badge-toast');
        const offset = 20 + existing.length * 80;
        toast.style.bottom = offset + 'px';

        toast.innerHTML = `
            <div class="toast-title">${upgrade.icon} Nueva medalla!</div>
            <div style="color:${color};font-weight:700">${upgrade.badgeName} → ${upgrade.levelName}</div>
            <div class="toast-desc">"${upgrade.desc}"</div>
        `;
        document.body.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'slideDown 0.4s ease forwards';
            setTimeout(() => toast.remove(), 400);
        }, 4000);
    },

    renderProgressSection() {
        if (!this.getActiveUsername()) {
            const section = document.getElementById('progress');
            if (section) {
                section.innerHTML = `<h2>Tu Progreso</h2>
                    <div class="auth-required-banner">
                        <p>Inicia sesión para ver tu progreso</p>
                        <button class="auth-header-btn auth-header-btn--primary" onclick="document.getElementById('auth-open-login')?.click()">Ingresar</button>
                    </div>`;
            }
            return;
        }
        const stats = this.progressTracker.getStats(this.licks.length);

        // Metrics
        const h = Math.floor(stats.totalStudySeconds / 3600);
        const m = Math.floor((stats.totalStudySeconds % 3600) / 60);
        const timeEl = document.getElementById('metric-study-time');
        if (timeEl) timeEl.textContent = `${h}h ${m}m`;

        const licksEl = document.getElementById('metric-licks');
        if (licksEl) licksEl.textContent = stats.totalLicks;

        const recEl = document.getElementById('metric-recordings');
        if (recEl) recEl.textContent = stats.totalRecordings;

        const streakEl = document.getElementById('metric-streak');
        if (streakEl) streakEl.textContent = `${stats.currentStreak} días`;

        // Motivation
        const motEl = document.getElementById('progress-motivation');
        if (motEl) motEl.textContent = this.progressTracker.getMotivationalPhrase(stats.currentStreak);

        // Badges
        this.renderBadges(stats);

        // Chart + sync study-time metric from Supabase
        this.loadPracticeSessionsForChart().then(() => {
            this.renderProgressChart();
            this._updateStudyTimeMetricFromSupabase();
        });
    },

    async loadPracticeSessionsForChart() {
        const end = new Date();
        const start = new Date(end);
        start.setDate(start.getDate() - 29);

        const fromDate = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
        const toDate = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;

        const { data, error } = await loadPracticeSessionsRange({ fromDate, toDate });
        if (error) {
            console.error('loadPracticeSessionsRange error:', error);
            this.practiceChartDays = null;
            return;
        }

        const byDate = {};
        (data || []).forEach((row) => {
            const d = String(row?.date || '').slice(0, 10);
            if (!d) return;
            byDate[d] = (byDate[d] || 0) + (Number(row?.duration_seconds) || 0);
        });

        const days = [];
        for (let i = 29; i >= 0; i--) {
            const d = new Date(end);
            d.setDate(d.getDate() - i);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            const sec = byDate[key] || 0;
            const minutes = Math.round((sec / 60) * 10) / 10;
            days.push({ date: key, minutes, dayObj: d });
        }

        const active = days.filter(d => d.minutes > 0);
        const avg = active.length ? active.reduce((a, d) => a + d.minutes, 0) / active.length : 0;
        const best = active.length ? Math.max(...active.map(d => d.minutes)) : 0;

        this.practiceChartDays = days;
        this.practiceChartStats = { avg: Math.round(avg), best: Math.round(best) };

        // Store all-time total seconds from this load (last 30 days is enough for the metric)
        const totalSec = days.reduce((acc, d) => acc + Math.round(d.minutes * 60), 0);
        this._supabaseTotalStudySec = totalSec;
    },

    async _updateStudyTimeMetricFromSupabase() {
        // Load all-time total from practice_sessions (not just 30 days)
        const { data, error } = await loadPracticeSessionsRange({
            fromDate: '2000-01-01',
            toDate: this.getTodayDateStr()
        });
        if (error || !data) return;
        const totalSec = (data || []).reduce((acc, row) => acc + (Number(row?.duration_seconds) || 0), 0);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const timeEl = document.getElementById('metric-study-time');
        if (timeEl) timeEl.textContent = `${h}h ${m}m`;
    },

    renderBadges(stats) {
        const grid = document.getElementById('badges-grid');
        if (!grid) return;

        const BADGES = ProgressTracker.BADGES;
        const LEVEL_KEYS = ProgressTracker.LEVEL_KEYS;
        const LEVEL_COLORS = ProgressTracker.LEVEL_COLORS;
        const saved = this.progressTracker.badges;

        grid.innerHTML = BADGES.map(badge => {
            const val = stats[badge.metric] || 0;
            const currentLevel = saved[badge.id] || null;
            const currentIdx = currentLevel ? LEVEL_KEYS.indexOf(currentLevel) : -1;

            let levelName = 'Sin nivel';
            let levelClass = 'no-level';
            let levelColor = '#555';
            let progressHtml = '';

            if (currentIdx >= 0) {
                const lvl = badge.levels[currentIdx];
                levelName = lvl.name;
                levelClass = '';
                levelColor = LEVEL_COLORS[LEVEL_KEYS[currentIdx]];
            }

            if (currentIdx >= 2) {
                // Gold - max level
                progressHtml = `<div class="badge-max">Nivel máximo ✨</div>`;
            } else {
                const nextIdx = currentIdx + 1;
                const nextLvl = badge.levels[nextIdx];
                const prevThreshold = currentIdx >= 0 ? badge.levels[currentIdx].threshold : 0;
                const range = nextLvl.threshold - prevThreshold;
                const progress = Math.min(1, Math.max(0, (val - prevThreshold) / range));
                const pct = Math.round(progress * 100);
                const fillColor = nextIdx <= 2 ? LEVEL_COLORS[LEVEL_KEYS[nextIdx]] : '#667eea';

                progressHtml = `
                    <div class="badge-progress-bar">
                        <div class="badge-progress-fill" style="width:${pct}%;background:${fillColor}"></div>
                    </div>
                    <div class="badge-progress-text">${Math.round(val)} / ${nextLvl.threshold} para ${nextLvl.name}</div>
                `;
            }

            const cardClass = currentIdx >= 0 ? `level-${LEVEL_KEYS[currentIdx]}` : '';

            return `
                <div class="badge-card ${cardClass}">
                    <div class="badge-icon">${badge.icon}</div>
                    <div class="badge-name">${badge.name}</div>
                    <div class="badge-level ${levelClass}" style="color:${levelColor}">${levelName}</div>
                    ${progressHtml}
                </div>
            `;
        }).join('');
    },

    renderProgressChart() {
        const canvas = document.getElementById('progress-chart');
        if (!canvas) return;

        const container = canvas.parentElement;
        const dpr = window.devicePixelRatio || 1;
        const cssWidth = container.clientWidth;
        const cssHeight = 200;
        canvas.width = cssWidth * dpr;
        canvas.height = cssHeight * dpr;
        canvas.style.width = cssWidth + 'px';
        canvas.style.height = cssHeight + 'px';

        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);

        const days = Array.isArray(this.practiceChartDays) ? this.practiceChartDays : this.progressTracker.getLast30DaysData();
        const chartStats = Array.isArray(this.practiceChartDays) ? this.practiceChartStats : this.progressTracker.getChartStats(days);

        const emptyEl = document.getElementById('progress-chart-empty');
        const hasAny = (days || []).some(d => (Number(d.minutes) || 0) > 0);
        if (emptyEl) emptyEl.classList.toggle('hidden', hasAny);
        canvas.classList.toggle('hidden', !hasAny);

        const avgEl = document.getElementById('chart-avg');
        if (avgEl) avgEl.textContent = `Promedio: ${chartStats.avg}m/día`;
        const bestEl = document.getElementById('chart-best');
        if (bestEl) bestEl.textContent = `Mejor día: ${chartStats.best}m`;

        if (!hasAny) {
            const tip = document.getElementById('chart-tooltip');
            if (tip) tip.classList.add('hidden');
            return;
        }

        const pad = { top: 20, right: 20, bottom: 30, left: 45 };
        const w = cssWidth - pad.left - pad.right;
        const h = cssHeight - pad.top - pad.bottom;

        const maxMin = Math.max(30, ...days.map(d => d.minutes));
        const yMax = Math.ceil(maxMin / 15) * 15;

        // Background
        ctx.fillStyle = '#0d0d1a';
        ctx.fillRect(0, 0, cssWidth, cssHeight);

        // Grid lines
        ctx.strokeStyle = '#1e1e2e';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        const ySteps = [0, Math.round(yMax / 3), Math.round(yMax * 2 / 3), yMax];
        ctx.font = '11px sans-serif';
        ctx.fillStyle = '#666';
        ctx.textAlign = 'right';
        ySteps.forEach(val => {
            const y = pad.top + h - (val / yMax) * h;
            ctx.beginPath();
            ctx.moveTo(pad.left, y);
            ctx.lineTo(pad.left + w, y);
            ctx.stroke();
            ctx.fillText(val + '', pad.left - 6, y + 4);
        });
        ctx.setLineDash([]);

        // X axis labels (Mondays only)
        ctx.fillStyle = '#888';
        ctx.textAlign = 'center';
        const stepX = w / (days.length - 1 || 1);
        days.forEach((d, i) => {
            if (d.dayObj.getDay() === 1) {
                const x = pad.left + i * stepX;
                const dd = String(d.dayObj.getDate()).padStart(2, '0');
                const mm = String(d.dayObj.getMonth() + 1).padStart(2, '0');
                ctx.fillText(`${dd}/${mm}`, x, cssHeight - 8);
            }
        });

        // Line + area
        const points = days.map((d, i) => ({
            x: pad.left + i * stepX,
            y: pad.top + h - (Math.min(d.minutes, yMax) / yMax) * h,
            mins: d.minutes
        }));

        // Area fill
        const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + h);
        grad.addColorStop(0, 'rgba(102,126,234,0.3)');
        grad.addColorStop(1, 'rgba(102,126,234,0.0)');
        ctx.beginPath();
        ctx.moveTo(points[0].x, pad.top + h);
        points.forEach(p => {
            if (p.mins > 0) ctx.lineTo(p.x, p.y);
            else ctx.lineTo(p.x, pad.top + h);
        });
        ctx.lineTo(points[points.length - 1].x, pad.top + h);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        // Line
        ctx.beginPath();
        ctx.strokeStyle = '#667eea';
        ctx.lineWidth = 2;
        let started = false;
        points.forEach(p => {
            if (p.mins > 0) {
                if (!started) { ctx.moveTo(p.x, p.y); started = true; }
                else ctx.lineTo(p.x, p.y);
            } else {
                started = false;
            }
        });
        ctx.stroke();

        // Points
        points.forEach(p => {
            ctx.beginPath();
            if (p.mins > 0) {
                ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
                ctx.fillStyle = '#667eea';
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.stroke();
            } else {
                ctx.arc(p.x, pad.top + h, 2, 0, Math.PI * 2);
                ctx.fillStyle = '#333';
                ctx.fill();
            }
        });

        // Store points for tooltip
        this._chartPoints = points;
        this._chartDays = days;
        this._chartPad = pad;
        this._chartH = h;

        // Tooltip events
        canvas.onmousemove = (e) => this._handleChartHover(e);
        canvas.onmouseleave = () => {
            const tip = document.getElementById('chart-tooltip');
            if (tip) tip.classList.add('hidden');
        };
        canvas.ontouchmove = (e) => {
            e.preventDefault();
            const touch = e.touches[0];
            const rect = canvas.getBoundingClientRect();
            this._showChartTooltip(touch.clientX - rect.left, touch.clientY - rect.top);
        };
        canvas.ontouchend = () => {
            const tip = document.getElementById('chart-tooltip');
            if (tip) tip.classList.add('hidden');
        };

        // ResizeObserver (with width guard to prevent infinite loop)
        this._chartLastWidth = cssWidth;
        if (this._chartResizeObserver) this._chartResizeObserver.disconnect();
        this._chartResizeObserver = new ResizeObserver(() => {
            const newW = container.clientWidth;
            if (newW && newW !== this._chartLastWidth) {
                this._chartLastWidth = newW;
                this.renderProgressChart();
            }
        });
        this._chartResizeObserver.observe(container);
    },

    _handleChartHover(e) {
        const rect = e.target.getBoundingClientRect();
        this._showChartTooltip(e.clientX - rect.left, e.clientY - rect.top);
    },

    _showChartTooltip(mx, my) {
        const tip = document.getElementById('chart-tooltip');
        if (!tip || !this._chartPoints) return;

        const pts = this._chartPoints;
        let closest = 0;
        let minDist = Infinity;
        pts.forEach((p, i) => {
            const d = Math.abs(p.x - mx);
            if (d < minDist) { minDist = d; closest = i; }
        });

        if (minDist > 30) {
            tip.classList.add('hidden');
            return;
        }

        const day = this._chartDays[closest];
        const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
        const dayName = dayNames[day.dayObj.getDay()];
        const dd = String(day.dayObj.getDate()).padStart(2, '0');
        const mm = String(day.dayObj.getMonth() + 1).padStart(2, '0');
        const mins = Math.round(day.minutes);

        tip.innerHTML = `<strong>${dayName} ${dd}/${mm}</strong><br>${mins > 0 ? mins + ' min estudiados' : 'Sin sesión'}`;
        tip.classList.remove('hidden');

        const p = pts[closest];
        let tx = p.x + 10;
        let ty = (p.mins > 0 ? p.y : this._chartPad.top + this._chartH) - 40;
        if (tx + 150 > this._chartPoints[this._chartPoints.length - 1].x + 20) tx = p.x - 160;
        if (ty < 0) ty = 10;
        tip.style.left = tx + 'px';
        tip.style.top = ty + 'px';
    },
};
