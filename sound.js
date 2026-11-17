// Synthesized sounds (no audio files). Mirrors AudioManager's mixer groups:
// Master, Music (BGM: Main / Yacht), Interface (clicks), Effects (dice, score, timer tick, win/lose).
(function (root) {
  'use strict';
  let ctx = null, master, music, ui, sfx, noiseBuf;
  let vols = { master: 40, music: 40, ui: 40, sfx: 40 }, muted = false;
  let bgmType = null, bgmTimer = null, bgmNext = 0, bgmStep = 0;

  function ensure() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return true; }
    const AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return false;
    try { ctx = new AC(); } catch { return false; }
    master = ctx.createGain(); master.connect(ctx.destination);
    music = ctx.createGain(); music.connect(master);
    ui = ctx.createGain(); ui.connect(master);
    sfx = ctx.createGain(); sfx.connect(master);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    applyVolumes();
    if (bgmType) startBgm(bgmType);
    return true;
  }
  // perceptual curve: slider 0..100 -> gain
  const g = v => Math.pow(Math.max(0, Math.min(100, v)) / 100, 2);
  function applyVolumes() {
    if (!ctx) return;
    const t = ctx.currentTime;
    master.gain.setTargetAtTime(muted ? 0 : g(vols.master) * 1.6, t, 0.02);
    music.gain.setTargetAtTime(g(vols.music) * 0.5, t, 0.02);
    ui.gain.setTargetAtTime(g(vols.ui), t, 0.02);
    sfx.gain.setTargetAtTime(g(vols.sfx), t, 0.02);
  }

  function tone(bus, freq, start, dur, { type = 'sine', vol = 0.3, attack = 0.005, slide = 0 } = {}) {
    const o = ctx.createOscillator(), e = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, start);
    if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, start + dur);
    e.gain.setValueAtTime(0, start);
    e.gain.linearRampToValueAtTime(vol, start + attack);
    e.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(e); e.connect(bus);
    o.start(start); o.stop(start + dur + 0.02);
  }
  function noise(bus, start, dur, { vol = 0.3, freq = 2500, q = 1 } = {}) {
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), e = ctx.createGain();
    s.buffer = noiseBuf; f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    e.gain.setValueAtTime(vol, start); e.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    s.connect(f); f.connect(e); e.connect(bus);
    s.start(start); s.stop(start + dur + 0.02);
  }
  const N = m => 440 * Math.pow(2, (m - 69) / 12);

  const SOUNDS = {
    click: t => tone(ui, 900, t, 0.05, { type: 'triangle', vol: 0.25 }),
    hold: t => { tone(ui, 520, t, 0.06, { type: 'square', vol: 0.08 }); tone(ui, 780, t + 0.03, 0.05, { type: 'square', vol: 0.06 }); },
    roll: t => {
      for (let i = 0; i < 9; i++) {
        const at = t + i * 0.045 + Math.random() * 0.02;
        noise(sfx, at, 0.05, { vol: 0.5 - i * 0.04, freq: 1800 + Math.random() * 2500, q: 2 });
        tone(sfx, 180 + Math.random() * 120, at, 0.04, { type: 'triangle', vol: 0.12 });
      }
    },
    score: t => { tone(sfx, N(76), t, 0.18, { vol: 0.25 }); tone(sfx, N(83), t + 0.08, 0.25, { vol: 0.2 }); },
    zero: t => tone(sfx, N(57), t, 0.25, { type: 'triangle', vol: 0.2, slide: 0.8 }),
    special: t => [72, 76, 79, 84].forEach((m, i) => tone(sfx, N(m), t + i * 0.09, 0.3, { type: 'triangle', vol: 0.22 })),
    tick: t => tone(sfx, 1500, t, 0.03, { type: 'square', vol: 0.08 }),
    turn: t => { tone(ui, N(79), t, 0.12, { vol: 0.18 }); tone(ui, N(84), t + 0.1, 0.18, { vol: 0.18 }); },
    win: t => [60, 64, 67, 72, 76, 79, 84].forEach((m, i) => tone(sfx, N(m), t + i * 0.1, 0.45, { type: 'triangle', vol: 0.2 })),
    lose: t => [67, 63, 60, 55].forEach((m, i) => tone(sfx, N(m), t + i * 0.18, 0.4, { type: 'sine', vol: 0.2 })),
    achievement: t => [79, 83, 86, 91].forEach((m, i) => tone(sfx, N(m), t + i * 0.07, 0.35, { vol: 0.18 })),
    invite: t => { tone(ui, N(88), t, 0.15, { vol: 0.2 }); tone(ui, N(84), t + 0.15, 0.25, { vol: 0.2 }); },
  };

  // ---- BGM (BGMType.Main / BGMType.Yacht): tiny generative loops ----
  const PATTERNS = {
    main: { bpm: 72, chords: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]], arp: false },
    yacht: { bpm: 104, chords: [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]], arp: true },
  };
  function scheduleBgm() {
    const p = PATTERNS[bgmType];
    if (!p || !ctx) return;
    const beat = 60 / p.bpm;
    while (bgmNext < ctx.currentTime + 0.4) {
      const bar = Math.floor(bgmStep / 8) % p.chords.length, sub = bgmStep % 8;
      const ch = p.chords[bar];
      if (sub === 0) {
        ch.forEach(m => tone(music, N(m), bgmNext, beat * 4, { type: 'sine', vol: 0.07, attack: 0.3 }));
        tone(music, N(ch[0] - 12), bgmNext, beat * 4, { type: 'triangle', vol: 0.09, attack: 0.05 });
      }
      if (p.arp && sub % 2 === 0) tone(music, N(ch[(sub / 2) % 3] + 12), bgmNext, beat * 0.9, { type: 'triangle', vol: 0.05 });
      if (!p.arp && sub === 4) tone(music, N(ch[2] + 12), bgmNext, beat * 2, { type: 'sine', vol: 0.04, attack: 0.1 });
      bgmNext += beat / 2; bgmStep++;
    }
  }
  function startBgm(type) {
    clearInterval(bgmTimer);
    bgmType = type;
    if (!type || !ctx) return;
    bgmNext = ctx.currentTime + 0.1; bgmStep = 0;
    bgmTimer = setInterval(scheduleBgm, 120);
    scheduleBgm();
  }

  root.YachtSound = {
    /** Call from a user gesture (browsers block audio until then). */
    unlock() { ensure(); },
    play(name) {
      if (!ctx || muted || !SOUNDS[name]) return;
      try { SOUNDS[name](ctx.currentTime + 0.01); } catch {}
    },
    bgm(type) { if (type === bgmType) return; startBgm(type); if (!type) bgmType = null; },
    setVolumes(v, m) { vols = { ...vols, ...v }; muted = !!m; applyVolumes(); },
  };
})(typeof window !== 'undefined' ? window : globalThis);
