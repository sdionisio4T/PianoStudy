import { escapeHtml, sanitizeFileName, validateAudioBlob } from './assets/js/utils/sanitizers.js';
import { YouTubeManager } from './assets/js/modules/YouTubeManager.js';
import { AudioAnalyzer } from './assets/js/modules/AudioAnalyzer.js';
import { AIAnalysisEngine } from './assets/js/modules/AIAnalysisEngine.js';
import { ProgressTracker } from './assets/js/modules/ProgressTracker.js';
import { ArtistsManager } from './assets/js/modules/ArtistsManager.js';
import { FavoriteSongsManager } from './assets/js/modules/FavoriteSongsManager.js';
import {
    loadLicksFromDB, insertLick, updateLick, deleteLick, uploadLickAudio,
    loadRecordingsFromDB, uploadRecording, getRecordingPublicUrl, deleteRecording,
    loadCustomArtistsFromDB, insertCustomArtist, deleteCustomArtist,
    insertPracticeSession, loadPracticeSessionsRange,
    skeletonHTML, errorHTML, ERR_MSG
} from './assets/js/modules/SupabaseDataManager.js';
import { db } from './assets/js/modules/supabase-client.js';

// PianoStudy App - Main JavaScript
class PianoStudyApp {
    constructor() {
        this.isRecording = false;
        this.isPlaying = false;
        this.mediaRecorder = null;
        this.audioChunks = [];
        this.audioContext = null;
        this.analyser = null;
        this.microphone = null;
        this.backingTrack = null;
        this.currentAudio = null;
        this.currentPlayingAudio = null;
        this.selectedLicks = new Set();
        this.currentRecordingDuration = null;

        // Phrase editor (pro)
        this.editorAudio = null;
        this.editorIsPlaying = false;
        this.editorLoop = true;
        this.editorZoom = 1;
        this.editorViewStart = 0;
        this.editorDecodedBuffer = null;
        this.editorPeaks = null;
        this.editorDecodedSourceBlob = null;
        this.editorPlayheadRaf = null;
        this.editorDragging = null; // 'region' | 'start' | 'end' | 'playhead'
        this.editorLastMouseX = 0;

        this.currentUser = null;
        this.licks = [];
        this.phrases = [];
        this.tempRecordings = [];
        this.recordingStartTime = null;
        this.recordingTimer = null;

        this.objectURLs = new Set();
        this.currentStream = null;

        // Study Player (lick queue)
        this.studyQueue = [];
        this.studyIndex = -1;
        this.studyLoop = true;
        this.studyPlaybackRate = 1;
        this.studyAudio = null;
        this.studyAudioUrl = null;

        // YouTube Study
        this.youtubeManager = new YouTubeManager();
        this.youtubePhrases = [];

        // AI Analysis
        this.audioAnalyzer = new AudioAnalyzer();
        this.aiEngine = null;
        this.currentAnalysis = null;
        this.analysisHistory = [];
        this.currentAnalysisAudioBlob = null;
        this.analysisAudioUrl = null;
        this.analysisSegmentTimer = null;
        this.analysisChat = [];

        // Progress tracking
        this.progressTracker = this.createProgressTracker();
        this._chartResizeObserver = null;

        // Practice timer
        this.practiceTimerInterval = null;
        this.practiceTimerRunning = false;
        this.practiceTimerStartMs = 0;
        this.practiceTimerElapsedSec = 0;
        this.practiceTodayTotalSec = 0;
        this.practiceChartDays = null;
        this.practiceChartStats = { avg: 0, best: 0 };

        this.practiceMilestonesShown = new Set();
        this.practiceCelebrationEl = null;
        this.practiceCelebrationTimer = null;
        try {
            this.navTimerCollapsed = localStorage.getItem('pianostudy-timer-collapsed') === '1';
        } catch {
            this.navTimerCollapsed = false;
        }
        try {
            this.mobileTimerCollapsed = localStorage.getItem('pianostudy-timer-mobile-collapsed') === '1';
        } catch {
            this.mobileTimerCollapsed = false;
        }

        // Artists
        this.artistsManager = new ArtistsManager(this);
        this.favoriteSongsManager = new FavoriteSongsManager(this);
        
        this.init();
    }

    createProgressTracker() {
        const u = this.getActiveUsername();
        if (!u) {
            return new ProgressTracker({ enabled: false });
        }
        return new ProgressTracker({
            enabled: true,
            storageKey: `pianostudy-progress_${u}`,
            badgesKey: `pianostudy-badges_${u}`
        });
    }

    getActiveUsername() {
        try {
            const keys = Object.keys(localStorage);
            const sbKey = keys.find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
            if (!sbKey) return null;
            const raw = localStorage.getItem(sbKey);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            const supaSession = parsed?.session ?? parsed;
            if (!supaSession?.user) return null;
            if (supaSession.expires_at && Date.now() / 1000 > supaSession.expires_at) return null;
            const meta = supaSession.user.user_metadata || {};
            return meta.username || supaSession.user.email?.split('@')[0] || null;
        } catch {
            return null;
        }
    }

    userKey(base) {
        const u = this.getActiveUsername();
        return u ? `${base}_${u}` : base;
    }

    async getActiveUserId() {
        try {
            const { data } = await db.auth.getSession();
            return data?.session?.user?.id || null;
        } catch {
            return null;
        }
    }

    safeGetLocalStorage(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return fallback;
            return JSON.parse(raw);
        } catch (e) {
            console.error('Error leyendo localStorage:', key, e);
            return fallback;
        }
    }

    safeSetLocalStorage(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (e) {
            console.error('Error escribiendo localStorage:', key, e);
            return false;
        }
    }

    cleanupObjectURL(url) {
        if (this.objectURLs.has(url)) {
            URL.revokeObjectURL(url);
            this.objectURLs.delete(url);
        }
    }

    createTrackedObjectURL(blob) {
        const url = URL.createObjectURL(blob);
        this.objectURLs.add(url);
        return url;
    }

    cleanupContainerObjectURLs(container) {
        if (!container) return;
        container.querySelectorAll?.('audio[data-object-url]').forEach((el) => {
            const url = el.getAttribute('data-object-url');
            if (url) this.cleanupObjectURL(url);
        });
    }

    async init() {
        this.setupEventListeners();
        await this.initAudioContext();
        this.updateRecommendations();
        this.updateFavoritePiecesList();

        this.youtubeManager.init();
        this.loadYoutubePhrases();
        this.loadAnalysisHistory();
        this.initializeAIEngine();

        this.initPracticeTimerWidget();
        await this.flushPendingPracticeSession();
        await this.refreshPracticeTotals();

        // Load Supabase data if already signed in
        this.loadLicks();
        this.loadRecordingsFromServer();
        this.artistsManager.init();
        this.favoriteSongsManager.init();
    }

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
    }

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
    }

    updateStudyLoopButton(btnEl) {
        const btn = btnEl || document.querySelector('[data-action="study-toggle-loop"]');
        if (!btn) return;
        btn.innerHTML = `<i class="fas fa-redo"></i> Loop: ${this.studyLoop ? 'ON' : 'OFF'}`;
    }

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
    }

    updateTimeDisplay(currentTime) {
        const totalTime = this.youtubeManager.getDuration();
        const curEl = document.getElementById('current-time');
        const totEl = document.getElementById('total-time');

        if (curEl) curEl.textContent = this.youtubeManager.formatTime(currentTime);
        if (totEl) totEl.textContent = this.youtubeManager.formatTime(totalTime);
    }

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
    }

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
    }

    updateSegmentPreview() {
        const segment = this.youtubeManager.getSegmentData();
        if (!segment) return;

        document.getElementById('segment-preview')?.classList.remove('hidden');
        const durEl = document.getElementById('segment-duration-display');
        if (durEl) durEl.textContent = `${Math.floor(segment.duration)}s`;
    }

    playSegment() {
        try {
            this.youtubeManager.playSegment();
        } catch (error) {
            console.error('Error playing segment:', error);
            this.showNotification(error?.message || 'Error al reproducir segmento', 'error');
        }
    }

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
    }

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
    }

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
    }

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
    }

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
    }

    filterYoutubePhrases(style) {
        this.loadYoutubePhrases(style);
    }

    initializeAIEngine() {
        this.aiEngine = new AIAnalysisEngine();
        this.updateAIStatusIndicator();
    }

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
    }

    async showAnalysisSection() {
        this.showSection('ai-analysis');
        this.loadRecordingsForAnalysis();
    }

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
            if (!rec || !(rec.blob instanceof Blob)) return;
            const opt = document.createElement('option');
            opt.value = String(rec.id);
            opt.textContent = `${rec.name} (${this.formatDuration(rec.duration || 0)})`;
            select.appendChild(opt);
        });
    }

    getRecordingBlobForAnalysis(selectionValue) {
        if (selectionValue === 'current') {
            return this.currentRecording instanceof Blob ? this.currentRecording : null;
        }
        const id = Number(selectionValue);
        if (!Number.isFinite(id)) return null;
        const rec = (this.tempRecordings || []).find(r => r.id === id);
        return rec?.blob instanceof Blob ? rec.blob : null;
    }

    async startAnalysis() {
        const select = document.getElementById('analysis-recording-select');
        const selection = String(select?.value || '');
        if (!selection) return;

        const audioBlob = this.getRecordingBlobForAnalysis(selection);
        if (!audioBlob) {
            this.showNotification('Grabación no encontrada', 'error');
            return;
        }

        const statusEl = document.getElementById('analysis-status');
        const resultsEl = document.getElementById('analysis-results');
        statusEl?.classList.remove('hidden');
        resultsEl?.classList.add('hidden');

        try {
            this.updateAnalysisProgress(15);
            await this.audioAnalyzer.init();
            const audioAnalysis = await this.audioAnalyzer.analyzeAudio(audioBlob, { enableMidiTranscription: true });
            this.updateAnalysisProgress(55);

            const aiEngine = this.aiEngine || new AIAnalysisEngine();
            const aiAnalysis = await aiEngine.analyzePerformance(audioAnalysis, {});
            this.updateAnalysisProgress(80);

            const canvas = document.getElementById('analysis-waveform');
            if (canvas) {
                const audioBuffer = await this.getAudioBuffer(audioBlob);
                this.audioAnalyzer.generateAnnotatedWaveform(audioBuffer, canvas);
            }

            this.updateAnalysisProgress(100);

            this.currentAnalysis = {
                recordingId: selection,
                recordingName: selection === 'current' ? 'Grabación actual' : `Grabación ${selection}`,
                audioAnalysis,
                aiAnalysis,
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
    }

    updateAnalysisProgress(percent) {
        const progressBar = document.getElementById('analysis-progress');
        if (progressBar) progressBar.style.width = `${percent}%`;
    }

    async getAudioBuffer(blob) {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const arrayBuffer = await blob.arrayBuffer();
        return await audioContext.decodeAudioData(arrayBuffer);
    }

    displayAnalysisResults() {
        if (!this.currentAnalysis) return;
        const { audioAnalysis, aiAnalysis } = this.currentAnalysis;

        document.getElementById('analysis-results')?.classList.remove('hidden');

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
        if (musicalEl) musicalEl.innerHTML = `<p>${escapeHtml(aiAnalysis.musicalAnalysis || '')}</p>`;

        const posEl = document.getElementById('positive-feedback');
        if (posEl) {
            const arr = Array.isArray(aiAnalysis.positiveAspects) ? aiAnalysis.positiveAspects : [];
            posEl.innerHTML = arr.map(aspect => `
                <div class="feedback-item">
                    <div class="feedback-icon">✅</div>
                    <div class="feedback-text">${escapeHtml(aspect)}</div>
                </div>
            `).join('');
        }

        const impEl = document.getElementById('improvement-feedback');
        if (impEl) {
            const arr = Array.isArray(aiAnalysis.areasToImprove) ? aiAnalysis.areasToImprove : [];
            impEl.innerHTML = arr.map(area => `
                <div class="feedback-item improvement">
                    <div class="feedback-icon">💡</div>
                    <div class="feedback-text">${escapeHtml(area)}</div>
                </div>
            `).join('');
        }

        const sugEl = document.getElementById('practice-suggestions');
        if (sugEl) {
            const arr = Array.isArray(aiAnalysis.practiceSuggestions) ? aiAnalysis.practiceSuggestions : [];
            sugEl.innerHTML = arr.map(s => `
                <div class="suggestion-card">
                    <div class="suggestion-title">
                        <i class="fas fa-star"></i>
                        ${escapeHtml(s.title || '')}
                    </div>
                    <div class="suggestion-description">
                        ${escapeHtml(s.description || '')}
                    </div>
                </div>
            `).join('');
        }

        // Audio player
        const audioEl = document.getElementById('analysis-audio');
        if (audioEl) {
            if (this.analysisAudioUrl) {
                this.cleanupObjectURL(this.analysisAudioUrl);
                this.analysisAudioUrl = null;
            }

            if (this.currentAnalysisAudioBlob instanceof Blob) {
                const url = this.createTrackedObjectURL(this.currentAnalysisAudioBlob);
                this.analysisAudioUrl = url;
                audioEl.src = url;
                audioEl.setAttribute('data-object-url', url);
            } else {
                audioEl.removeAttribute('src');
                audioEl.load();
            }
        }

        const startEl = document.getElementById('segment-start');
        const endEl = document.getElementById('segment-end');
        if (startEl && endEl) {
            startEl.value = '0';
            endEl.value = String(Math.max(0, Number(audioAnalysis.duration?.toFixed?.(1) || 0)));
        }

        // Reset chat
        this.analysisChat = [];
        this.renderAnalysisChat();
    }

    saveAnalysis() {
        if (!this.currentAnalysis) return;

        this.analysisHistory = Array.isArray(this.analysisHistory) ? this.analysisHistory : [];
        this.analysisHistory.unshift(this.currentAnalysis);
        this.safeSetLocalStorage(this.userKey('pianostudy-analysis-history'), this.analysisHistory);
        this.renderAnalysisHistory();
        this.persistCurrentAnalysisAudio();
        this.showNotification('Análisis guardado', 'success');
    }

    loadAnalysisHistory() {
        if (!this.getActiveUsername()) {
            this.analysisHistory = [];
            this.renderAnalysisHistory();
            return;
        }
        const stored = this.safeGetLocalStorage(this.userKey('pianostudy-analysis-history'), []);
        this.analysisHistory = Array.isArray(stored) ? stored : [];
        this.renderAnalysisHistory();
    }

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
    }

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
    }

    resetAnalysis() {
        document.getElementById('analysis-results')?.classList.add('hidden');
        const select = document.getElementById('analysis-recording-select');
        if (select) select.value = '';
        const btn = document.getElementById('start-analysis-btn');
        if (btn) btn.disabled = true;
        this.currentAnalysis = null;
        this.currentAnalysisAudioBlob = null;

        const audioEl = document.getElementById('analysis-audio');
        if (audioEl) {
            audioEl.removeAttribute('src');
            audioEl.load();
        }
    }

    async viewHistoricalAnalysis(timestamp) {
        const ts = Number(timestamp);
        if (!Number.isFinite(ts)) return;
        const item = (this.analysisHistory || []).find(a => Number(a?.timestamp) === ts);
        if (!item) return;

        this.currentAnalysis = item;
        this.currentAnalysisAudioBlob = await this.loadAnalysisAudioFromDb(ts);
        this.showSection('ai-analysis');
        this.displayAnalysisResults();
    }

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
    }

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
        const answer = await engine.answerQuestion(audioAnalysis, aiAnalysis, question);
        this.analysisChat.push({ role: 'assistant', text: String(answer || '') });
        this.renderAnalysisChat();
    }

    playAnalysisSegment() {
        const audioEl = document.getElementById('analysis-audio');
        if (!audioEl || !audioEl.src) {
            this.showNotification('No hay audio cargado', 'info');
            return;
        }

        const start = Math.max(0, Number(document.getElementById('segment-start')?.value || 0));
        const end = Math.max(0, Number(document.getElementById('segment-end')?.value || 0));
        if (!(end > start)) {
            this.showNotification('El fin debe ser mayor que el inicio', 'info');
            return;
        }

        if (this.analysisSegmentTimer) {
            clearInterval(this.analysisSegmentTimer);
            this.analysisSegmentTimer = null;
        }

        audioEl.currentTime = start;
        audioEl.play().catch(() => {
            this.showNotification('No se pudo reproducir el audio', 'error');
        });

        this.analysisSegmentTimer = setInterval(() => {
            if (audioEl.currentTime >= end || audioEl.ended) {
                audioEl.pause();
                clearInterval(this.analysisSegmentTimer);
                this.analysisSegmentTimer = null;
            }
        }, 100);
    }

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
    }

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
    }

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
    }

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
    }

    exportAnalysisPDF() {
        if (!this.currentAnalysis) return;

        const { recordingName, aiAnalysis, audioAnalysis } = this.currentAnalysis;
        const tempo = Number(audioAnalysis?.tempo?.bpm || audioAnalysis?.tempo || 0);
        const key = `${audioAnalysis?.key?.key || audioAnalysis?.pitch || '--'} ${audioAnalysis?.key?.scale || ''}`.trim();
        const dynamic = Number(audioAnalysis?.loudness?.dynamicComplexity || 0);
        const content = `ANÁLISIS DE INTERPRETACIÓN MUSICAL\n\nGrabación: ${recordingName}\nDuración: ${audioAnalysis.duration.toFixed(1)}s\nTempo: ${tempo} BPM\nTonalidad: ${key}\nComplejidad dinámica: ${dynamic.toFixed(2)}\nPuntuación: ${aiAnalysis.overallScore}/10\n\nANÁLISIS MUSICAL:\n${aiAnalysis.musicalAnalysis}\n\nASPECTOS POSITIVOS:\n${(aiAnalysis.positiveAspects || []).map((a, i) => `${i + 1}. ${a}`).join('\n')}\n\nÁREAS DE MEJORA:\n${(aiAnalysis.areasToImprove || []).map((a, i) => `${i + 1}. ${a}`).join('\n')}\n\nSUGERENCIAS DE PRÁCTICA:\n${(aiAnalysis.practiceSuggestions || []).map((s, i) => `${i + 1}. ${s.title}\n   ${s.description}`).join('\n\n')}`;

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
    }

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
    }

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
    }

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
    }

    studyPick(index) {
        if (!Number.isFinite(index)) return;
        if (index < 0 || index >= this.studyQueue.length) return;
        this.studyIndex = index;
        this.renderStudyQueue();
        this.studyPlay();
    }

    studyClear() {
        this.studyQueue = [];
        this.studyIndex = -1;
        this.studyStop();
        this.renderStudyQueue();
    }

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
    }

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
    }

    studyPause() {
        if (this.studyAudio) {
            this.studyAudio.pause();
        }
    }

    studyNext() {
        if (!this.studyQueue.length) return;
        this.studyIndex = (this.studyIndex + 1) % this.studyQueue.length;
        this.renderStudyQueue();
        this.studyPlay();
    }

    studyPrev() {
        if (!this.studyQueue.length) return;
        this.studyIndex = (this.studyIndex - 1 + this.studyQueue.length) % this.studyQueue.length;
        this.renderStudyQueue();
        this.studyPlay();
    }

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
        if (sectionName === 'settings') this.updateAIStatusIndicator();
    }

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
    }

    toggleMobileTimerCollapsed() {
        this.mobileTimerCollapsed = !this.mobileTimerCollapsed;
        try {
            localStorage.setItem('pianostudy-timer-mobile-collapsed', this.mobileTimerCollapsed ? '1' : '0');
        } catch { /* ignore */ }
        this.updatePracticeTimerUI();
    }

    toggleNavTimerCollapsed() {
        this.navTimerCollapsed = !this.navTimerCollapsed;
        try {
            localStorage.setItem('pianostudy-timer-collapsed', this.navTimerCollapsed ? '1' : '0');
        } catch { /* ignore */ }
        this.updatePracticeTimerUI();
    }

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
    }

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
    }

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
    }

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
    }

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
    }

    getPracticeTimerCurrentSeconds() {
        const runningDelta = this.practiceTimerRunning
            ? Math.max(0, Math.floor((Date.now() - this.practiceTimerStartMs) / 1000))
            : 0;
        return Math.max(0, this.practiceTimerElapsedSec + runningDelta);
    }

    formatHMS(totalSeconds) {
        const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
        const hh = Math.floor(s / 3600);
        const mm = Math.floor((s % 3600) / 60);
        const ss = s % 60;
        return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    }

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
    }

    getTodayDateStr() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    getPendingPracticeKey() {
        return this.userKey('pianostudy-pending-practice-session');
    }

    savePendingPracticeSession() {
        if (!this.getActiveUsername()) return;
        if (!this.practiceTimerRunning) return;

        const durationSec = this.getPracticeTimerCurrentSeconds();
        if (durationSec <= 0) return;

        const payload = {
            duration_seconds: durationSec,
            date: this.getTodayDateStr(),
            created_at_ms: Date.now()
        };

        try {
            localStorage.setItem(this.getPendingPracticeKey(), JSON.stringify(payload));
        } catch {
            // ignore
        }
    }

    async flushPendingPracticeSession() {
        if (!this.getActiveUsername()) return;
        const key = this.getPendingPracticeKey();
        let payload = null;
        try {
            const raw = localStorage.getItem(key);
            if (raw) payload = JSON.parse(raw);
        } catch {
            payload = null;
        }
        if (!payload) return;

        const duration = Math.max(0, Math.floor(Number(payload.duration_seconds) || 0));
        const date = typeof payload.date === 'string' ? payload.date : this.getTodayDateStr();
        if (duration <= 0) {
            localStorage.removeItem(key);
            return;
        }

        const { error } = await insertPracticeSession({ duration_seconds: duration, date });
        if (!error) {
            localStorage.removeItem(key);
            await this.refreshPracticeTotals();
            if (document.getElementById('progress')?.classList.contains('active')) {
                this.renderProgressSection();
            }
        }
    }

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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

    startRecordingTimer() {
        this.recordingTimer = setInterval(() => {
            const elapsed = Date.now() - this.recordingStartTime;
            const seconds = Math.floor(elapsed / 1000);
            const minutes = Math.floor(seconds / 60);
            const displaySeconds = seconds % 60;
            
            const timeString = `${minutes.toString().padStart(2, '0')}:${displaySeconds.toString().padStart(2, '0')}`;
            document.getElementById('recording-time').textContent = timeString;
        }, 100);
    }

    stopRecordingTimer() {
        if (this.recordingTimer) {
            clearInterval(this.recordingTimer);
            this.recordingTimer = null;
        }
    }

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
    }

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
    }

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
    }

    formatDuration(seconds) {
        const s = Number(seconds);
        if (!Number.isFinite(s)) return '0:00.00';
        const minutes = Math.floor(s / 60);
        const sec = s - minutes * 60;
        const whole = Math.floor(sec);
        const hundredths = Math.floor((sec - whole) * 100);
        return `${minutes}:${whole.toString().padStart(2, '0')}.${hundredths.toString().padStart(2, '0')}`;
    }

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
    }

    stopTempRecording(id) {
        const recording = this.tempRecordings.find(r => r.id === id);
        if (recording && recording.currentAudio) {
            recording.currentAudio.pause();
            recording.currentAudio.currentTime = 0;
            recording.currentAudio = null;
        }
    }

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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

    showNotification(message, type = 'info') {
        // Crear notificación
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.textContent = message;
        
        // Estilos
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: ${type === 'success' ? 'var(--accent-green)' : type === 'error' ? 'var(--accent-red)' : 'var(--accent-blue)'};
            color: var(--bg-primary);
            padding: 1rem 1.5rem;
            border-radius: 8px;
            font-weight: bold;
            z-index: 10000;
            animation: slideIn 0.3s ease;
        `;
        
        document.body.appendChild(notification);
        
        // Remover después de 3 segundos
        setTimeout(() => {
            notification.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => {
                document.body.removeChild(notification);
            }, 300);
        }, 3000);
    }

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
    }

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
    }

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
    }

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
    }

    stopPlayback() {
        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio.currentTime = 0;
            document.getElementById('record-btn').disabled = false;
            this.isPlaying = false;
        }
    }

    loadBackingTrack(event) {
        const file = event.target.files[0];
        if (file) {
            const url = this.createTrackedObjectURL(file);
            this.backingTrack = new Audio(url);
            this.backingTrack.onended = () => this.cleanupObjectURL(url);
        }
    }

    playBackingTrack() {
        if (this.backingTrack) {
            this.backingTrack.play();
        }
    }

    stopBackingTrack() {
        if (this.backingTrack) {
            this.backingTrack.pause();
            this.backingTrack.currentTime = 0;
        }
    }

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
    }

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
    }

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
    }

    openPhraseEditor() {
        const modalBody = document.getElementById('modal-body');
        modalBody.innerHTML = `
            <h3>Editor de Frases Musicales</h3>
            <div class="editor-container">
                <div class="waveform-editor">
                    <canvas id="editor-waveform" width="600" height="200"></canvas>
                    <div class="timeline">
                        <div class="time-marker">0:00</div>
                        <div class="time-marker">0:30</div>
                        <div class="time-marker">1:00</div>
                    </div>
                </div>
                <div class="phrase-controls">
                    <button class="btn-small" data-action="editor-play-selection">
                        <i class="fas fa-play"></i> Reproducir selección
                    </button>
                    <button class="btn-primary" data-action="editor-add-phrase">
                        <i class="fas fa-plus"></i> Agregar frase
                    </button>
                </div>
                <div class="phrases-list">
                    <h4>Frases seleccionadas:</h4>
                    <div id="selected-phrases"></div>
                </div>
                <div class="editor-actions">
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
        this.initPhraseEditor();
    }

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
    }

    removePhrase(index) {
        if (!this.selectedPhrases || index < 0 || index >= this.selectedPhrases.length) return;
        this.selectedPhrases.splice(index, 1);
        this.updatePhrasesList();
    }

    _drawWaveform(canvas) {
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = '#00ff41';
        ctx.lineWidth = 2;

        ctx.beginPath();
        ctx.moveTo(0, canvas.height / 2);
        ctx.lineTo(canvas.width, canvas.height / 2);
        ctx.stroke();

        ctx.beginPath();
        for (let x = 0; x < canvas.width; x += 5) {
            const y = canvas.height / 2 + Math.sin(x * 0.05) * 50 * Math.random();
            if (x === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    initPhraseEditor() {
        const canvas = document.getElementById('editor-waveform');
        if (!canvas) return;

        this.initCurrentRecordingMetadata();
        this._drawWaveform(canvas);
        this.setupPhraseSelection(canvas);
    }

    async decodeCurrentRecordingForEditor() {
        if (!this.currentRecording) return;

        if (this.editorDecodedSourceBlob === this.currentRecording && this.editorDecodedBuffer && this.editorPeaks) {
            return;
        }

        const decodeCtx = this.audioContext || new (window.AudioContext || window.webkitAudioContext)();
        if (decodeCtx.state === 'suspended') {
            try { await decodeCtx.resume(); } catch { /* ignore */ }
        }

        try {
            const arrBuf = await this.currentRecording.arrayBuffer();
            const decoded = await decodeCtx.decodeAudioData(arrBuf.slice(0));
            this.editorDecodedBuffer = decoded;
            this.editorDecodedSourceBlob = this.currentRecording;
            this.currentRecordingDuration = decoded.duration;
            this.editorPeaks = this.computeWaveformPeaks(decoded, 2000);
        } catch (e) {
            console.error('Error decoding audio for editor:', e);
            this.editorDecodedBuffer = null;
            this.editorDecodedSourceBlob = null;
            this.editorPeaks = null;
            this.currentRecordingDuration = null;
            this.showNotification('No se pudo cargar el audio en el editor', 'info');
        }
    }

    getEditorMonoData() {
        if (!this.editorDecodedBuffer) return null;
        const buf = this.editorDecodedBuffer;
        const len = buf.length;
        const channels = buf.numberOfChannels;
        if (channels === 1) return buf.getChannelData(0);

        const mono = new Float32Array(len);
        for (let c = 0; c < channels; c++) {
            const ch = buf.getChannelData(c);
            for (let i = 0; i < len; i++) mono[i] += ch[i] || 0;
        }
        for (let i = 0; i < len; i++) mono[i] /= channels;
        return mono;
    }

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
    }

    async exportSelectionToWavMono(startTime, duration) {
        if (!this.currentRecording) return null;
        if (!this.editorDecodedBuffer) {
            await this.decodeCurrentRecordingForEditor();
        }
        if (!this.editorDecodedBuffer) return null;

        const sr = this.editorDecodedBuffer.sampleRate;
        const mono = this.getEditorMonoData();
        if (!mono) return null;

        try {
            const safeStart = Math.max(0, Number(startTime) || 0);
            const safeDur = Math.max(0.05, Number(duration) || 0);
            const startSample = Math.max(0, Math.floor(safeStart * sr));
            const endSample = Math.min(mono.length, Math.floor((safeStart + safeDur) * sr));
            const slice = mono.slice(startSample, Math.max(startSample + 1, endSample));
            return this.encodeWavMono(slice, sr);
        } catch (e) {
            console.error('Error exporting WAV mono:', e);
            return null;
        }
    }

    computeWaveformPeaks(audioBuffer, points = 2000) {
        const channels = audioBuffer.numberOfChannels;
        const length = audioBuffer.length;
        const blockSize = Math.max(1, Math.floor(length / points));

        const peaks = new Float32Array(points);
        for (let i = 0; i < points; i++) {
            const start = i * blockSize;
            const end = Math.min(length, start + blockSize);
            let max = 0;
            for (let s = start; s < end; s++) {
                let sample = 0;
                for (let c = 0; c < channels; c++) {
                    sample += audioBuffer.getChannelData(c)[s] || 0;
                }
                sample /= channels;
                const abs = Math.abs(sample);
                if (abs > max) max = abs;
            }
            peaks[i] = max;
        }
        return peaks;
    }

    setEditorZoom(zoom) {
        this.editorZoom = Math.min(10, Math.max(1, zoom || 1));
        this.ensureEditorViewContainsSelection();
        this.renderEditor();
    }

    ensureEditorViewContainsSelection() {
        const total = this.currentRecordingDuration || 0;
        if (!total || !this.currentSelection) return;
        const viewDur = total / this.editorZoom;
        const selStart = this.currentSelection.startTime || 0;
        const selEnd = (this.currentSelection.startTime || 0) + (this.currentSelection.duration || 0);
        if (selStart < this.editorViewStart) this.editorViewStart = Math.max(0, selStart - 0.1);
        if (selEnd > this.editorViewStart + viewDur) this.editorViewStart = Math.min(Math.max(0, total - viewDur), selEnd - viewDur + 0.1);
    }

    timeToX(t) {
        const canvas = document.getElementById('editor-waveform');
        if (!canvas) return 0;
        const W = canvas.getBoundingClientRect().width || canvas.width;
        const total = this.currentRecordingDuration || 30;
        const viewDur = total / this.editorZoom;
        const rel = (t - this.editorViewStart) / viewDur;
        return rel * W;
    }

    xToTime(x) {
        const canvas = document.getElementById('editor-waveform');
        if (!canvas) return 0;
        const W = canvas.getBoundingClientRect().width || canvas.width;
        const total = this.currentRecordingDuration || 30;
        const viewDur = total / this.editorZoom;
        const rel = x / W;
        return this.editorViewStart + rel * viewDur;
    }

    attachEditorMouseHandlers(canvas) {
        // Clean previous handlers (from a previous modal open)
        this.detachEditorMouseHandlers();
        canvas.dataset.handlersAttached = '1';

        const onDown = (e) => {
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            this.editorLastMouseX = x;

            const selStartX = this.timeToX(this.currentSelection?.startTime || 0);
            const selEndX = this.timeToX((this.currentSelection?.startTime || 0) + (this.currentSelection?.duration || 0));
            const handlePad = 8;

            if (Math.abs(x - selStartX) <= handlePad) {
                this.editorDragging = 'start';
                return;
            }
            if (Math.abs(x - selEndX) <= handlePad) {
                this.editorDragging = 'end';
                return;
            }
            if (x > selStartX && x < selEndX) {
                this.editorDragging = 'region';
                return;
            }

            // Click fuera => nueva selección desde punto (2s por defecto)
            const t = this.xToTime(x);
            const total = this.currentRecordingDuration || 30;
            const dur = Math.min(2, Math.max(0.1, total - t));
            this.currentSelection = {
                startPx: 0,
                endPx: 0,
                startTime: t,
                duration: dur,
                endTime: t + dur
            };
            this.ensureEditorViewContainsSelection();
            this.updateEditorTimesUI();
            this.renderEditor();
        };

        const onMove = (e) => {
            if (!this.editorDragging || !this.currentSelection) return;
            
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const dx = x - this.editorLastMouseX;
            this.editorLastMouseX = x;

            const total = this.currentRecordingDuration || 30;
            const deltaT = this.xToTime(dx) - this.xToTime(0);

            const start = this.currentSelection.startTime || 0;
            const dur = this.currentSelection.duration || 0;
            const end = start + dur;

            if (this.editorDragging === 'region') {
                const newStart = Math.min(Math.max(0, start + deltaT), Math.max(0, total - dur));
                this.currentSelection.startTime = newStart;
                this.currentSelection.endTime = newStart + dur;
            } else if (this.editorDragging === 'start') {
                const newStart = Math.min(Math.max(0, start + deltaT), end - 0.05);
                this.currentSelection.startTime = newStart;
                this.currentSelection.duration = Math.max(0.05, end - newStart);
                this.currentSelection.endTime = newStart + this.currentSelection.duration;
            } else if (this.editorDragging === 'end') {
                const newEnd = Math.max(start + 0.05, Math.min(total, end + deltaT));
                this.currentSelection.duration = Math.max(0.05, newEnd - start);
                this.currentSelection.endTime = start + this.currentSelection.duration;
            }

            this.ensureEditorViewContainsSelection();
            this.updateEditorTimesUI();
            this.renderEditor();
        };

        const onUp = () => {
            this.editorDragging = null;
        };

        canvas.addEventListener('mousedown', onDown);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);

        this._editorCanvas = canvas;
        this._editorOnDown = onDown;
        this._editorOnMove = onMove;
        this._editorOnUp = onUp;
    }

    detachEditorMouseHandlers() {
        if (this._editorCanvas && this._editorOnDown) {
            try { this._editorCanvas.removeEventListener('mousedown', this._editorOnDown); } catch {}
        }
        if (this._editorOnMove) {
            try { window.removeEventListener('mousemove', this._editorOnMove); } catch {}
        }
        if (this._editorOnUp) {
            try { window.removeEventListener('mouseup', this._editorOnUp); } catch {}
        }
        this._editorCanvas = null;
        this._editorOnDown = null;
        this._editorOnMove = null;
        this._editorOnUp = null;
    }

    renderEditor() {
        const canvas = document.getElementById('editor-waveform');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        // Sync canvas buffer size to CSS display size to avoid coordinate mismatch
        const W = canvas.getBoundingClientRect().width || canvas.width;
        const H = canvas.getBoundingClientRect().height || canvas.height;
        if (canvas.width !== Math.round(W)) canvas.width = Math.round(W);
        if (canvas.height !== Math.round(H)) canvas.height = Math.round(H);

        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Waveform real
        if (this.editorPeaks && (this.currentRecordingDuration || 0) > 0) {
            const mid = canvas.height / 2;
            const amp = (canvas.height / 2) * 0.9;

            ctx.strokeStyle = '#00ff41';
            ctx.lineWidth = 1;
            ctx.beginPath();

            const total = this.currentRecordingDuration;
            const viewDur = total / this.editorZoom;
            const startT = this.editorViewStart;

            const peaks = this.editorPeaks;
            const points = peaks.length;

            for (let x = 0; x < canvas.width; x++) {
                const t = startT + (x / canvas.width) * viewDur;
                const idx = Math.min(points - 1, Math.max(0, Math.floor((t / total) * points)));
                const p = peaks[idx];
                const y = mid - p * amp;
                if (x === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();

            // Línea base
            ctx.strokeStyle = 'rgba(255,255,255,0.08)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, mid);
            ctx.lineTo(canvas.width, mid);
            ctx.stroke();
        }

        // Región seleccionada + handles
        if (this.currentSelection) {
            const selStartX = this.timeToX(this.currentSelection.startTime || 0);
            const selEndX = this.timeToX((this.currentSelection.startTime || 0) + (this.currentSelection.duration || 0));
            const left = Math.min(selStartX, selEndX);
            const right = Math.max(selStartX, selEndX);

            ctx.fillStyle = 'rgba(0, 212, 255, 0.18)';
            ctx.fillRect(left, 0, Math.max(1, right - left), canvas.height);

            ctx.strokeStyle = '#00d4ff';
            ctx.lineWidth = 2;
            ctx.strokeRect(left, 0, Math.max(1, right - left), canvas.height);

            // handles
            ctx.fillStyle = '#00d4ff';
            const hw = 6;
            ctx.fillRect(left - hw / 2, 0, hw, canvas.height);
            ctx.fillRect(right - hw / 2, 0, hw, canvas.height);
        }

        // Playhead
        if (this.editorAudio && !Number.isNaN(this.editorAudio.currentTime)) {
            const px = this.timeToX(this.editorAudio.currentTime);
            ctx.strokeStyle = 'rgba(255, 0, 64, 0.95)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(px, 0);
            ctx.lineTo(px, canvas.height);
            ctx.stroke();
        }

        this.updateEditorTimesUI();
    }

    updateEditorTimesUI() {
        const startEl = document.getElementById('sel-start');
        const endEl = document.getElementById('sel-end');
        const durEl = document.getElementById('sel-dur');
        if (!startEl || !endEl || !durEl || !this.currentSelection) return;

        const start = this.currentSelection.startTime || 0;
        const dur = this.currentSelection.duration || 0;
        const end = start + dur;
        startEl.textContent = this.formatDuration(start);
        endEl.textContent = this.formatDuration(end);
        durEl.textContent = this.formatDuration(dur);
    }

    toggleEditorLoop() {
        this.editorLoop = !this.editorLoop;
        const loopBtn = document.getElementById('editor-loop');
        if (loopBtn) {
            loopBtn.innerHTML = `<i class="fas fa-redo"></i> Loop: ${this.editorLoop ? 'ON' : 'OFF'}`;
        }
    }

    toggleEditorPlayback() {
        if (this.editorIsPlaying) {
            this.stopEditorPlayback();
            return;
        }
        this.startEditorPlayback();
    }

    startEditorPlayback() {
        if (!this.currentRecording) return;
        if (!this.currentSelection) return;

        this.stopEditorPlayback();
        const url = this.createTrackedObjectURL(this.currentRecording);
        this.editorAudio = new Audio(url);
        this.editorAudio.play();
        this.editorAudio.onended = () => this.cleanupObjectURL(url);
        this.editorAudio.currentTime = Math.max(0, this.currentSelection.startTime || 0);

        const endTime = Math.max(0, (this.currentSelection.startTime || 0) + (this.currentSelection.duration || 0));
        this.editorIsPlaying = true;
        this.updateEditorPlayButton();

        const tick = () => {
            if (!this.editorIsPlaying || !this.editorAudio) return;
            if (this.editorLoop && this.editorAudio.currentTime >= endTime) {
                this.editorAudio.currentTime = Math.max(0, this.currentSelection.startTime || 0);
            }
            this.renderEditor();
            this.editorPlayheadRaf = requestAnimationFrame(tick);
        };

        this.editorAudio.addEventListener('ended', () => {
            this.cleanupObjectURL(url);
            if (!this.editorLoop) this.stopEditorPlayback();
        });

        this.editorAudio.addEventListener('error', () => {
            this.cleanupObjectURL(url);
            this.stopEditorPlayback();
        });

        this.editorAudio.play().catch(() => {
            this.stopEditorPlayback();
        });

        this.editorPlayheadRaf = requestAnimationFrame(tick);
    }

    stopEditorPlayback() {
        this.editorIsPlaying = false;
        if (this.editorPlayheadRaf) {
            cancelAnimationFrame(this.editorPlayheadRaf);
            this.editorPlayheadRaf = null;
        }
        if (this.editorAudio) {
            try { this.editorAudio.pause(); } catch {}
        }
        this.updateEditorPlayButton();
        const canvas = document.getElementById('editor-waveform');
        if (canvas) this.renderEditor();
    }

    updateEditorPlayButton() {
        const playBtn = document.getElementById('editor-play');
        if (!playBtn) return;
        playBtn.innerHTML = this.editorIsPlaying
            ? '<i class="fas fa-pause"></i> Pause'
            : '<i class="fas fa-play"></i> Play';
    }

    setupPhraseSelection(canvas) {
        if (this._phraseSelectionController) {
            this._phraseSelectionController.abort();
        }
        this._phraseSelectionController = new AbortController();
        const signal = this._phraseSelectionController.signal;

        let isSelecting = false;
        let startX = 0;
        let endX = 0;

        const handleMouseDown = (e) => {
            isSelecting = true;
            startX = e.offsetX;
            endX = e.offsetX;

            this._drawWaveform(canvas);
        };

        const handleMouseMove = (e) => {
            if (!isSelecting) return;
            endX = e.offsetX;
            this.drawSelection(canvas, startX, endX);
        };

        const handleMouseUp = (e) => {
            if (!isSelecting) return;
            isSelecting = false;
            endX = e.offsetX;
            this.highlightSelection(canvas, startX, endX);
        };

        canvas.addEventListener('mousedown', handleMouseDown, { signal });
        canvas.addEventListener('mousemove', handleMouseMove, { signal });
        canvas.addEventListener('mouseup', handleMouseUp, { signal });
        canvas.addEventListener('mouseleave', handleMouseUp, { signal });
    }

    drawSelection(canvas, startX, endX) {
        const ctx = canvas.getContext('2d');
        
        // Redibujar waveform
        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = '#00ff41';
        ctx.lineWidth = 2;
        ctx.beginPath();
        
        // Redibujar línea de base
        ctx.moveTo(0, canvas.height / 2);
        ctx.lineTo(canvas.width, canvas.height / 2);
        ctx.stroke();
        
        // Redibujar waveform simulado
        ctx.beginPath();
        for (let x = 0; x < canvas.width; x += 5) {
            const y = canvas.height / 2 + Math.sin(x * 0.05) * 50 * Math.random();
            if (x === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.stroke();
        
        // Dibujar selección
        ctx.fillStyle = 'rgba(0, 212, 255, 0.3)';
        const selectionStart = Math.min(startX, endX);
        const selectionWidth = Math.abs(endX - startX);
        ctx.fillRect(selectionStart, 0, selectionWidth, canvas.height);
        
        // Dibujar bordes de selección
        ctx.strokeStyle = '#00d4ff';
        ctx.lineWidth = 2;
        ctx.strokeRect(selectionStart, 0, selectionWidth, canvas.height);
    }

    highlightSelection(canvas, startX, endX) {
        this.drawSelection(canvas, startX, endX);

        const selectionStartPx = Math.min(startX, endX);
        const selectionEndPx = Math.max(startX, endX);
        const startRatio = selectionStartPx / canvas.width;
        const endRatio = selectionEndPx / canvas.width;
        const durationRatio = Math.max(0, endRatio - startRatio);

        const totalDuration = this.currentRecordingDuration || 30;
        const startTime = startRatio * totalDuration;
        const duration = durationRatio * totalDuration;

        // Guardar selección en unidades de tiempo reales
        this.currentSelection = {
            startPx: selectionStartPx,
            endPx: selectionEndPx,
            startTime,
            duration,
            endTime: startTime + duration
        };
        
        // Mostrar información de la selección
        const selectionDuration = this.currentSelection.duration.toFixed(1);
        console.log(`Selección: ${selectionDuration} segundos`);
    }

    playSelection() {
        if (!this.currentSelection || !this.currentRecording) {
            this.showNotification('Primero selecciona un fragmento en el editor', 'info');
            return;
        }

        const url = this.createTrackedObjectURL(this.currentRecording);
        const audio = new Audio(url);
        const startTime = Math.max(0, this.currentSelection.startTime || 0);
        const duration = Math.max(0.1, this.currentSelection.duration || 0);

        audio.addEventListener('canplay', () => {
            audio.currentTime = startTime;
            audio.play().catch(err => {
                console.error('Error reproduciendo selección:', err);
                this.showNotification('Error al reproducir. Intenta de nuevo.', 'error');
                this.cleanupObjectURL(url);
            });
        }, { once: true });

        audio.addEventListener('error', () => {
            this.showNotification('Error al cargar el audio', 'error');
            this.cleanupObjectURL(url);
        }, { once: true });

        const stopTimer = setTimeout(() => {
            audio.pause();
            this.cleanupObjectURL(url);
        }, duration * 1000);

        audio.onended = () => {
            clearTimeout(stopTimer);
            this.cleanupObjectURL(url);
        };
    }

    addPhrase() {
        if (!this.currentSelection) {
            this.showNotification('Primero selecciona un fragmento arrastrando sobre el waveform', 'info');
            return;
        }

        const savedSelection = { ...this.currentSelection };
        const savedRecording = this.currentRecording;

        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; inset: 0; background: rgba(0,0,0,0.75);
            display: flex; align-items: center; justify-content: center;
            z-index: 20000;
        `;
        overlay.innerHTML = `
            <div style="background: var(--bg-secondary, #1a1a2e); border: 1px solid #00ff41;
                        border-radius: 12px; padding: 2rem; max-width: 380px; width: 90%;">
                <p style="margin: 0 0 1rem; color: #fff; font-weight: bold; font-family: monospace;">
                    Nombre de la frase
                </p>
                <p style="margin: 0 0 1rem; color: #aaa; font-size: 0.85rem;">
                    Duración: ${(savedSelection.duration || 0).toFixed(1)}s
                </p>
                <input id="phrase-name-overlay-input" type="text"
                    placeholder="Ej: Lick bebop compás 4"
                    style="width: 100%; padding: 0.6rem; border-radius: 8px;
                           border: 1px solid #00ff41; background: #0a0a0a;
                           color: #fff; font-size: 1rem; box-sizing: border-box;
                           margin-bottom: 1.2rem;" />
                <div style="display: flex; gap: 0.8rem; justify-content: flex-end;">
                    <button id="phrase-overlay-cancel"
                        style="padding: 0.5rem 1.2rem; border-radius: 8px;
                               border: 1px solid #444; background: transparent;
                               color: #aaa; cursor: pointer;">Cancelar</button>
                    <button id="phrase-overlay-ok"
                        style="padding: 0.5rem 1.2rem; border-radius: 8px;
                               border: none; background: #00ff41;
                               color: #000; cursor: pointer; font-weight: bold;">Guardar</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const input = overlay.querySelector('#phrase-name-overlay-input');
        setTimeout(() => input.focus(), 50);

        const confirm = () => {
            const phraseName = String(input.value || '').trim();
            document.body.removeChild(overlay);
            if (!phraseName) return;

            const phrase = {
                id: Date.now(),
                name: phraseName,
                description: `Frase de ${this.formatDuration(savedSelection.duration)}`,
                style: 'custom',
                audioBlob: null,
                sourceBlob: savedRecording,
                startTime: savedSelection.startTime,
                duration: savedSelection.duration
            };

            this.selectedPhrases = this.selectedPhrases || [];
            this.selectedPhrases.push(phrase);
            this.updatePhrasesList();
            this.currentSelection = null;

            const canvas = document.getElementById('editor-waveform');
            if (canvas) this.initPhraseEditor();

            this.showNotification(`"${phraseName}" agregada a la lista`, 'success');
        };

        overlay.querySelector('#phrase-overlay-ok').addEventListener('click', confirm);
        overlay.querySelector('#phrase-overlay-cancel').addEventListener('click', () => {
            document.body.removeChild(overlay);
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') confirm();
            if (e.key === 'Escape') document.body.removeChild(overlay);
        });
    }

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
    }

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
            await this.ensurePhraseHasExportedAudio(phrase);

            // Insert the lick row first to get its UUID
            const { data: lickRow, error: insertErr } = await insertLick({
                name: phrase.name || 'Frase',
                style: phrase.style || 'custom',
                notes: phrase.description || '',
                order_index: this.licks.length + saved
            });
            if (insertErr || !lickRow) continue;

            // Upload the trimmed audio blob
            const trimmedBlob = phrase.audioBlob instanceof Blob ? phrase.audioBlob : null;
            if (trimmedBlob) {
                const { filePath, error: uploadErr } = await uploadLickAudio(trimmedBlob, lickRow.id);
                if (!uploadErr && filePath) {
                    await updateLick(lickRow.id, { file_path: filePath });
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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

    filterLicks(style) {
        this.loadLicks();
    }

    selectLick(lickId) {
        const lick = this.licks.find(l => l.id === lickId);
        if (lick) {
            this.showNotification(`Lick seleccionado: ${lick.name}`, 'info');
        }
    }

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
    }

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
    }

    selectAllLicks() {
        const filter = document.getElementById('style-filter');
        const filterValue = filter ? filter.value : 'all';
        
        const filteredLicks = filterValue === 'all' 
            ? this.licks 
            : this.licks.filter(lick => lick.style === filterValue);
        
        filteredLicks.forEach(lick => this.selectedLicks.add(lick.id));
        this.loadLicks();
    }

    deselectAllLicks() {
        this.selectedLicks.clear();
        this.loadLicks();
    }

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
    }

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
    }

    async deleteLick(lickId) {
        if (!await this.showConfirm('¿Estás seguro de eliminar este lick?')) return;
        const { error } = await deleteLick(lickId);
        if (error) {
            this.showNotification(ERR_MSG, 'error');
            return;
        }
        this.showNotification('Lick eliminado', 'info');
        await this.loadLicks();
    }

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
    }

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
    }

    saveToLocalStorage() {
        // Guardar datos importantes en localStorage
        const dataToSave = {
            licks: this.licks,
        };
        localStorage.setItem('userData', JSON.stringify(dataToSave));
    }

    loadUserData() {
        // Data is loaded from Supabase. This is now a no-op stub kept for compatibility.
        // Actual loading happens in loadLicks() and updateTempRecordingsList().
    }

    closeModal() {
        // Si el editor está abierto, detener reproducción/loop para evitar que se “trabe”
        this.stopEditorPlayback();
        this.editorDragging = null;
        this.detachEditorMouseHandlers();
        document.getElementById('modal').classList.add('hidden');
    }

    // ===== PROGRESS SECTION =====

    checkBadgeUpgrades() {
        const stats = this.progressTracker.getStats(this.licks.length);
        const upgrades = this.progressTracker.evaluateBadges(stats);
        upgrades.forEach((u, i) => {
            setTimeout(() => this.showBadgeToast(u), i * 500);
        });
    }

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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

    _handleChartHover(e) {
        const rect = e.target.getBoundingClientRect();
        this._showChartTooltip(e.clientX - rect.left, e.clientY - rect.top);
    }

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
    }
}

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.app = new PianoStudyApp();
});

// Global function for section navigation
function showSection(sectionName) {
    window.app.showSection(sectionName);
}
