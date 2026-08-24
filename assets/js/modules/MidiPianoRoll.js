// MidiPianoRoll — visualización piano-roll + reproducción por síntesis para
// grabaciones MIDI. Sustituye al placeholder que se mostraba antes en la
// sección "Reproductor con marcas" cuando la grabación no era audio.
//
// API pública (pensada para encajar donde antes iba WaveSurfer):
//   const roll = new MidiPianoRoll(container, { notes, duration });
//   roll.on('ready' | 'play' | 'pause' | 'finish' | 'audioprocess' | 'seeking' | 'region-created' | 'region-cleared' | 'moment-click', cb);
//   roll.setMoments([{ timeStart, timeEnd, kind, note }]);
//   roll.play() / pause() / playPause() / seek(t) / getCurrentTime() / getDuration();
//   roll.playRegion({ start, end });
//   roll.userRegion  // { start, end } o null — región dibujada por el usuario
//   roll.clearUserRegion();
//   roll.destroy();
//
// Diseño:
// - SVG puro (sin canvas): responsive por viewBox, cada nota es <rect>.
// - Síntesis: Web Audio API con osciladores triangulares + ADSR corto.
//   No es piano real, pero cumple para "escuchar lo que tocaste" sin depender
//   de una biblioteca de samples pesada.
// - Timing monotónico basado en audioCtx.currentTime — el cursor visual
//   depende de RAF pero la fuente de tiempo es la del contexto de audio.

const SVG_NS = 'http://www.w3.org/2000/svg';

const noteFromMidi = (m) => {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const midi = Math.round(Number(m) || 0);
    if (midi < 12 || midi > 127) return '?';
    return `${names[midi % 12]}${Math.floor(midi / 12) - 1}`;
};

const isBlackKey = (m) => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);

export class MidiPianoRoll {
    constructor(container, { notes = [], duration = 0, height = 160 } = {}) {
        this.container = container;
        this.notes = (Array.isArray(notes) ? notes : [])
            .map(n => ({
                pitch: Number(n?.pitchMidi ?? n?.pitch ?? 0),
                start: Number(n?.startTimeSeconds ?? n?.start ?? 0),
                dur:   Math.max(0.03, Number(n?.durationSeconds ?? n?.duration ?? 0.1)),
                amp:   Math.max(0.1, Math.min(1, Number(n?.amplitude ?? 0.6))),
            }))
            .filter(n => Number.isFinite(n.pitch) && n.pitch > 0);

        // Duración con piso: si vino 0 evitamos divisiones por cero al
        // calcular el ancho de las notas.
        const computedDur = this.notes.length
            ? Math.max(...this.notes.map(n => n.start + n.dur))
            : 0;
        this.duration = Math.max(0.5, Number(duration) || computedDur || 0.5);
        this.height = height;

        // Rango de pitch — 2 semitonos de margen arriba/abajo, o C3-C6 si vacío.
        if (this.notes.length) {
            const pitches = this.notes.map(n => n.pitch);
            this.minPitch = Math.max(21, Math.min(...pitches) - 2);
            this.maxPitch = Math.min(108, Math.max(...pitches) + 2);
        } else {
            this.minPitch = 48; this.maxPitch = 84;
        }
        this.pitchRange = this.maxPitch - this.minPitch + 1;

        // Estado de reproducción.
        this.audioCtx = null;
        this._masterGain = null;
        this._scheduled = [];
        this.isPlaying = false;
        this._playStartCtxTime = 0;   // audioCtx.currentTime cuando arrancó play()
        this._playStartOffset = 0;    // segundos de la pieza donde arrancó
        this.currentTime = 0;
        this._rafId = null;
        this._regionStopWatcher = null;

        // Región marcada por el usuario (para foco del chat).
        this.userRegion = null;

        // Event emitter mínimo.
        this._listeners = new Map();

        this._render();
    }

    on(event, cb) {
        if (!this._listeners.has(event)) this._listeners.set(event, new Set());
        this._listeners.get(event).add(cb);
    }
    off(event, cb) {
        this._listeners.get(event)?.delete(cb);
    }
    _emit(event, ...args) {
        const set = this._listeners.get(event);
        if (!set) return;
        for (const cb of set) {
            try { cb(...args); } catch (e) { console.warn('MidiPianoRoll listener error:', e); }
        }
    }

    _render() {
        // Coordenadas lógicas fijas; el SVG escala por viewBox.
        const W = 1000;
        const H = this.height;
        const noteH = H / this.pitchRange;
        // Publicá logicalW/H ANTES de cualquier helper que las lea (p.ej.
        // _updateCursor llamado durante el primer render). Antes se asignaban
        // al final y el primer setAttribute del cursor recibía NaN.
        this._logicalW = W;
        this._logicalH = H;

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', `${H}px`);
        svg.classList.add('midi-piano-roll');
        svg.style.display = 'block';
        svg.style.cursor = 'crosshair';
        svg.style.userSelect = 'none';
        svg.style.touchAction = 'none';

        // Fondo — filas por semitono (más oscuras en teclas negras) + líneas de octava.
        for (let p = this.minPitch; p <= this.maxPitch; p++) {
            const y = H - (p - this.minPitch + 1) * noteH;
            if (isBlackKey(p)) {
                const bg = document.createElementNS(SVG_NS, 'rect');
                bg.setAttribute('x', 0); bg.setAttribute('y', y);
                bg.setAttribute('width', W); bg.setAttribute('height', noteH);
                bg.setAttribute('fill', 'rgba(255,255,255,0.03)');
                svg.appendChild(bg);
            }
            if ((p % 12) === 0) {
                const line = document.createElementNS(SVG_NS, 'line');
                line.setAttribute('x1', 0); line.setAttribute('x2', W);
                line.setAttribute('y1', y); line.setAttribute('y2', y);
                line.setAttribute('stroke', 'rgba(255,255,255,0.08)');
                line.setAttribute('stroke-width', 0.6);
                svg.appendChild(line);

                const label = document.createElementNS(SVG_NS, 'text');
                label.setAttribute('x', 4);
                label.setAttribute('y', y - 1.5);
                label.setAttribute('fill', 'rgba(255,255,255,0.35)');
                label.setAttribute('font-size', '6');
                label.setAttribute('font-family', 'ui-monospace, monospace');
                label.textContent = noteFromMidi(p);
                svg.appendChild(label);
            }
        }

        // Capa para moments (debajo de las notas).
        this._momentsLayer = document.createElementNS(SVG_NS, 'g');
        this._momentsLayer.classList.add('mpr-moments');
        svg.appendChild(this._momentsLayer);

        // Notas — rectángulos cyan con opacidad según amplitude.
        for (const n of this.notes) {
            const x = (n.start / this.duration) * W;
            const w = Math.max(1.2, (n.dur / this.duration) * W);
            const y = H - (n.pitch - this.minPitch + 1) * noteH;
            const h = Math.max(1.5, noteH - 0.4);
            const rect = document.createElementNS(SVG_NS, 'rect');
            rect.setAttribute('x', x.toFixed(2));
            rect.setAttribute('y', y.toFixed(2));
            rect.setAttribute('width', w.toFixed(2));
            rect.setAttribute('height', h.toFixed(2));
            rect.setAttribute('rx', 0.8);
            rect.setAttribute('fill', `rgba(79, 209, 255, ${(0.35 + n.amp * 0.55).toFixed(2)})`);
            rect.setAttribute('stroke', 'rgba(79, 209, 255, 0.85)');
            rect.setAttribute('stroke-width', 0.3);
            svg.appendChild(rect);
        }

        // Región del usuario — arriba de las notas pero debajo del cursor.
        this._userRegionEl = document.createElementNS(SVG_NS, 'rect');
        this._userRegionEl.setAttribute('y', 0);
        this._userRegionEl.setAttribute('height', H);
        this._userRegionEl.setAttribute('fill', 'rgba(64, 128, 255, 0.20)');
        this._userRegionEl.setAttribute('stroke', 'rgba(64, 128, 255, 0.75)');
        this._userRegionEl.setAttribute('stroke-width', 0.6);
        this._userRegionEl.style.display = 'none';
        this._userRegionEl.setAttribute('pointer-events', 'none');
        svg.appendChild(this._userRegionEl);

        // Cursor de reproducción.
        this._cursorEl = document.createElementNS(SVG_NS, 'line');
        this._cursorEl.setAttribute('y1', 0);
        this._cursorEl.setAttribute('y2', H);
        this._cursorEl.setAttribute('stroke', '#ffffff');
        this._cursorEl.setAttribute('stroke-width', 0.8);
        this._cursorEl.setAttribute('pointer-events', 'none');
        this._updateCursor();
        svg.appendChild(this._cursorEl);

        // Interacción — click seek, drag para marcar región de foco.
        let dragStartT = null;
        let dragMoved = false;
        const timeFromEvent = (ev) => {
            const rect = svg.getBoundingClientRect();
            const x = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
            return (x / rect.width) * this.duration;
        };
        const onDown = (ev) => {
            if (ev.button !== undefined && ev.button !== 0) return;
            dragStartT = timeFromEvent(ev);
            dragMoved = false;
            try { svg.setPointerCapture(ev.pointerId); } catch { /* no PointerEvent */ }
        };
        const onMove = (ev) => {
            if (dragStartT == null) return;
            const t = timeFromEvent(ev);
            if (Math.abs(t - dragStartT) < 0.05) return;
            dragMoved = true;
            const s = Math.min(dragStartT, t);
            const e = Math.max(dragStartT, t);
            this._drawUserRegion(s, e);
        };
        const onUp = (ev) => {
            if (dragStartT == null) return;
            const t = timeFromEvent(ev);
            try { svg.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
            if (!dragMoved) {
                this.seek(dragStartT);
                dragStartT = null;
                return;
            }
            const s = Math.min(dragStartT, t);
            const e = Math.max(dragStartT, t);
            if (e - s < 0.1) { dragStartT = null; return; }
            this.userRegion = { start: s, end: e };
            this._drawUserRegion(s, e);
            this._emit('region-created', this.userRegion);
            dragStartT = null;
        };
        svg.addEventListener('pointerdown', onDown);
        svg.addEventListener('pointermove', onMove);
        svg.addEventListener('pointerup', onUp);
        svg.addEventListener('pointercancel', onUp);

        this.container.innerHTML = '';
        this.container.appendChild(svg);
        this.svg = svg;

        // Si el caller ya seteó moments antes de que rendericemos, los aplicamos.
        if (this._pendingMoments) {
            this.setMoments(this._pendingMoments);
            this._pendingMoments = null;
        }

        setTimeout(() => this._emit('ready'), 0);
    }

    setMoments(moments) {
        if (!this._momentsLayer) { this._pendingMoments = moments; return; }
        this._momentsLayer.innerHTML = '';
        const palette = {
            good:    'rgba(0, 200, 100, 0.16)',
            improve: 'rgba(255, 160, 0, 0.18)',
            neutral: 'rgba(160, 160, 160, 0.12)',
        };
        const stroke = {
            good:    'rgba(0, 200, 100, 0.55)',
            improve: 'rgba(255, 160, 0, 0.55)',
            neutral: 'rgba(160, 160, 160, 0.45)',
        };
        for (const m of (Array.isArray(moments) ? moments : [])) {
            const s = Math.max(0, Number(m?.timeStart) || 0);
            const e = Math.min(this.duration, Number(m?.timeEnd) || s);
            if (e <= s) continue;
            const kind = ['good', 'improve', 'neutral'].includes(m?.kind) ? m.kind : 'neutral';
            const x = (s / this.duration) * this._logicalW;
            const w = ((e - s) / this.duration) * this._logicalW;
            const rect = document.createElementNS(SVG_NS, 'rect');
            rect.setAttribute('x', x.toFixed(2));
            rect.setAttribute('y', 0);
            rect.setAttribute('width', w.toFixed(2));
            rect.setAttribute('height', this._logicalH);
            rect.setAttribute('fill', palette[kind]);
            rect.setAttribute('stroke', stroke[kind]);
            rect.setAttribute('stroke-width', 0.4);
            rect.style.cursor = 'pointer';
            const note = String(m?.note || '');
            if (note) {
                const title = document.createElementNS(SVG_NS, 'title');
                title.textContent = note;
                rect.appendChild(title);
            }
            rect.addEventListener('click', (ev) => {
                ev.stopPropagation();
                this.seek(s);
                this._emit('moment-click', m);
            });
            this._momentsLayer.appendChild(rect);
        }
    }

    _drawUserRegion(start, end) {
        if (!this._userRegionEl) return;
        const x = (start / this.duration) * this._logicalW;
        const w = ((end - start) / this.duration) * this._logicalW;
        this._userRegionEl.setAttribute('x', x.toFixed(2));
        this._userRegionEl.setAttribute('width', w.toFixed(2));
        this._userRegionEl.style.display = '';
    }

    clearUserRegion() {
        this.userRegion = null;
        if (this._userRegionEl) this._userRegionEl.style.display = 'none';
        this._emit('region-cleared');
    }

    _updateCursor() {
        if (!this._cursorEl || !this._logicalW || !this.duration) return;
        const t = Number.isFinite(this.currentTime) ? this.currentTime : 0;
        const x = (t / this.duration) * this._logicalW;
        const safe = Number.isFinite(x) ? x.toFixed(2) : '0';
        this._cursorEl.setAttribute('x1', safe);
        this._cursorEl.setAttribute('x2', safe);
    }

    _ensureAudioCtx() {
        if (!this.audioCtx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            this.audioCtx = new Ctx();
        }
        if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
        return this.audioCtx;
    }

    _midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

    // Programa todas las notas que empiezan a partir de `offset` (segundos de
    // la pieza) para reproducirse en el AudioContext. Con Web Audio la cola de
    // eventos es súper precisa — no necesitamos un scheduler tick a tick.
    _scheduleNotesFrom(offset) {
        const ctx = this._ensureAudioCtx();
        const master = ctx.createGain();
        // Nivel bajo porque muchos triángulos suman rápido y saturan.
        master.gain.value = 0.14;
        master.connect(ctx.destination);
        this._masterGain = master;

        for (const n of this.notes) {
            const relStart = n.start - offset;
            if (relStart + n.dur < 0) continue;      // ya pasó
            const when = ctx.currentTime + Math.max(0, relStart);
            const dur = n.dur;
            const peak = 0.5 * n.amp;

            const osc = ctx.createOscillator();
            osc.type = 'triangle';
            osc.frequency.value = this._midiToFreq(n.pitch);

            const gain = ctx.createGain();
            const attack = 0.006;
            const release = Math.min(0.12, Math.max(0.04, dur * 0.3));
            const holdEnd = when + Math.max(attack, dur - release);
            gain.gain.setValueAtTime(0, when);
            gain.gain.linearRampToValueAtTime(peak, when + attack);
            gain.gain.setValueAtTime(peak, holdEnd);
            gain.gain.linearRampToValueAtTime(0.0001, when + dur);

            osc.connect(gain).connect(master);
            osc.start(when);
            osc.stop(when + dur + 0.02);
            this._scheduled.push(osc);
        }
    }

    _stopAllScheduled() {
        for (const s of this._scheduled) {
            try { s.stop(); } catch { /* ya paró solo */ }
            try { s.disconnect(); } catch { /* noop */ }
        }
        this._scheduled = [];
        if (this._masterGain) {
            try { this._masterGain.disconnect(); } catch { /* noop */ }
            this._masterGain = null;
        }
    }

    _tick() {
        if (!this.isPlaying) return;
        const ctx = this.audioCtx;
        const elapsed = ctx.currentTime - this._playStartCtxTime;
        this.currentTime = this._playStartOffset + elapsed;
        if (this.currentTime >= this.duration) {
            this.currentTime = this.duration;
            this._updateCursor();
            this.pause();
            this._emit('finish');
            return;
        }
        this._updateCursor();
        this._emit('audioprocess', this.currentTime);
        this._rafId = requestAnimationFrame(() => this._tick());
    }

    play() {
        if (this.isPlaying) return;
        const ctx = this._ensureAudioCtx();
        if (this.currentTime >= this.duration - 0.02) this.currentTime = 0;
        this._scheduleNotesFrom(this.currentTime);
        this._playStartCtxTime = ctx.currentTime;
        this._playStartOffset = this.currentTime;
        this.isPlaying = true;
        this._emit('play');
        this._tick();
    }

    pause() {
        if (!this.isPlaying) return;
        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
        const ctx = this.audioCtx;
        if (ctx) {
            const elapsed = ctx.currentTime - this._playStartCtxTime;
            this.currentTime = Math.min(this.duration, this._playStartOffset + elapsed);
        }
        this._stopAllScheduled();
        this.isPlaying = false;
        this._updateCursor();
        this._emit('pause');
        if (this._regionStopWatcher) {
            cancelAnimationFrame(this._regionStopWatcher);
            this._regionStopWatcher = null;
        }
    }

    playPause() { this.isPlaying ? this.pause() : this.play(); }

    seek(t) {
        const wasPlaying = this.isPlaying;
        if (wasPlaying) this.pause();
        this.currentTime = Math.max(0, Math.min(this.duration, Number(t) || 0));
        this._updateCursor();
        this._emit('seeking', this.currentTime);
        if (wasPlaying) this.play();
    }

    // Reproduce un rango puntual [start, end]. Cuando el cursor pasa `end`,
    // se detiene automáticamente. Sirve para el botón "Loop" del reproductor
    // del análisis cuando el usuario tiene un fragmento marcado (mismo UX
    // que ya existía para wavesurfer).
    playRegion(region) {
        if (!region || !Number.isFinite(region.start) || !Number.isFinite(region.end)) return;
        if (region.end <= region.start) return;
        this.seek(region.start);
        this.play();
        const target = region.end;
        const watch = () => {
            if (!this.isPlaying) return;
            if (this.currentTime >= target) { this.pause(); return; }
            this._regionStopWatcher = requestAnimationFrame(watch);
        };
        this._regionStopWatcher = requestAnimationFrame(watch);
    }

    getCurrentTime() { return this.currentTime; }
    getDuration() { return this.duration; }

    destroy() {
        this.pause();
        if (this.audioCtx) {
            try { this.audioCtx.close(); } catch { /* noop */ }
            this.audioCtx = null;
        }
        if (this.container) this.container.innerHTML = '';
        this._listeners.clear();
    }
}
