export class YouTubeManager {
    constructor() {
        this.player = null;
        this.currentVideoId = null;
        this.currentVideoTitle = '';
        this.segmentStart = null;
        this.segmentEnd = null;
        this.updateInterval = null;
        this.isReady = false;

        // Flags del watcher del segmento.
        this._segmentPaused = false;      // ya pausamos al llegar al endTime — no re-pausar cada tick
        this._ignorePauseUntil = 0;       // ventana de gracia tras un seek async

        this.onTimeUpdate = () => {};
    }

    init() {
        if (typeof window.YT !== 'undefined' && window.YT.loaded) {
            this.onYouTubeReady();
        } else {
            window.onYouTubeIframeAPIReady = () => this.onYouTubeReady();
        }
    }

    onYouTubeReady() {
        this.isReady = true;
    }

    extractVideoId(url) {
        const regExp = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
        const match = String(url || '').match(regExp);
        return (match && match[7] && match[7].length === 11) ? match[7] : null;
    }

    loadVideo(url) {
        const videoId = this.extractVideoId(url);

        if (!videoId) {
            throw new Error('URL de YouTube inválida');
        }

        if (!this.isReady) {
            throw new Error('YouTube API no está lista');
        }

        this.currentVideoId = videoId;
        this.clearSegment();

        if (this.player) {
            this.player.loadVideoById(videoId);
        } else {
            this.player = new window.YT.Player('youtube-player', {
                height: '360',
                width: '640',
                videoId: videoId,
                playerVars: {
                    playsinline: 1,
                    controls: 1,
                    rel: 0
                },
                events: {
                    onReady: (event) => this.onPlayerReady(event),
                    onStateChange: (event) => this.onPlayerStateChange(event)
                }
            });
        }

        return videoId;
    }

    onPlayerReady() {
        this.currentVideoTitle = 'Video de YouTube';
        // Vigilante siempre activo: aunque el video esté pausado necesitamos actualizar
        // el display de tiempo y detectar el final del segmento sin depender de que
        // se dispare onStateChange (que puede llegar tarde o pisarse con seeks).
        this.startTimeUpdate();
    }

    onPlayerStateChange(event) {
        if (!window.YT || !window.YT.PlayerState) return;
        const names = { '-1': 'UNSTARTED', 0: 'ENDED', 1: 'PLAYING', 2: 'PAUSED', 3: 'BUFFERING', 5: 'CUED' };
        console.log('[YT] state:', names[event.data] || event.data, 'cur=', this.player?.getCurrentTime?.());
        // No detenemos el intervalo en PAUSED/BUFFERING: eso creaba una race
        // condition al repetir playSegment (seek + play disparan varios cambios
        // de estado y el intervalo desaparecía justo cuando lo necesitábamos).
        // El intervalo sigue vivo mientras haya player.
        if (event.data === window.YT.PlayerState.PLAYING) {
            this.startTimeUpdate();
        }
    }

    startTimeUpdate() {
        this.stopTimeUpdate();

        this.updateInterval = setInterval(() => {
            if (!this.player || typeof this.player.getCurrentTime !== 'function') return;
            const currentTime = this.player.getCurrentTime();
            this.onTimeUpdate(currentTime);

            // Ventana de gracia tras un seek asíncrono: no pausar aunque el player
            // reporte aún el endTime (el seek al inicio todavía no surtió efecto).
            if (this._ignorePauseUntil && performance.now() < this._ignorePauseUntil) return;

            // Ya pausamos por segmento: no volver a hacerlo cada 100ms.
            if (this._segmentPaused) return;

            if (this.segmentEnd !== null && currentTime >= this.segmentEnd) {
                this._segmentPaused = true;
                console.log('[YT] end reached, pausing at', currentTime, 'end=', this.segmentEnd);
                try { this.player.pauseVideo(); } catch { /* noop */ }
                // Dejar el cursor listo en el inicio para el próximo play.
                try { this.player.seekTo(this.segmentStart, true); } catch { /* noop */ }
            }
        }, 100);
    }

    stopTimeUpdate() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
    }

    markStart() {
        if (this.player) {
            this.segmentStart = this.player.getCurrentTime();
            this._segmentPaused = false;
            return this.segmentStart;
        }
        return null;
    }

    markEnd() {
        if (this.player) {
            this.segmentEnd = this.player.getCurrentTime();

            if (this.segmentStart !== null && this.segmentEnd <= this.segmentStart) {
                throw new Error('El final debe ser después del inicio');
            }

            this._segmentPaused = false;
            return this.segmentEnd;
        }
        return null;
    }

    playSegment() {
        if (this.segmentStart === null || this.segmentEnd === null) {
            throw new Error('Debes marcar inicio y final primero');
        }
        if (!this.player) return;

        console.log('[YT] playSegment', { start: this.segmentStart, end: this.segmentEnd, cur: this.player.getCurrentTime?.() });

        // Reset del flag: ahora sí puede volver a pausar cuando llegue al endTime.
        this._segmentPaused = false;

        // Pauso primero para dejar el player en un estado conocido.
        try { this.player.pauseVideo(); } catch { /* noop */ }
        // Ventana de gracia amplia: seekTo es async y el player puede ir a BUFFERING.
        this._ignorePauseUntil = performance.now() + 900;
        this.player.seekTo(this.segmentStart, true);

        // Esperar un tick real antes de play — le da al iframe tiempo de reposicionar.
        setTimeout(() => {
            if (!this.player) return;
            try {
                this.player.playVideo();
                console.log('[YT] playVideo llamado, cur=', this.player.getCurrentTime?.());
            } catch (e) {
                console.error('[YT] playVideo error:', e);
            }
            this.startTimeUpdate();
        }, 150);
    }

    getDuration() {
        if (this.player && typeof this.player.getDuration === 'function') {
            return this.player.getDuration();
        }
        return 0;
    }

    getCurrentTime() {
        if (this.player && typeof this.player.getCurrentTime === 'function') {
            return this.player.getCurrentTime();
        }
        return 0;
    }

    getSegmentData() {
        if (this.segmentStart === null || this.segmentEnd === null) {
            return null;
        }

        return {
            videoId: this.currentVideoId,
            videoTitle: this.currentVideoTitle,
            start: this.segmentStart,
            end: this.segmentEnd,
            duration: this.segmentEnd - this.segmentStart
        };
    }

    clearSegment() {
        this.segmentStart = null;
        this.segmentEnd = null;
        this._segmentPaused = false;
        this._ignorePauseUntil = 0;
    }

    formatTime(seconds) {
        const s = Number(seconds) || 0;
        const mins = Math.floor(s / 60);
        const secs = Math.floor(s % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    destroy() {
        this.stopTimeUpdate();
        if (this.player) {
            this.player.destroy();
            this.player = null;
        }
    }
}
