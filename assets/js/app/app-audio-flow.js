// app-audio-flow.js — flujo de grabación, editor de frases y análisis IA.
// Mezclado sobre PianoStudyApp.prototype en app-init.js.

import { escapeHtml, sanitizeFileName } from '../utils/sanitizers.js';
import { AIAnalysisEngine } from '../modules/AIAnalysisEngine.js';
import {
    insertLick, updateLick, uploadLickAudio,
    loadRecordingsFromDB, uploadRecording, getRecordingPublicUrl, deleteRecording,
    ERR_MSG
} from '../modules/SupabaseDataManager.js';
import { db } from '../modules/supabase-client.js';

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
        this.loadRecordingsForAnalysis();
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
            if (!rec || !(rec.blob instanceof Blob)) return;
            const opt = document.createElement('option');
            opt.value = String(rec.id);
            opt.textContent = `${rec.name} (${this.formatDuration(rec.duration || 0)})`;
            select.appendChild(opt);
        });
    },

    getRecordingBlobForAnalysis(selectionValue) {
        if (selectionValue === 'current') {
            return this.currentRecording instanceof Blob ? this.currentRecording : null;
        }
        const id = Number(selectionValue);
        if (!Number.isFinite(id)) return null;
        const rec = (this.tempRecordings || []).find(r => r.id === id);
        return rec?.blob instanceof Blob ? rec.blob : null;
    },

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
    },

    saveAnalysis() {
        if (!this.currentAnalysis) return;

        this.analysisHistory = Array.isArray(this.analysisHistory) ? this.analysisHistory : [];
        this.analysisHistory.unshift(this.currentAnalysis);
        this.safeSetLocalStorage(this.userKey('pianostudy-analysis-history'), this.analysisHistory);
        this.renderAnalysisHistory();
        this.persistCurrentAnalysisAudio();
        this.showNotification('Análisis guardado', 'success');
    },

    loadAnalysisHistory() {
        if (!this.getActiveUsername()) {
            this.analysisHistory = [];
            this.renderAnalysisHistory();
            return;
        }
        const stored = this.safeGetLocalStorage(this.userKey('pianostudy-analysis-history'), []);
        this.analysisHistory = Array.isArray(stored) ? stored : [];
        this.renderAnalysisHistory();
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

        const audioEl = document.getElementById('analysis-audio');
        if (audioEl) {
            audioEl.removeAttribute('src');
            audioEl.load();
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
        const answer = await engine.answerQuestion(audioAnalysis, aiAnalysis, question);
        this.analysisChat.push({ role: 'assistant', text: String(answer || '') });
        this.renderAnalysisChat();
    },

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
    },

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
    },

    initPhraseEditor() {
        const canvas = document.getElementById('editor-waveform');
        if (!canvas) return;

        this.initCurrentRecordingMetadata();
        this._drawWaveform(canvas);
        this.setupPhraseSelection(canvas);
    },

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
    },

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
    },

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
    },

    setEditorZoom(zoom) {
        this.editorZoom = Math.min(10, Math.max(1, zoom || 1));
        this.ensureEditorViewContainsSelection();
        this.renderEditor();
    },

    ensureEditorViewContainsSelection() {
        const total = this.currentRecordingDuration || 0;
        if (!total || !this.currentSelection) return;
        const viewDur = total / this.editorZoom;
        const selStart = this.currentSelection.startTime || 0;
        const selEnd = (this.currentSelection.startTime || 0) + (this.currentSelection.duration || 0);
        if (selStart < this.editorViewStart) this.editorViewStart = Math.max(0, selStart - 0.1);
        if (selEnd > this.editorViewStart + viewDur) this.editorViewStart = Math.min(Math.max(0, total - viewDur), selEnd - viewDur + 0.1);
    },

    timeToX(t) {
        const canvas = document.getElementById('editor-waveform');
        if (!canvas) return 0;
        const W = canvas.getBoundingClientRect().width || canvas.width;
        const total = this.currentRecordingDuration || 30;
        const viewDur = total / this.editorZoom;
        const rel = (t - this.editorViewStart) / viewDur;
        return rel * W;
    },

    xToTime(x) {
        const canvas = document.getElementById('editor-waveform');
        if (!canvas) return 0;
        const W = canvas.getBoundingClientRect().width || canvas.width;
        const total = this.currentRecordingDuration || 30;
        const viewDur = total / this.editorZoom;
        const rel = x / W;
        return this.editorViewStart + rel * viewDur;
    },

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
    },

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
    },

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
    },

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
    },

    toggleEditorLoop() {
        this.editorLoop = !this.editorLoop;
        const loopBtn = document.getElementById('editor-loop');
        if (loopBtn) {
            loopBtn.innerHTML = `<i class="fas fa-redo"></i> Loop: ${this.editorLoop ? 'ON' : 'OFF'}`;
        }
    },

    toggleEditorPlayback() {
        if (this.editorIsPlaying) {
            this.stopEditorPlayback();
            return;
        }
        this.startEditorPlayback();
    },

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
    },

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
    },

    updateEditorPlayButton() {
        const playBtn = document.getElementById('editor-play');
        if (!playBtn) return;
        playBtn.innerHTML = this.editorIsPlaying
            ? '<i class="fas fa-pause"></i> Pause'
            : '<i class="fas fa-play"></i> Play';
    },

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
    },

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
    },

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
    },

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
    },

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
