// app-ui.js — DOM manipulation y manejo de eventos de PianoStudyApp.
// Mezclado sobre PianoStudyApp.prototype en app-init.js.

import { db } from '../modules/supabase-client.js';
import { toast } from '../modules/Toast.js';

export const uiMixin = {
    setupEventListeners() {
        // Navigation
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                const section = e.currentTarget.dataset.section;
                this.showSection(section);
            });
        });

        // Recording controls
        document.getElementById('record-btn').addEventListener('click', () => this.toggleRecording());
        document.getElementById('play-btn').addEventListener('click', () => this.playRecording());
        document.getElementById('stop-btn').addEventListener('click', () => this.stopPlayback());
        document.getElementById('cut-phrases-btn').addEventListener('click', () => this.openPhraseEditor());
        document.getElementById('temp-delete-all-btn')?.addEventListener('click', () => this.deleteAllTempRecordings());

        // Filtro por fecha en Grabaciones Temporales — la instanciación de Flatpickr
        // maneja onChange internamente, aquí solo queda el botón de limpiar.
        document.getElementById('temp-filter-clear')?.addEventListener('click', () => this.clearTempFilter());
        this.initTempDatePickers();

        // Cerrar el reproductor grande y volver al monitor del micrófono.
        document.getElementById('record-review-close')?.addEventListener('click', () => this._hideRecordReview());

        // Doble click sobre cualquier grabación temporal → cargarla arriba en el cuadro grande.
        document.getElementById('temp-recordings')?.addEventListener('dblclick', (e) => {
            const item = e.target.closest?.('.recording-item');
            if (!item) return;
            const btn = item.querySelector('[data-action="temp-expand"]');
            const id = btn?.dataset.id;
            if (id) this.expandTempRecording(id);
        });

        // Doble click sobre una card de lick → cargarla en el reproductor grande de arriba.
        document.getElementById('licks-list')?.addEventListener('dblclick', (e) => {
            const card = e.target.closest?.('.lick-card');
            if (!card) return;
            const id = card.getAttribute('data-lick-id');
            if (id) this.expandLick(id);
        });
        // Click sobre el título del lick → también carga en el reproductor grande (más descubrible).
        document.getElementById('licks-list')?.addEventListener('click', (e) => {
            const title = e.target.closest?.('.lick-header h4');
            if (!title) return;
            const card = title.closest('.lick-card');
            const id = card?.getAttribute('data-lick-id');
            if (id) this.expandLick(id);
        });

        // Cerrar el reproductor grande de licks.
        document.getElementById('lick-review-close')?.addEventListener('click', () => this._hideLickReview());

        // Filtros de Licks (texto + limpiar). Los pickers de fecha se instancian en loadLicks.
        const licksTextInput = document.getElementById('licks-filter-text');
        if (licksTextInput) {
            let t;
            licksTextInput.addEventListener('input', (e) => {
                clearTimeout(t);
                const value = e.target.value;
                t = setTimeout(() => this.setLicksFilter({ text: value }), 200);
            });
        }
        document.getElementById('licks-filter-clear')?.addEventListener('click', () => this.clearLicksFilters());

        // Device selection
        document.getElementById('refresh-devices').addEventListener('click', () => this.refreshAudioDevices());
        document.getElementById('audio-device').addEventListener('change', (e) => this.selectAudioDevice(e.target.value));
        document.getElementById('mic-toggle-btn')?.addEventListener('click', () => this.toggleMic());

        // Fuente Audio | MIDI y detección de teclado MIDI.
        this._initInputSourceUi?.();

        // Backing track
        document.getElementById('backing-track-file').addEventListener('change', (e) => this.loadBackingTrack(e));
        document.getElementById('play-backing').addEventListener('click', () => this.playBackingTrack());
        document.getElementById('stop-backing').addEventListener('click', () => this.stopBackingTrack());

        // Licks
        document.getElementById('add-lick').addEventListener('click', () => this.showAddLickModal());
        document.getElementById('style-filter').addEventListener('change', (e) => this.filterLicks(e.target.value));

        // Search
        document.getElementById('search-btn')?.addEventListener('click', () => this.performSearch());
        document.getElementById('search-input')?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.performSearch();
        });

        // YouTube controls
        document.getElementById('load-youtube-btn')?.addEventListener('click', () => {
            this.loadYoutubeVideo();
        });
        // Delegación única para los 4 botones del editor de YouTube.
        // Reemplaza los addEventListener directos porque el elemento puede recrearse
        // en el DOM y perder los listeners; delegación al document sobrevive a eso.
        document.addEventListener('click', (ev) => {
            const t = ev.target?.closest?.('#play-segment-btn, #mark-start-btn, #mark-end-btn, #new-phrase-btn');
            if (!t) return;
            if (t.disabled) {
                console.log('[UI] click ignorado, disabled:', t.id);
                if (t.id === 'play-segment-btn') {
                    this.showNotification('Marca inicio y final primero para poder reproducir el segmento', 'info');
                }
                return;
            }
            console.log('[UI] click', t.id);
            if (t.id === 'mark-start-btn') this.markSegmentStart();
            else if (t.id === 'mark-end-btn') this.markSegmentEnd();
            else if (t.id === 'play-segment-btn') this.playSegment();
            else if (t.id === 'new-phrase-btn') this.startNewYoutubePhrase();
        });
        document.getElementById('save-youtube-phrase-btn')?.addEventListener('click', () => {
            this.saveYoutubePhrase();
        });
        document.getElementById('new-phrase-btn')?.addEventListener('click', () => {
            this.startNewYoutubePhrase();
        });
        document.getElementById('youtube-phrases-filter')?.addEventListener('change', (e) => {
            this.filterYoutubePhrases(e.target.value);
        });

        // Análisis de IA
        document.getElementById('analyze-recording-btn')?.addEventListener('click', () => {
            this.showAnalysisSection();
        });
        document.getElementById('analysis-recording-select')?.addEventListener('change', (e) => {
            const btn = document.getElementById('start-analysis-btn');
            if (btn) btn.disabled = !e.target.value;
        });
        document.getElementById('start-analysis-btn')?.addEventListener('click', () => {
            this.startAnalysis();
        });

        // Fase B3 SRL: delimitador de objetivos vagos.
        // Listener con debounce sobre el input; si el objetivo es vago, dispara
        // la miniconsulta a Groq y renderiza chips. Blur también dispara por si
        // el usuario terminó de escribir sin pausar.
        const objectiveInput = document.getElementById('analysis-objective');
        if (objectiveInput) {
            let debounceTimer = null;
            const triggerDelimit = () => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => this.maybeDelimitObjective(objectiveInput.value), 700);
            };
            objectiveInput.addEventListener('input', triggerDelimit);
            objectiveInput.addEventListener('blur', () => this.maybeDelimitObjective(objectiveInput.value));
        }
        document.getElementById('save-analysis-btn')?.addEventListener('click', () => {
            this.saveAnalysis();
        });
        document.getElementById('new-analysis-btn')?.addEventListener('click', () => {
            this.resetAnalysis();
        });
        document.getElementById('export-analysis-btn')?.addEventListener('click', () => {
            this.exportAnalysisPDF();
        });

        document.getElementById('analysis-chat-send')?.addEventListener('click', () => {
            this.sendAnalysisChat();
        });
        document.getElementById('analysis-chat-input')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendAnalysisChat();
            }
        });
        // NOTA: play-segment-audio-btn fue removido del HTML — el reproductor del análisis
        // es ahora WaveSurfer con regiones clicables (ver _initAnalysisWavesurfer).

        // Modal
        document.querySelector('.close').addEventListener('click', () => this.closeModal());
        document.getElementById('modal').addEventListener('click', (e) => {
            if (e.target.id === 'modal') this.closeModal();
        });

        document.addEventListener('click', (e) => {
            const likeBtn = e.target.closest?.('.like-btn');
            if (likeBtn) {
                const artist = likeBtn.dataset.artist;
                this.likeArtist(artist, e);
                return;
            }

            const shareBtn = e.target.closest?.('.share-btn');
            if (shareBtn) {
                const artist = shareBtn.dataset.artist;
                const desc = shareBtn.dataset.description;
                this.shareArtist(artist, desc);
                return;
            }

            const ytBtn = e.target.closest?.('.youtube-btn');
            if (ytBtn) {
                const url = ytBtn.dataset.url;
                if (url) window.open(url, '_blank');
                return;
            }

            const navLink = e.target.closest?.('.nav-link');
            if (navLink) {
                const section = navLink.dataset.section;
                if (section) this.showSection(section);
                return;
            }

            const openUrlBtn = e.target.closest?.('[data-action="open-url"]');
            if (openUrlBtn) {
                const url = openUrlBtn.dataset.url;
                if (url) window.open(url, '_blank');
                return;
            }

            const actionBtn = e.target.closest?.('[data-action]');
            if (!actionBtn) return;
            const action = actionBtn.dataset.action;

            if (action === 'analysis-view') {
                this.viewHistoricalAnalysis(Number(actionBtn.dataset.id));
                return;
            }

            if (action === 'analysis-delete') {
                this.deleteAnalysisEntry(Number(actionBtn.dataset.id));
                return;
            }

            if (action === 'temp-play') {
                this.playTempRecording(actionBtn.dataset.id);
                return;
            }
            if (action === 'temp-stop') {
                this.stopTempRecording(actionBtn.dataset.id);
                return;
            }
            if (action === 'temp-edit') {
                this.editTempRecording(actionBtn.dataset.id);
                return;
            }
            if (action === 'temp-delete') {
                this.deleteTempRecording(actionBtn.dataset.id);
                return;
            }
            if (action === 'temp-expand') {
                this.expandTempRecording(actionBtn.dataset.id);
                return;
            }
            if (action === 'temp-page') {
                this.setTempPage(actionBtn.dataset.page);
                return;
            }

            if (action === 'phrase-play') {
                this.playPhrase(Number(actionBtn.dataset.index));
                return;
            }
            if (action === 'phrase-remove') {
                this.removePhrase(Number(actionBtn.dataset.index));
                return;
            }

            if (action === 'lick-expand') {
                this.expandLick(actionBtn.dataset.id);
                return;
            }
            if (action === 'licks-page') {
                this.setLicksPage(actionBtn.dataset.page);
                return;
            }
            if (action === 'lick-play') {
                this.playLick(actionBtn.dataset.id);
                return;
            }
            if (action === 'lick-download') {
                this.downloadLick(actionBtn.dataset.id);
                return;
            }
            if (action === 'lick-delete') {
                this.deleteLick(actionBtn.dataset.id);
                return;
            }
            if (action === 'lick-select-all') {
                this.selectAllLicks();
                return;
            }
            if (action === 'lick-deselect-all') {
                this.deselectAllLicks();
                return;
            }
            if (action === 'lick-delete-selected') {
                this.deleteSelectedLicks();
                return;
            }
            if (action === 'study-add') {
                this.studyAddById(actionBtn.dataset.id);
                return;
            }
            if (action === 'study-play') {
                this.studyPlay();
                return;
            }
            if (action === 'study-pause') {
                this.studyPause();
                return;
            }
            if (action === 'study-next') {
                this.studyNext();
                return;
            }
            if (action === 'study-prev') {
                this.studyPrev();
                return;
            }
            if (action === 'study-clear') {
                this.studyClear();
                return;
            }
            if (action === 'study-toggle-loop') {
                this.studyLoop = !this.studyLoop;
                this.updateStudyLoopButton(actionBtn);
                return;
            }
            if (action === 'study-remove') {
                this.studyRemove(Number(actionBtn.dataset.index));
                return;
            }
            if (action === 'study-pick') {
                this.studyPick(Number(actionBtn.dataset.index));
                return;
            }

            if (action === 'youtube-play-phrase') {
                this.playYoutubePhrase(Number(actionBtn.dataset.id));
                return;
            }

            if (action === 'youtube-delete-phrase') {
                this.deleteYoutubePhrase(Number(actionBtn.dataset.id));
                return;
            }

            if (action === 'editor-add-phrase') {
                this.addPhrase();
                return;
            }
            if (action === 'editor-play-selection') {
                this.playSelection();
                return;
            }
            if (action === 'editor-toggle-play') {
                this.toggleEditorPlay();
                return;
            }
            if (action === 'editor-save-licks') {
                this.savePhrasesToLicks();
                return;
            }
            if (action === 'modal-close') {
                this.closeModal();
                return;
            }

            if (action === 'fav-manual-open') {
                this.openManualFavoriteDialog();
                return;
            }

            if (action === 'fav-remove') {
                this.removeFavoritePiece(Number(actionBtn.dataset.id));
                return;
            }

            if (action === 'fav-save-song-url') {
                this.saveSongUrl(Number(actionBtn.dataset.id));
                return;
            }

            if (action === 'fav-save-manual') {
                this.saveManualFavorite();
                return;
            }

            if (action === 'recording-open-editor') {
                this.openPhraseEditor();
                return;
            }

            // ── Ajustes ─────────────────────────────────────────────────────
            if (action === 'settings-save-profile')      { this.saveProfile(); return; }
            if (action === 'settings-change-password')   { this.openChangePasswordModal(); return; }
            if (action === 'settings-close-cp')          { this.closeChangePasswordModal(); return; }
            if (action === 'settings-change-email')      { this.openChangeEmailModal(); return; }
            if (action === 'settings-close-ce')          { this.closeChangeEmailModal(); return; }
            if (action === 'settings-save-default-style'){ this.saveDefaultStyle(); return; }
            if (action === 'settings-export-data')       { this.exportUserData(); return; }
            if (action === 'settings-delete-account')    { this.openDeleteAccountModal(); return; }
            if (action === 'settings-close-del')         { this.closeDeleteAccountModal(); return; }
            if (action === 'settings-cancel-deletion')   { this.cancelPendingDeletion(); return; }
            if (action === 'settings-keep-deletion')     { this.keepPendingDeletion(); return; }
        });

        document.addEventListener('change', (e) => {
            const lickCb = e.target.closest?.('.lick-checkbox');
            if (lickCb) {
                this.toggleLickSelection(lickCb.dataset.id);
            }
        });

        // React to Supabase auth state changes
        db.auth.onAuthStateChange((event) => {
            if (event === 'SIGNED_IN') {
                this.progressTracker = this.createProgressTracker();
                this.flushPendingPracticeSession();
                this.refreshPracticeTotals();
                this.licks = [];
                this.phrases = [];
                this.tempRecordings = [];
                this.loadLicks();
                this.loadRecordingsFromServer();
                this.loadAnalysisHistory();
                this.loadYoutubePhrases();
                this.updateFavoritePiecesList();
                this.updateRecommendations();
                this.artistsManager.init();
                this.favoriteSongsManager.init();
            } else if (event === 'SIGNED_OUT') {
                this.progressTracker = this.createProgressTracker();
                this.practiceTodayTotalSec = 0;
                this.practiceChartDays = null;
                this.updatePracticeTimerUI();
                this.licks = [];
                this.phrases = [];
                this.tempRecordings = [];
                this.analysisHistory = [];
                this.loadLicks();
                this.updateTempRecordingsList();
                this.renderAnalysisHistory();
                this.updateFavoritePiecesList();
                this.updateRecommendations();
            }
        });

        window.addEventListener('beforeunload', () => {
            this.savePendingPracticeSession();
            this.objectURLs.forEach((url) => URL.revokeObjectURL(url));
            this.objectURLs.clear();
            if (this.currentStream) {
                this.currentStream.getTracks().forEach(track => track.stop());
                this.currentStream = null;
            }

            if (this.studyAudioUrl) {
                this.cleanupObjectURL(this.studyAudioUrl);
                this.studyAudioUrl = null;
            }

            this._teardownAnalysisWavesurfer?.();
        });

        this.setupStudyDropzone();
    },

    showSection(sectionName) {
        // Update navigation
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.remove('active');
        });
        document.querySelector(`[data-section="${sectionName}"]`).classList.add('active');

        // Update content
        document.querySelectorAll('.section').forEach(section => {
            section.classList.remove('active');
        });
        document.getElementById(sectionName).classList.add('active');

        // Load section-specific data
        if (sectionName === 'licks') {
            this.loadLicks();
            this.renderStudyQueue();
            this.updateStudyLoopButton();
        }
        if (sectionName === 'phrases') this.loadYoutubePhrases();
        if (sectionName === 'progress') this.renderProgressSection();
        if (sectionName === 'artists') this.artistsManager.render();
        if (sectionName === 'favorites') this.favoriteSongsManager.render();
        if (sectionName === 'settings') {
            this.updateAIStatusIndicator();
            this.renderSettings();
        }
        if (sectionName === 'ai-analysis') {
            this.loadRecordingsFromServer().finally(() => this.loadRecordingsForAnalysis());
            this._initGeminiToggle?.();
            this._initProviderChips?.();
        }
    },

    showConfirm(message) {
        return new Promise((resolve) => {
            const overlay = document.getElementById('confirm-modal');
            const msgEl = document.getElementById('confirm-modal-message');
            const okBtn = document.getElementById('confirm-modal-ok');
            const cancelBtn = document.getElementById('confirm-modal-cancel');
            if (!overlay || !msgEl || !okBtn || !cancelBtn) {
                resolve(window.confirm(message));
                return;
            }
            msgEl.textContent = message;
            overlay.style.display = 'flex';

            const cleanup = (result) => {
                overlay.style.display = 'none';
                okBtn.removeEventListener('click', onOk);
                cancelBtn.removeEventListener('click', onCancel);
                overlay.removeEventListener('click', onOverlay);
                resolve(result);
            };
            const onOk = () => cleanup(true);
            const onCancel = () => cleanup(false);
            const onOverlay = (e) => { if (e.target === overlay) cleanup(false); };

            okBtn.addEventListener('click', onOk);
            cancelBtn.addEventListener('click', onCancel);
            overlay.addEventListener('click', onOverlay);
            okBtn.focus();
        });
    },

    showNotification(message, type = 'info') {
        // Delegado al sistema Toast unificado. Los tipos viejos se mapean a
        // los nuevos: success → exito, warning → aviso, resto queda info.
        const map = { success: 'exito', error: 'error', warning: 'aviso', info: 'info' };
        const kind = map[type] || 'info';
        toast[kind](message);
    },

    closeModal() {
        // Destruye WaveSurfer y libera el object URL si el editor de frases estaba abierto.
        this._teardownPhraseEditor?.();
        document.getElementById('modal').classList.add('hidden');
    },
};
