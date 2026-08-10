const BADGES = [
    {
        id: 'practicante',
        name: 'Practicante',
        icon: '🎹',
        metric: 'totalStudyHours',
        levels: [
            { name: 'Bronce', threshold: 1, desc: 'Primer hora al piano' },
            { name: 'Plata', threshold: 10, desc: 'Dedicación constante' },
            { name: 'Oro', threshold: 50, desc: 'Maestro del estudio' }
        ]
    },
    {
        id: 'coleccionista',
        name: 'Coleccionista de Licks',
        icon: '🎵',
        metric: 'totalLicks',
        levels: [
            { name: 'Bronce', threshold: 5, desc: 'Iniciando la biblioteca' },
            { name: 'Plata', threshold: 20, desc: 'Biblioteca en crecimiento' },
            { name: 'Oro', threshold: 50, desc: 'Biblioteca maestra' }
        ]
    },
    {
        id: 'grabador',
        name: 'Grabador',
        icon: '🎙️',
        metric: 'totalRecordings',
        levels: [
            { name: 'Bronce', threshold: 5, desc: 'Primeras tomas' },
            { name: 'Plata', threshold: 25, desc: 'En el estudio' },
            { name: 'Oro', threshold: 100, desc: 'Productor incansable' }
        ]
    },
    {
        id: 'racha',
        name: 'Racha',
        icon: '🔥',
        metric: 'currentStreak',
        levels: [
            { name: 'Bronce', threshold: 3, desc: 'Tres días de fuego' },
            { name: 'Plata', threshold: 7, desc: 'Semana perfecta' },
            { name: 'Oro', threshold: 30, desc: 'Un mes sin parar' }
        ]
    }
];

const LEVEL_KEYS = ['bronze', 'silver', 'gold'];
const LEVEL_COLORS = { bronze: '#cd7f32', silver: '#C0C0C0', gold: '#FFD700' };

export class ProgressTracker {
    constructor(options = {}) {
        this.enabled = options.enabled !== false;
        this.storageKey = options.storageKey || 'pianostudy-progress';
        this.badgesKey = options.badgesKey || 'pianostudy-badges';
        this.data = this._load();
        this.badges = this._loadBadges();
    }

    _load() {
        if (!this.enabled) {
            return {
                totalStudySeconds: 0,
                totalRecordings: 0,
                currentStreak: 0,
                lastSessionDate: null,
                dailyMinutes: {}
            };
        }
        try {
            const raw = localStorage.getItem(this.storageKey);
            if (raw) return JSON.parse(raw);
        } catch (e) { console.error('ProgressTracker load error', e); }
        return {
            totalStudySeconds: 0,
            totalRecordings: 0,
            currentStreak: 0,
            lastSessionDate: null,
            dailyMinutes: {}
        };
    }

    _save() {
        if (!this.enabled) return;
        try {
            this._trimDailyMinutes();
            localStorage.setItem(this.storageKey, JSON.stringify(this.data));
        } catch (e) { console.error('ProgressTracker save error', e); }
    }

    _loadBadges() {
        if (!this.enabled) return {};
        try {
            const raw = localStorage.getItem(this.badgesKey);
            if (raw) return JSON.parse(raw);
        } catch (e) { console.error('Badge load error', e); }
        return {};
    }

    _saveBadges() {
        if (!this.enabled) return;
        try {
            localStorage.setItem(this.badgesKey, JSON.stringify(this.badges));
        } catch (e) { console.error('Badge save error', e); }
    }

    _todayStr() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    _trimDailyMinutes() {
        const keys = Object.keys(this.data.dailyMinutes || {}).sort();
        if (keys.length > 90) {
            const toRemove = keys.slice(0, keys.length - 90);
            toRemove.forEach(k => delete this.data.dailyMinutes[k]);
        }
    }

    addStudyTime(seconds) {
        if (!Number.isFinite(seconds) || seconds <= 0) return;
        this.data.totalStudySeconds += seconds;
        const today = this._todayStr();
        const mins = seconds / 60;
        if (!this.data.dailyMinutes) this.data.dailyMinutes = {};
        this.data.dailyMinutes[today] = (this.data.dailyMinutes[today] || 0) + mins;
        this._save();
    }

    incrementRecordings() {
        this.data.totalRecordings++;
        this._save();
    }

    checkAndUpdateStreak() {
        const today = this._todayStr();
        const last = this.data.lastSessionDate;

        if (last === today) {
            return;
        }

        if (last) {
            const lastDate = new Date(last + 'T00:00:00');
            const todayDate = new Date(today + 'T00:00:00');
            const diffDays = Math.round((todayDate - lastDate) / (1000 * 60 * 60 * 24));
            if (diffDays === 1) {
                this.data.currentStreak++;
            } else if (diffDays > 1) {
                this.data.currentStreak = 1;
            }
        } else {
            this.data.currentStreak = 1;
        }

        this.data.lastSessionDate = today;
        this._save();
    }

    getStats(lickCount) {
        return {
            totalStudyHours: this.data.totalStudySeconds / 3600,
            totalStudySeconds: this.data.totalStudySeconds,
            totalRecordings: this.data.totalRecordings,
            currentStreak: this.data.currentStreak,
            totalLicks: lickCount || 0
        };
    }

    evaluateBadges(stats) {
        const upgrades = [];
        const prev = { ...this.badges };

        BADGES.forEach(badge => {
            const val = stats[badge.metric] || 0;
            let reached = null;

            for (let i = badge.levels.length - 1; i >= 0; i--) {
                if (val >= badge.levels[i].threshold) {
                    reached = LEVEL_KEYS[i];
                    break;
                }
            }

            const prevLevel = prev[badge.id] || null;
            const prevIdx = prevLevel ? LEVEL_KEYS.indexOf(prevLevel) : -1;
            const newIdx = reached ? LEVEL_KEYS.indexOf(reached) : -1;

            if (newIdx > prevIdx) {
                this.badges[badge.id] = reached;
                const levelObj = badge.levels[newIdx];
                upgrades.push({
                    badgeId: badge.id,
                    badgeName: badge.name,
                    icon: badge.icon,
                    level: reached,
                    levelName: levelObj.name,
                    desc: levelObj.desc
                });
            } else if (prevIdx >= 0) {
                this.badges[badge.id] = prevLevel;
            }
        });

        if (upgrades.length > 0) {
            this._saveBadges();
        }

        return upgrades;
    }

    getMotivationalPhrase(streak) {
        const n = streak || 0;
        if (n >= 30) return `🔥 ${n} días sin parar. Eres una máquina del jazz.`;
        if (n >= 7) return `¡${n} días de racha! Estás construyendo un hábito real.`;
        if (n >= 3) return `Llevas ${n} días seguidos. ¡El ritmo te pertenece!`;
        return 'Cada gran pianista empezó con una nota. ¡Tú ya empezaste!';
    }

    getLast30DaysData() {
        const days = [];
        const today = new Date();
        for (let i = 29; i >= 0; i--) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            const mins = this.data.dailyMinutes?.[key] || 0;
            days.push({ date: key, minutes: Math.round(mins * 10) / 10, dayObj: d });
        }
        return days;
    }

    getChartStats(days) {
        const activeDays = days.filter(d => d.minutes > 0);
        const avg = activeDays.length > 0
            ? Math.round(activeDays.reduce((s, d) => s + d.minutes, 0) / activeDays.length)
            : 0;
        const best = days.reduce((m, d) => Math.max(m, d.minutes), 0);
        return { avg: Math.round(avg), best: Math.round(best) };
    }

    static get BADGES() { return BADGES; }
    static get LEVEL_KEYS() { return LEVEL_KEYS; }
    static get LEVEL_COLORS() { return LEVEL_COLORS; }
}
