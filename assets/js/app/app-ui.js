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

        // Device selection
        document.getElementById('refresh-devices').addEventListener('click', () => this.refreshAudioDevices());
        document.getElementById('audio-device').addEventListener('change', (e) => this.selectAudioDevice(e.target.value));

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
        document.getElementById('mark-start-btn')?.addEventListener('click', () => {
            this.markSegmentStart();
        });
        document.getElementById('mark-end-btn')?.addEventListener('click', () => {
            this.markSegmentEnd();
        });
        document.getElementById('play-segment-btn')?.addEventListener('click', () => {
            this.playSegment();
        });
        document.getElementById('save-youtube-phrase-btn')?.addEventListener('click', () => {
            this.saveYoutubePhrase();
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
        document.getElementById('play-segment-audio-btn')?.addEventListener('click', () => {
            this.playAnalysisSegment();
        });

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

            if (action === 'phrase-play') {
                this.playPhrase(Number(actionBtn.dataset.index));
                return;
            }
            if (action === 'phrase-remove') {
                this.removePhrase(Number(actionBtn.dataset.index));
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

            if (this.analysisAudioUrl) {
                this.cleanupObjectURL(this.analysisAudioUrl);
                this.analysisAudioUrl = null;
            }
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
        // Si el editor está abierto, detener reproducción/loop para evitar que se “trabe”
        this.stopEditorPlayback();
        this.editorDragging = null;
        this.detachEditorMouseHandlers();
        document.getElementById('modal').classList.add('hidden');
    },
};
