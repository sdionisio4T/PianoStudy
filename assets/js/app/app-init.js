// app-init.js — arranque y wiring de PianoStudyApp.
// Punto de entrada de la app (reemplaza al app.js monolítico original).
// Ensambla la clase a partir de los mixins de dominio y hace el bootstrap.

import { escapeHtml, sanitizeFileName, validateAudioBlob } from '../utils/sanitizers.js';
import { YouTubeManager } from '../modules/YouTubeManager.js';
import { AudioAnalyzer } from '../modules/AudioAnalyzer.js';
import { AIAnalysisEngine } from '../modules/AIAnalysisEngine.js';
import { ProgressTracker } from '../modules/ProgressTracker.js';
import { ArtistsManager } from '../modules/ArtistsManager.js';
import { FavoriteSongsManager } from '../modules/FavoriteSongsManager.js';
import {
    loadLicksFromDB, insertLick, updateLick, deleteLick, uploadLickAudio,
    loadRecordingsFromDB, uploadRecording, getRecordingPublicUrl, deleteRecording,
    loadCustomArtistsFromDB, insertCustomArtist, deleteCustomArtist,
    insertPracticeSession, loadPracticeSessionsRange,
    skeletonHTML, errorHTML, ERR_MSG
} from '../modules/SupabaseDataManager.js';
import { db } from '../modules/supabase-client.js';
import { initState, stateMixin } from './app-state.js';
import { uiMixin } from './app-ui.js';
import { controllersMixin } from './app-controllers.js';
import { audioFlowMixin } from './app-audio-flow.js';
import { settingsMixin } from './app-settings.js';

class PianoStudyApp {
    constructor() {
        initState(this);
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
}

Object.assign(PianoStudyApp.prototype, stateMixin, uiMixin, controllersMixin, audioFlowMixin, settingsMixin);

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.app = new PianoStudyApp();

    // Si el usuario tiene una eliminación de cuenta pendiente, el modal para
    // cancelarla se muestra apenas hay sesión activa. Un solo listener basta,
    // porque `checkPendingDeletion` es idempotente y hace su propio guard.
    const checkDeletion = () => {
        try { window.app.checkPendingDeletion?.(); } catch { /* no-op */ }
    };
    window.addEventListener('auth:login', checkDeletion);
    // También al arranque, por si la sesión ya venía restaurada del localStorage.
    setTimeout(checkDeletion, 300);
});

// Global function for section navigation
function showSection(sectionName) {
    window.app.showSection(sectionName);
}
