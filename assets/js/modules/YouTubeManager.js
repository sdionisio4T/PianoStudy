export class YouTubeManager {
    constructor() {
        this.player = null;
        this.currentVideoId = null;
        this.currentVideoTitle = '';
        this.segmentStart = null;
        this.segmentEnd = null;
        this.updateInterval = null;
        this.isReady = false;

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
    }

    onPlayerStateChange(event) {
        if (!window.YT || !window.YT.PlayerState) return;

        if (event.data === window.YT.PlayerState.PLAYING) {
            this.startTimeUpdate();
        } else {
            this.stopTimeUpdate();
        }
    }

    startTimeUpdate() {
        this.stopTimeUpdate();

        this.updateInterval = setInterval(() => {
            if (this.player && typeof this.player.getCurrentTime === 'function') {
                const currentTime = this.player.getCurrentTime();
                this.onTimeUpdate(currentTime);

                if (this.segmentEnd !== null && currentTime >= this.segmentEnd) {
                    this.player.pauseVideo();
                }
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

            return this.segmentEnd;
        }
        return null;
    }

    playSegment() {
        if (this.segmentStart === null || this.segmentEnd === null) {
            throw new Error('Debes marcar inicio y final primero');
        }

        if (this.player) {
            this.player.seekTo(this.segmentStart, true);
            this.player.playVideo();
        }
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
