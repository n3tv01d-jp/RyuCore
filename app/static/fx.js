/* RyuCore 竜核 — animated theme backgrounds 背景. One <canvas id="bgfx"> behind the HUD; each theme picks an effect.
   Cheap by design: no shadowBlur, particle counts scale with the screen area, frame rate capped (lower on touch
   devices), paused while the tab is hidden, a single still frame under prefers-reduced-motion, and an OFF switch. */
'use strict';

const FX = (() => {
  const cv = document.getElementById('bgfx');
  if (!cv) return { set() {}, enable() {}, list: [], themeDefault: () => 'none', describe: {} };
  const g = cv.getContext('2d');
  const COARSE = matchMedia('(pointer: coarse)').matches;
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
  const FPS = COARSE ? 30 : 45;
  let W = 0, H = 0, DPR = 1, raf = 0, last = 0, t = 0, on = true;
  let cur = { name: 'none', eff: null, st: null, col: null, o: { density: 1, speed: 1, glow: 1 } };

  /* ── colour helpers ── */
  const rgb = h => { h = (h || '#000000').trim(); if (h.startsWith('rgb')) return h.match(/\d+/g).slice(0, 3).map(Number); if (h.length === 4) h = '#' + [...h.slice(1)].map(c => c + c).join(''); return [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) || 0); };
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
  const R = (a, b) => a + Math.random() * (b - a);
  const pick = arr => arr[(Math.random() * arr.length) | 0];
  const count = (per, min = 8, max = 400) => Math.round(Math.max(min, Math.min(max, (W * H) / per * cur.o.density * (COARSE ? 0.6 : 1))));
  const glow = (x, y, r, c, a) => { // soft dot: radial gradient (cheaper than shadowBlur)
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, rgba(c, a)); gr.addColorStop(1, rgba(c, 0));
    g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
  };

  /* ── effects: init(st) once per resize/theme, step(st, dt) every frame (dt in seconds, already × speed) ── */
  const E = {};

  E.embers = { // 炉 rising sparks from the core
    init(s) { s.p = Array.from({ length: count(9000, 20, 180) }, () => this.spawn({}, true)); },
    spawn(p, any) {
      return Object.assign(p, { x: R(0, W), y: any ? R(0, H) : H + R(5, 60), r: R(0.6, 2.2), vy: R(18, 55), sw: R(0.4, 1.6), ph: R(0, 6.28),
        life: R(0.5, 1), c: Math.random() < 0.65 ? cur.col.a1 : Math.random() < 0.6 ? cur.col.a2 : cur.col.a3 });
    },
    step(s, dt) {
      g.globalCompositeOperation = 'lighter';
      const k = cur.o.glow;
      for (const p of s.p) {
        p.y -= p.vy * dt; p.ph += dt * p.sw; p.x += Math.sin(p.ph) * 12 * dt;
        const fade = Math.min(1, p.y / H * 1.4) * p.life;
        if (p.y < -20 || fade <= 0.02) this.spawn(p);
        const fl = 0.7 + 0.3 * Math.sin(t * 9 + p.ph * 3);
        glow(p.x, p.y, p.r * 7 * k, p.c, 0.16 * fade * fl * k);
        g.fillStyle = rgba(p.c, 0.85 * fade * fl); g.fillRect(p.x - p.r / 2, p.y - p.r / 2, p.r, p.r);
      }
      g.globalCompositeOperation = 'source-over';
      const base = g.createLinearGradient(0, H, 0, H * 0.7); // heat haze at the bottom
      base.addColorStop(0, rgba(cur.col.a2, 0.07 * k)); base.addColorStop(1, rgba(cur.col.a2, 0));
      g.fillStyle = base; g.fillRect(0, H * 0.7, W, H * 0.3);
    },
  };

  E.radar = { // 赤警報 sweeping scope with contacts
    init(s) { s.a = 0; s.blips = []; s.cx = W * 0.72; s.cy = H * 0.62; s.rad = Math.hypot(W, H) * 0.55; },
    step(s, dt) {
      const { a1, a2, a3 } = cur.col, k = cur.o.glow;
      s.a = (s.a + dt * 0.9) % (Math.PI * 2);
      g.lineWidth = 1;
      for (let i = 1; i <= 6; i++) { g.strokeStyle = rgba(a1, 0.05 + (i === 6 ? 0.03 : 0)); g.beginPath(); g.arc(s.cx, s.cy, s.rad * i / 6, 0, 7); g.stroke(); }
      g.strokeStyle = rgba(a1, 0.05); g.beginPath();
      for (let i = 0; i < 12; i++) { const an = i * Math.PI / 6; g.moveTo(s.cx, s.cy); g.lineTo(s.cx + Math.cos(an) * s.rad, s.cy + Math.sin(an) * s.rad); }
      g.stroke();
      // sweep wedge: a fan of thin slices fading behind the beam
      for (let i = 0; i < 24; i++) {
        const a0 = s.a - i * 0.035;
        g.fillStyle = rgba(a1, (0.09 - i * 0.0037) * k);
        g.beginPath(); g.moveTo(s.cx, s.cy); g.arc(s.cx, s.cy, s.rad, a0 - 0.036, a0); g.closePath(); g.fill();
      }
      g.strokeStyle = rgba(a2, 0.35 * k); g.lineWidth = 1.5; g.beginPath(); g.moveTo(s.cx, s.cy);
      g.lineTo(s.cx + Math.cos(s.a) * s.rad, s.cy + Math.sin(s.a) * s.rad); g.stroke();
      if (Math.random() < dt * 2.2 * cur.o.density) { // a contact lights up where the beam is
        const r = R(0.1, 1) * s.rad;
        s.blips.push({ x: s.cx + Math.cos(s.a) * r, y: s.cy + Math.sin(s.a) * r, life: 1, c: Math.random() < 0.3 ? a2 : a3 });
      }
      g.globalCompositeOperation = 'lighter';
      s.blips = s.blips.filter(b => (b.life -= dt * 0.35) > 0);
      for (const b of s.blips) { glow(b.x, b.y, 16 * k, b.c, 0.35 * b.life * k); g.fillStyle = rgba(b.c, b.life); g.fillRect(b.x - 1.5, b.y - 1.5, 3, 3); }
      g.globalCompositeOperation = 'source-over';
    },
  };

  E.grid = { // 機甲 perspective floor racing to the horizon
    init(s) { s.z = 0; s.sparks = Array.from({ length: count(40000, 6, 40) }, () => ({ x: R(-1, 1), z: R(0, 1), v: R(0.15, 0.4) })); },
    step(s, dt) {
      const { a1, a2, a3 } = cur.col, k = cur.o.glow, hz = H * 0.58, vx = W / 2;
      s.z = (s.z + dt * 0.35) % 1;
      const hg = g.createLinearGradient(0, hz - 80, 0, hz + 40); // horizon glow
      hg.addColorStop(0, rgba(a2, 0)); hg.addColorStop(0.7, rgba(a2, 0.08 * k)); hg.addColorStop(1, rgba(a2, 0));
      g.fillStyle = hg; g.fillRect(0, hz - 80, W, 120);
      g.lineWidth = 1;
      for (let i = 0; i < 16; i++) { // horizontal lines, spaced by perspective
        const z = (i + s.z) / 16, y = hz + (H - hz) * z * z;
        g.strokeStyle = rgba(a1, 0.03 + 0.16 * z * z); g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
      }
      const n = 22;
      for (let i = -n; i <= n; i++) { // rays to the vanishing point
        const xb = vx + i * (W / n) * 1.6;
        g.strokeStyle = rgba(a1, 0.08); g.beginPath(); g.moveTo(vx + i * 6, hz); g.lineTo(xb, H); g.stroke();
      }
      g.globalCompositeOperation = 'lighter';
      for (const p of s.sparks) { // data packets running along the rays
        p.z += p.v * dt; if (p.z > 1) { p.z = 0; p.x = R(-1, 1); }
        const y = hz + (H - hz) * p.z * p.z, x = vx + p.x * W * 0.8 * p.z * p.z + p.x * 6;
        glow(x, y, 10 * p.z * k + 2, a3, 0.5 * p.z * k);
      }
      g.globalCompositeOperation = 'source-over';
      // top half: faint scrolling circuit traces
      g.strokeStyle = rgba(a3, 0.04); g.beginPath();
      for (let x = (t * 12) % 48 - 48; x < W; x += 48) { g.moveTo(x, 0); g.lineTo(x, hz - 90); }
      g.stroke();
    },
  };

  E.petals = { // 桜 falling blossoms
    init(s) { s.p = Array.from({ length: count(16000, 14, 120) }, () => this.spawn({}, true)); },
    spawn(p, any) {
      return Object.assign(p, { x: R(-60, W), y: any ? R(-20, H) : R(-80, -10), s: R(4, 10), vy: R(16, 42), vx: R(8, 28), rot: R(0, 6.28), vr: R(-1.5, 1.5),
        fl: R(0, 6.28), fs: R(1, 3), c: Math.random() < 0.7 ? cur.col.a1 : Math.random() < 0.5 ? cur.col.a3 : cur.col.a2, a: R(0.25, 0.6) });
    },
    step(s, dt) {
      for (const p of s.p) {
        p.fl += dt * p.fs; p.y += p.vy * dt; p.x += (p.vx + Math.sin(p.fl) * 18) * dt; p.rot += p.vr * dt;
        if (p.y > H + 20 || p.x > W + 40) this.spawn(p);
        const sq = Math.abs(Math.cos(p.fl)); // tumble: the petal flattens as it turns
        g.save(); g.translate(p.x, p.y); g.rotate(p.rot); g.scale(1, 0.35 + 0.65 * sq);
        g.fillStyle = rgba(p.c, p.a * cur.o.glow);
        g.beginPath(); g.moveTo(0, -p.s); g.quadraticCurveTo(p.s * 0.9, -p.s * 0.2, 0, p.s); g.quadraticCurveTo(-p.s * 0.9, -p.s * 0.2, 0, -p.s); g.fill();
        g.restore();
      }
    },
  };

  E.stars = { // 月蝕 parallax starfield around an eclipsed moon
    init(s) {
      s.L = [0.25, 0.6, 1].map(z => Array.from({ length: count(5000 / z, 20, 260) | 0 }, () => ({ x: R(0, W), y: R(0, H), z, tw: R(0, 6.28), r: R(0.4, 1.3) * z + 0.3 })));
      s.shoot = null; s.mx = W * 0.8; s.my = H * 0.2; s.mr = Math.min(W, H) * 0.09;
    },
    step(s, dt) {
      const { a1, a2, a3 } = cur.col, k = cur.o.glow;
      for (const layer of s.L) for (const p of layer) {
        p.x -= p.z * 6 * dt; if (p.x < -2) { p.x = W + 2; p.y = R(0, H); }
        p.tw += dt * (1 + p.z * 2);
        g.fillStyle = rgba(p.z === 1 ? a1 : p.z > 0.5 ? a3 : [220, 225, 255], (0.35 + 0.35 * Math.sin(p.tw)) * (0.4 + p.z * 0.6));
        g.fillRect(p.x, p.y, p.r, p.r);
      }
      const pulse = 1 + 0.06 * Math.sin(t * 0.6); // corona
      g.globalCompositeOperation = 'lighter';
      glow(s.mx, s.my, s.mr * 2.6 * pulse, a1, 0.16 * k); glow(s.mx, s.my, s.mr * 1.5, a2, 0.12 * k);
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = rgba(rgb(getVar('--bg')), 1); g.beginPath(); g.arc(s.mx, s.my, s.mr, 0, 7); g.fill();
      g.strokeStyle = rgba(a2, 0.5 * k); g.lineWidth = 1.2; g.beginPath(); g.arc(s.mx, s.my, s.mr, 0, 7); g.stroke();
      if (!s.shoot && Math.random() < dt * 0.12) s.shoot = { x: R(W * 0.2, W), y: R(0, H * 0.4), life: 1 };
      if (s.shoot) {
        const q = s.shoot; q.x -= 520 * dt; q.y += 200 * dt; q.life -= dt * 1.3;
        const gr = g.createLinearGradient(q.x, q.y, q.x + 90, q.y - 35); gr.addColorStop(0, rgba(a1, 0.8 * q.life)); gr.addColorStop(1, rgba(a1, 0));
        g.strokeStyle = gr; g.lineWidth = 1.5; g.beginPath(); g.moveTo(q.x, q.y); g.lineTo(q.x + 90, q.y - 35); g.stroke();
        if (q.life <= 0) s.shoot = null;
      }
    },
  };

  const KANA = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン竜核紅零壱弐参01'.split('');
  E.rain = { // 紅 katakana code rain
    init(s) {
      s.fs = COARSE ? 13 : 15; s.cols = Math.ceil(W / (s.fs * 1.25));
      s.d = Array.from({ length: s.cols }, (_, i) => this.spawn({ i }, true)).filter(() => Math.random() < Math.min(1, 0.55 * cur.o.density));
    },
    spawn(d, any) {
      return Object.assign(d, { y: any ? R(-H, H) : R(-H * 0.5, -20), v: R(70, 190), len: (R(8, 26)) | 0, ch: Array.from({ length: 30 }, () => pick(KANA)), sw: 0 });
    },
    step(s, dt) {
      const { a1, a2 } = cur.col, k = cur.o.glow, step = s.fs * 1.15;
      g.font = `${s.fs}px "Share Tech Mono", "Noto Sans JP", monospace`; g.textAlign = 'center';
      for (const d of s.d) {
        d.y += d.v * dt; d.sw += dt;
        if (d.sw > 0.12) { d.sw = 0; d.ch[(Math.random() * d.ch.length) | 0] = pick(KANA); }
        if (d.y - d.len * step > H) this.spawn(d);
        const x = d.i * s.fs * 1.25 + s.fs / 2;
        for (let j = 0; j < d.len; j++) {
          const y = d.y - j * step; if (y < -step || y > H + step) continue;
          const f = 1 - j / d.len;
          g.fillStyle = j === 0 ? rgba(a2, 0.95 * k) : rgba(a1, (0.12 + 0.55 * f * f) * k);
          g.fillText(d.ch[j % d.ch.length], x, y);
        }
      }
    },
  };

  E.bubbles = { // 深海 rising bubbles, plankton and light shafts
    init(s) {
      s.b = Array.from({ length: count(26000, 10, 90) }, () => this.spawn({}, true));
      s.pk = Array.from({ length: count(9000, 16, 160) }, () => ({ x: R(0, W), y: R(0, H), ph: R(0, 6.28), v: R(2, 8), c: Math.random() < 0.6 ? cur.col.a2 : cur.col.a1 }));
    },
    spawn(b, any) { return Object.assign(b, { x: R(0, W), y: any ? R(0, H) : H + R(10, 80), r: R(1.5, 7), v: R(18, 60), ph: R(0, 6.28) }); },
    step(s, dt) {
      const { a1, a2, a3 } = cur.col, k = cur.o.glow;
      for (let i = 0; i < 4; i++) { // god rays from the surface, swaying
        const x = W * (0.15 + i * 0.25) + Math.sin(t * 0.25 + i * 1.7) * W * 0.06, wd = W * 0.09;
        const gr = g.createLinearGradient(0, 0, 0, H * 0.9); gr.addColorStop(0, rgba(a1, 0.07 * k)); gr.addColorStop(1, rgba(a1, 0));
        g.fillStyle = gr; g.beginPath(); g.moveTo(x - wd * 0.3, 0); g.lineTo(x + wd * 0.3, 0); g.lineTo(x + wd * 1.4, H * 0.9); g.lineTo(x - wd * 0.6, H * 0.9); g.fill();
      }
      g.globalCompositeOperation = 'lighter';
      for (const p of s.pk) {
        p.ph += dt * 0.8; p.y -= p.v * dt * 0.3; p.x += Math.sin(p.ph) * 4 * dt; if (p.y < -5) { p.y = H + 5; p.x = R(0, W); }
        glow(p.x, p.y, 5 * k, p.c, (0.25 + 0.25 * Math.sin(p.ph * 2.3)) * k);
      }
      g.globalCompositeOperation = 'source-over';
      g.lineWidth = 1;
      for (const b of s.b) {
        b.y -= b.v * dt; b.ph += dt * 3; b.x += Math.sin(b.ph) * 10 * dt; if (b.y < -10) this.spawn(b);
        g.strokeStyle = rgba(a3, 0.35); g.beginPath(); g.arc(b.x, b.y, b.r, 0, 7); g.stroke();
        g.fillStyle = rgba(a1, 0.5); g.fillRect(b.x - b.r * 0.45, b.y - b.r * 0.45, 1.2, 1.2);
      }
    },
  };

  E.dust = { // 黄金 drifting gold motes and slanted light
    init(s) { s.p = Array.from({ length: count(7000, 20, 220) }, () => ({ x: R(0, W), y: R(0, H), vx: R(-6, 6), vy: R(-10, -2), r: R(0.5, 2.2), ph: R(0, 6.28), star: Math.random() < 0.08 })); },
    step(s, dt) {
      const { a1, a2, a3 } = cur.col, k = cur.o.glow;
      for (let i = 0; i < 3; i++) { // light beams
        const x0 = W * (0.1 + i * 0.32) + Math.sin(t * 0.15 + i) * 40;
        const gr = g.createLinearGradient(x0, 0, x0 + W * 0.3, H); gr.addColorStop(0, rgba(a2, 0.05 * k)); gr.addColorStop(1, rgba(a2, 0));
        g.fillStyle = gr; g.beginPath(); g.moveTo(x0, 0); g.lineTo(x0 + 90, 0); g.lineTo(x0 + W * 0.35 + 140, H); g.lineTo(x0 + W * 0.3, H); g.fill();
      }
      g.globalCompositeOperation = 'lighter';
      for (const p of s.p) {
        p.ph += dt * 1.7; p.x += (p.vx + Math.sin(p.ph * 0.5) * 4) * dt; p.y += p.vy * dt;
        if (p.y < -5) { p.y = H + 5; p.x = R(0, W); } if (p.x < -5) p.x = W + 5; if (p.x > W + 5) p.x = -5;
        const tw = 0.45 + 0.55 * Math.abs(Math.sin(p.ph)), c = p.star ? a2 : p.r > 1.6 ? a1 : a3;
        glow(p.x, p.y, p.r * 6 * k, c, 0.22 * tw * k);
        if (p.star && tw > 0.8) { // four-point glint
          g.strokeStyle = rgba(a2, (tw - 0.8) * 4 * k); g.lineWidth = 1; g.beginPath();
          g.moveTo(p.x - 7, p.y); g.lineTo(p.x + 7, p.y); g.moveTo(p.x, p.y - 7); g.lineTo(p.x, p.y + 7); g.stroke();
        }
      }
      g.globalCompositeOperation = 'source-over';
    },
  };

  E.fog = { // 幽霊 slow drifting mist and wisps
    init(s) {
      s.b = Array.from({ length: Math.round(9 * Math.min(2, cur.o.density)) + 3 }, (_, i) => ({ x: R(0, W), y: R(0, H), r: R(0.25, 0.5) * Math.max(W, H), vx: R(-10, 10), vy: R(-5, 5), ph: R(0, 6.28), c: [cur.col.a1, cur.col.a2, cur.col.a3][i % 3] }));
      s.w = Array.from({ length: count(30000, 6, 60) }, () => ({ x: R(0, W), y: R(0, H), v: R(4, 14), ph: R(0, 6.28), life: R(0, 1) }));
    },
    step(s, dt) {
      const k = cur.o.glow;
      for (const b of s.b) {
        b.x += b.vx * dt; b.y += b.vy * dt; b.ph += dt * 0.2;
        if (b.x < -b.r) b.x = W + b.r; if (b.x > W + b.r) b.x = -b.r; if (b.y < -b.r) b.y = H + b.r; if (b.y > H + b.r) b.y = -b.r;
        glow(b.x, b.y, b.r * (0.9 + 0.1 * Math.sin(b.ph)), b.c, 0.045 * k * (0.7 + 0.3 * Math.sin(b.ph * 1.3)));
      }
      for (const p of s.w) { // wisps: short rising streaks that fade in and out
        p.life += dt * 0.25; p.y -= p.v * dt; p.ph += dt; if (p.life > 1 || p.y < -20) Object.assign(p, { x: R(0, W), y: R(H * 0.3, H), life: 0 });
        const a = Math.sin(p.life * Math.PI) * 0.22 * k, x = p.x + Math.sin(p.ph) * 8;
        g.strokeStyle = rgba(cur.col.a1, a); g.lineWidth = 1; g.beginPath(); g.moveTo(x, p.y); g.quadraticCurveTo(x + 6, p.y - 12, x, p.y - 24); g.stroke();
      }
    },
  };

  E.plexus = { // network of drifting nodes linked when close
    init(s) { s.p = Array.from({ length: Math.min(110, count(14000, 20, 110)) }, () => ({ x: R(0, W), y: R(0, H), vx: R(-14, 14), vy: R(-14, 14) })); s.d = Math.min(170, Math.max(110, Math.min(W, H) * 0.16)); },
    step(s, dt) {
      const { a1, a2 } = cur.col, k = cur.o.glow, D = s.d, ps = s.p;
      for (const p of ps) { p.x += p.vx * dt; p.y += p.vy * dt; if (p.x < 0 || p.x > W) p.vx *= -1; if (p.y < 0 || p.y > H) p.vy *= -1; }
      g.lineWidth = 1;
      for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
        const dx = ps[i].x - ps[j].x, dy = ps[i].y - ps[j].y, d2 = dx * dx + dy * dy;
        if (d2 < D * D) { g.strokeStyle = rgba(a1, (1 - Math.sqrt(d2) / D) * 0.18 * k); g.beginPath(); g.moveTo(ps[i].x, ps[i].y); g.lineTo(ps[j].x, ps[j].y); g.stroke(); }
      }
      for (let i = 0; i < ps.length; i++) { const c = i % 7 === 0 ? a2 : a1; g.fillStyle = rgba(c, 0.6); g.fillRect(ps[i].x - 1.2, ps[i].y - 1.2, 2.4, 2.4); }
    },
  };

  E.waves = { // flowing signal waves along the bottom
    init(s) { s.n = Math.round(5 * Math.min(2, cur.o.density)) + 2; },
    step(s, dt) {
      const cols = [cur.col.a1, cur.col.a2, cur.col.a3], k = cur.o.glow;
      g.lineWidth = 1.2;
      for (let i = 0; i < s.n; i++) {
        const base = H * (0.62 + i * 0.05), amp = 18 + i * 9, f = 0.004 + i * 0.0009, sp = 0.6 + i * 0.25;
        g.strokeStyle = rgba(cols[i % 3], (0.16 - i * 0.012) * k); g.beginPath();
        for (let x = 0; x <= W; x += 8) {
          const y = base + Math.sin(x * f + t * sp + i) * amp + Math.sin(x * f * 2.3 - t * sp * 0.7) * amp * 0.35;
          x ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.stroke();
      }
    },
  };

  E.none = { init() {}, step() {} };

  /* ── engine ── */
  const getVar = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, COARSE ? 1 : 1.5);
    W = innerWidth; H = innerHeight;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    restart();
  }
  function restart() {
    cur.st = {}; t = 0;
    if (cur.eff && W) cur.eff.init(cur.st);
    frame(performance.now(), true);
  }
  function frame(now, force = false) {
    raf = 0;
    if (!on || !cur.eff || cur.name === 'none') { g.clearRect(0, 0, W, H); return; }
    const dt = force ? 0 : Math.min(0.1, (now - last) / 1000);
    if (!force && dt < 1 / FPS - 0.002) { raf = requestAnimationFrame(frame); return; }
    last = now;
    const sdt = dt * cur.o.speed;
    t += sdt;
    g.clearRect(0, 0, W, H);
    if (force && REDUCED.matches) for (let i = 0; i < 40; i++) { t += 0.05; cur.eff.step(cur.st, 0.05); g.clearRect(0, 0, W, H); } // settle, then one still frame
    cur.eff.step(cur.st, sdt);
    if (!REDUCED.matches && !document.hidden) raf = requestAnimationFrame(frame);
  }
  const kick = () => { if (!raf && on && !REDUCED.matches && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(frame); } };
  document.addEventListener('visibilitychange', kick);
  REDUCED.addEventListener?.('change', restart);
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(resize, 150); });

  /** Switch effect and colours. colors: {a1,a2,a3} as hex/rgb strings; opts: {density, speed, glow}. */
  function set(name, colors, opts = {}) {
    if (!E[name]) name = 'none';
    cur.name = name; cur.eff = E[name];
    cur.col = { a1: rgb(colors.a1), a2: rgb(colors.a2), a3: rgb(colors.a3) };
    cur.o = { density: +opts.density || 1, speed: +opts.speed || 1, glow: opts.glow == null ? 1 : +opts.glow };
    cv.dataset.fx = name;
    if (raf) cancelAnimationFrame(raf), raf = 0;
    if (!W) resize(); else restart();
  }
  function enable(v) { on = !!v; cv.hidden = !on; if (raf) cancelAnimationFrame(raf), raf = 0; restart(); }

  const THEME_FX = { hearth: 'embers', redline: 'radar', mecha: 'grid', sakura: 'petals', eclipse: 'stars', kurenai: 'rain', abyss: 'bubbles', aurum: 'dust', specter: 'fog' };
  const describe = { embers: 'EMBERS 火の粉', radar: 'RADAR 探知', grid: 'GRID 格子', petals: 'PETALS 花びら', stars: 'STARS 星空', rain: 'CODE RAIN 符号雨',
    bubbles: 'DEEP 泡', dust: 'GOLD DUST 金粉', fog: 'MIST 霧', plexus: 'NETWORK 網', waves: 'WAVES 波', none: 'NONE 無' };
  return { set, enable, list: Object.keys(describe), describe, themeDefault: id => THEME_FX[id] || 'plexus' };
})();
