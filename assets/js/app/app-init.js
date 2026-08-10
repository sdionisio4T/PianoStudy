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

Object.assign(PianoStudyApp.prototype, stateMixin, uiMixin, controllersMixin, audioFlowMixin);

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.app = new PianoStudyApp();
});

// Global function for section navigation
function showSection(sectionName) {
    window.app.showSection(sectionName);
}
