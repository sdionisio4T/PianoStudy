// app-state.js — estado global de PianoStudyApp.
// initState() reemplaza el cuerpo del constructor original; stateMixin trae
// los helpers de estado/almacenamiento. Se combinan sobre PianoStudyApp.prototype
// en app-init.js — comportamiento idéntico al app.js monolítico original.

import { YouTubeManager } from '../modules/YouTubeManager.js';
import { AudioAnalyzer } from '../modules/AudioAnalyzer.js';
import { ProgressTracker } from '../modules/ProgressTracker.js';
import { ArtistsManager } from '../modules/ArtistsManager.js';
import { FavoriteSongsManager } from '../modules/FavoriteSongsManager.js';
import { insertPracticeSession } from '../modules/SupabaseDataManager.js';
import { db } from '../modules/supabase-client.js';

export function initState(app) {
        app.isRecording = false;
        app.isPlaying = false;
        app.mediaRecorder = null;
        app.audioChunks = [];
        app.audioContext = null;
        app.analyser = null;
        app.microphone = null;
        app.backingTrack = null;
        app.currentAudio = null;
        app.currentPlayingAudio = null;
        app.selectedLicks = new Set();
        app.currentRecordingDuration = null;

        // Phrase editor (pro)
        app.editorAudio = null;
        app.editorIsPlaying = false;
        app.editorLoop = true;
        app.editorZoom = 1;
        app.editorViewStart = 0;
        app.editorDecodedBuffer = null;
        app.editorPeaks = null;
        app.editorDecodedSourceBlob = null;
        app.editorPlayheadRaf = null;
        app.editorDragging = null; // 'region' | 'start' | 'end' | 'playhead'
        app.editorLastMouseX = 0;

        app.currentUser = null;
        app.licks = [];
        app.phrases = [];
        app.tempRecordings = [];
        app.recordingStartTime = null;
        app.recordingTimer = null;

        app.objectURLs = new Set();
        app.currentStream = null;

        // Study Player (lick queue)
        app.studyQueue = [];
        app.studyIndex = -1;
        app.studyLoop = true;
        app.studyPlaybackRate = 1;
        app.studyAudio = null;
        app.studyAudioUrl = null;

        // YouTube Study
        app.youtubeManager = new YouTubeManager();
        app.youtubePhrases = [];

        // AI Analysis
        app.audioAnalyzer = new AudioAnalyzer();
        app.aiEngine = null;
        app.currentAnalysis = null;
        app.analysisHistory = [];
        app.currentAnalysisAudioBlob = null;
        app.analysisAudioUrl = null;
        app.analysisSegmentTimer = null;
        app.analysisChat = [];

        // Progress tracking
        app.progressTracker = app.createProgressTracker();
        app._chartResizeObserver = null;

        // Practice timer
        app.practiceTimerInterval = null;
        app.practiceTimerRunning = false;
        app.practiceTimerStartMs = 0;
        app.practiceTimerElapsedSec = 0;
        app.practiceTodayTotalSec = 0;
        app.practiceChartDays = null;
        app.practiceChartStats = { avg: 0, best: 0 };

        app.practiceMilestonesShown = new Set();
        app.practiceCelebrationEl = null;
        app.practiceCelebrationTimer = null;
        try {
            app.navTimerCollapsed = localStorage.getItem('pianostudy-timer-collapsed') === '1';
        } catch {
            app.navTimerCollapsed = false;
        }
        try {
            app.mobileTimerCollapsed = localStorage.getItem('pianostudy-timer-mobile-collapsed') === '1';
        } catch {
            app.mobileTimerCollapsed = false;
        }

        // Artists
        app.artistsManager = new ArtistsManager(app);
        app.favoriteSongsManager = new FavoriteSongsManager(app);
        
        app.init();
}

export const stateMixin = {
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
    },

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
    },

    userKey(base) {
        const u = this.getActiveUsername();
        return u ? `${base}_${u}` : base;
    },

    async getActiveUserId() {
        try {
            const { data } = await db.auth.getSession();
            return data?.session?.user?.id || null;
        } catch {
            return null;
        }
    },

    safeGetLocalStorage(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return fallback;
            return JSON.parse(raw);
        } catch (e) {
            console.error('Error leyendo localStorage:', key, e);
            return fallback;
        }
    },

    safeSetLocalStorage(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (e) {
            console.error('Error escribiendo localStorage:', key, e);
            return false;
        }
    },

    cleanupObjectURL(url) {
        if (this.objectURLs.has(url)) {
            URL.revokeObjectURL(url);
            this.objectURLs.delete(url);
        }
    },

    createTrackedObjectURL(blob) {
        const url = URL.createObjectURL(blob);
        this.objectURLs.add(url);
        return url;
    },

    cleanupContainerObjectURLs(container) {
        if (!container) return;
        container.querySelectorAll?.('audio[data-object-url]').forEach((el) => {
            const url = el.getAttribute('data-object-url');
            if (url) this.cleanupObjectURL(url);
        });
    },

    formatDuration(seconds) {
        const s = Number(seconds);
        if (!Number.isFinite(s)) return '0:00.00';
        const minutes = Math.floor(s / 60);
        const sec = s - minutes * 60;
        const whole = Math.floor(sec);
        const hundredths = Math.floor((sec - whole) * 100);
        return `${minutes}:${whole.toString().padStart(2, '0')}.${hundredths.toString().padStart(2, '0')}`;
    },

    formatHMS(totalSeconds) {
        const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
        const hh = Math.floor(s / 3600);
        const mm = Math.floor((s % 3600) / 60);
        const ss = s % 60;
        return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    },

    getTodayDateStr() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },

    getPendingPracticeKey() {
        return this.userKey('pianostudy-pending-practice-session');
    },

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
    },

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
    },

    saveToLocalStorage() {
        // Guardar datos importantes en localStorage
        const dataToSave = {
            licks: this.licks,
        };
        localStorage.setItem('userData', JSON.stringify(dataToSave));
    },

    loadUserData() {
        // Data is loaded from Supabase. This is now a no-op stub kept for compatibility.
        // Actual loading happens in loadLicks() and updateTempRecordingsList().
    },
};
