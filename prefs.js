// Per-browser storage for settings (SettingArguments / PlayerPrefs in the original),
// stats + achievements (MySteamAchievement / MainUIState) and the local friend list.
(function (root) {
  'use strict';
  const LS = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  // Original defaults: volume sliders 40 (AudioManager.InitVolume), LUT sliders neutral.
  const DEFAULT_KEYS = {
    roll: 'Space', release: 'KeyR',
    hold1: 'Digit1', hold2: 'Digit2', hold3: 'Digit3', hold4: 'Digit4', hold5: 'Digit5',
  };
  const DEFAULT_COLORS = { table: '#1f6b4f', dice: '#fffefa', pip: '#1f2328', pipRed: '#c1121f' };
  const DEFAULTS = {
    lang: typeof navigator !== 'undefined' && navigator.language && !/^ko/i.test(navigator.language) ? 'en' : 'ko',
    theme: 'system', tips: true, reduceMotion: false, confirmZero: false,
    vol: { master: 40, music: 40, ui: 40, sfx: 40 }, mute: false,
    display: { brightness: 100, saturation: 100, contrast: 100 },
    colors: { ...DEFAULT_COLORS },
    keys: { ...DEFAULT_KEYS },
    aiSpeed: 550,
  };
  const clone = o => JSON.parse(JSON.stringify(o));
  function merge(base, over) {
    const out = clone(base);
    if (!over || typeof over !== 'object') return out;
    for (const k of Object.keys(base)) {
      if (!(k in over)) continue;
      if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = merge(base[k], over[k]);
      else if (typeof over[k] === typeof base[k]) out[k] = over[k];
    }
    return out;
  }

  const Settings = {
    data: merge(DEFAULTS, LS.get('yacht.settings')),
    listeners: [],
    save() { LS.set('yacht.settings', this.data); this.listeners.forEach(f => f(this.data)); },
    onChange(f) { this.listeners.push(f); },
    reset() { this.data = clone(DEFAULTS); this.save(); },
    DEFAULTS, DEFAULT_KEYS, DEFAULT_COLORS,
  };

  // ---------------- stats & achievements ----------------
  // Achievement ids follow the original Steam API names.
  const ACHIEVEMENTS = [
    { id: 'WON_ONE_GAME_ACH', icon: '🥇', test: s => s.wins >= 1 },
    { id: 'WON_100_GAME_ACH', icon: '👑', test: s => s.wins >= 100 },
    { id: 'YACHT_ACH', icon: '⛵', test: s => s.yachts >= 1 },
    { id: '50_YACHT_ACH', icon: '🚢', test: s => s.yachts >= 50 },
    { id: '345_SCORE_ACH', icon: '💯', test: s => s.best >= 345 },
    { id: 'PLAY_WITH_FRIEND', icon: '🤝', test: s => s.friendGames >= 1 },
  ];
  const EMPTY_STATS = { games: 0, wins: 0, yachts: 0, best: 0, totalScore: 0, friendGames: 0, unlocked: {} };
  const Stats = {
    data: merge(EMPTY_STATS, LS.get('yacht.stats')),
    recorded: new Set(LS.get('yacht.recordedGames') || []),
    /** Record one finished game once. Returns newly unlocked achievement ids. */
    record(gameKey, { score, won, yachts, withFriend }) {
      if (gameKey && this.recorded.has(gameKey)) return [];
      if (gameKey) {
        this.recorded.add(gameKey);
        LS.set('yacht.recordedGames', [...this.recorded].slice(-50));
      }
      const s = this.data;
      s.games++; s.totalScore += score; s.best = Math.max(s.best, score);
      if (won) s.wins++;
      s.yachts += yachts;
      if (withFriend) s.friendGames++;
      return this.check();
    },
    check() {
      const fresh = [];
      for (const a of ACHIEVEMENTS) if (!this.data.unlocked[a.id] && a.test(this.data)) { this.data.unlocked[a.id] = Date.now(); fresh.push(a.id); }
      LS.set('yacht.stats', this.data);
      return fresh;
    },
    reset() { this.data = clone(EMPTY_STATS); this.recorded.clear(); LS.set('yacht.stats', this.data); LS.del('yacht.recordedGames'); },
    ACHIEVEMENTS,
  };

  // ---------------- identity & friends ----------------
  function userKey() {
    let k = LS.get('yacht.userKey');
    if (typeof k !== 'string' || !/^[0-9a-f]{32}$/.test(k)) {
      const b = new Uint8Array(16);
      (root.crypto || globalThis.crypto).getRandomValues(b);
      k = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
      LS.set('yacht.userKey', k);
    }
    return k;
  }
  const Friends = {
    list: (LS.get('yacht.friends') || []).filter(f => f && typeof f.code === 'string'),
    save() { LS.set('yacht.friends', this.list); },
    has(code) { return this.list.some(f => f.code === code); },
    add(code, name) {
      code = String(code || '').toUpperCase().trim();
      if (!/^[A-Z2-9]{6}$/.test(code) || this.has(code)) return false;
      this.list.push({ code, name: String(name || '').trim().slice(0, 12), added: Date.now() });
      this.save(); return true;
    },
    remove(code) { this.list = this.list.filter(f => f.code !== code); this.save(); },
    rename(code, name) { const f = this.list.find(x => x.code === code); if (f) { f.name = String(name || '').slice(0, 12); this.save(); } },
  };

  root.YachtPrefs = { Settings, Stats, Friends, userKey, LS };
})(typeof window !== 'undefined' ? window : globalThis);
