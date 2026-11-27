/* RyuCore shared UI helpers: themes, modal, toasts, API calls, boot sequence (same HUD language as HEARTH). */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const QS = new URLSearchParams(location.search);
/* Two apps, one codebase: RyuCore at / and Companion 伴侶 at /companion/ (its own data on the server too). */
const REALM = /\/companion\/(?:[^/]*)$/.test(location.pathname) ? 'companion' : 'core';
const COMP = REALM === 'companion';
const REALM_KEYS = new Set(['chat']);  // per-app keys; looks (theme, effects, boot intro) are shared
const skey = k => 'ryucore.' + (COMP && REALM_KEYS.has(k) ? 'companion.' : '') + k;
const store = {
  get(k) { try { return localStorage.getItem(skey(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(skey(k), v); } catch { /* private mode */ } },
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function setText(el, t) { if (el && el.textContent !== t) el.textContent = t; }
function html(str) { const t = document.createElement('template'); t.innerHTML = str.trim(); return t.content.firstElementChild; }
const ago = s => (s == null ? '—' : s < 60 ? 'now' : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`);
const since = t => (t ? ago(Math.max(0, Math.round(Date.now() / 1000 - t))) : '—');
const hm = t => { const d = new Date(t * 1000); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/* ───────── themes (the nine HEARTH palettes, plus any a linked HEARTH hub serves) ───────── */
const THEMES = [
  ['hearth', 'HEARTH', '炉心'], ['redline', 'REDLINE', '赤警報'], ['mecha', 'MECHA', '機甲'], ['sakura', 'SAKURA', '桜'],
  ['eclipse', 'ECLIPSE', '月蝕'], ['kurenai', 'KURENAI', '紅'], ['abyss', 'ABYSS', '深海'], ['aurum', 'AURUM', '黄金'],
  ['specter', 'SPECTER', '幽霊'],
].map(([id, name, jp]) => ({ id, name, jp }));
const themeCols = {};
(function measure() {
  const root = document.documentElement, prev = root.dataset.theme;
  for (const t of THEMES) {
    if (t.id === 'hearth') delete root.dataset.theme; else root.dataset.theme = t.id;
    const cs = getComputedStyle(root);
    themeCols[t.id] = ['--a1', '--a2', '--a3'].map(v => cs.getPropertyValue(v).trim());
  }
  if (prev) root.dataset.theme = prev; else delete root.dataset.theme;
})();
/** Called with the theme id when the user picks one (not when it's synced from the hub). */
const themeHooks = [];
let hubPalettes = [], customThemes = [];
try { hubPalettes = JSON.parse(store.get('palettes') || '[]') || []; } catch { /* stale */ }
try { customThemes = JSON.parse(store.get('customThemes') || '[]') || []; } catch { /* stale */ }
const isCustom = id => String(id || '').startsWith('x-');
const swatch = id => `<span class="sw">${(themeCols[id] || []).map(c => `<i style="background:${esc(c)}"></i>`).join('')}</span>`;
const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(', ');
/** The hub's colours as inline variables (they win over the stylesheet), or none without a hub. */
function paintPalette(id) {
  paintColours(customThemes.find(x => x.id === id) || hubPalettes.find(x => x.id === id));
}
/** Paint a palette {a1,a2,a3,surface,panel,bg,bg2,text,dim,faint} as inline variables, or clear them (p = null). */
function paintColours(p) {
  const st = document.documentElement.style;
  const plain = ['bg', 'bg2', 'text', 'dim', 'faint'];
  if (!p) {
    for (const v of ['a1', 'a2', 'a3']) { st.removeProperty(`--${v}`); st.removeProperty(`--${v}-rgb`); }
    for (const v of ['s-rgb', 'panel', ...plain]) st.removeProperty(`--${v}`);
    return;
  }
  for (const v of ['a1', 'a2', 'a3']) { st.setProperty(`--${v}`, p[v]); st.setProperty(`--${v}-rgb`, hexRgb(p[v])); }
  st.setProperty('--s-rgb', hexRgb(p.surface));
  st.setProperty('--panel', `rgba(${hexRgb(p.panel)}, 0.9)`);
  for (const v of plain) st.setProperty(`--${v}`, p[v]);
}
function renderThemeLists() {
  const menu = $('#themeMenu'), grid = $('#themeGrid');
  const mark = t => (isCustom(t.id) ? '<i class="cust" title="Your theme">✦</i>' : '');
  if (menu) menu.innerHTML = THEMES.map(t => `<button type="button" data-t="${esc(t.id)}">${swatch(t.id)}${esc(t.name)}${mark(t)}<em>${esc(t.jp)}</em></button>`).join('')
    + '<button type="button" class="forge-btn" data-forge>✦ THEME FORGE<em>配色工房</em></button>';
  if (grid) grid.innerHTML = THEMES.map(t => `<button type="button" data-t="${esc(t.id)}">${swatch(t.id)}<span>${esc(t.name)} ${esc(t.jp)}${mark(t)}</span></button>`).join('');
  const cur = document.documentElement.dataset.theme || 'hearth';
  $$('[data-t]').forEach(b => b.classList.toggle('on', b.dataset.t === cur));
}
/** Palettes from a linked HEARTH hub: custom ones join the menu, changed colours override the CSS. */
function setPalettes(list) {
  hubPalettes = Array.isArray(list) ? list : [];
  store.set('palettes', JSON.stringify(hubPalettes));
  for (const p of hubPalettes) {
    if (!THEMES.some(t => t.id === p.id)) THEMES.push({ id: p.id, name: p.name, jp: p.jp || '' });
    themeCols[p.id] = [p.a1, p.a2, p.a3];
  }
  renderThemeLists();
}
/** The user's own themes (THEME FORGE), from the server's settings; cached so the first paint already has them. */
function setCustomThemes(list) {
  customThemes = Array.isArray(list) ? list : [];
  store.set('customThemes', JSON.stringify(customThemes));
  for (let i = THEMES.length - 1; i >= 0; i--) if (isCustom(THEMES[i].id) && !customThemes.some(c => c.id === THEMES[i].id)) THEMES.splice(i, 1);
  for (const c of customThemes) {
    const t = THEMES.find(x => x.id === c.id);
    if (t) Object.assign(t, { name: c.name, jp: c.jp || '' }); else THEMES.push({ id: c.id, name: c.name, jp: c.jp || '' });
    themeCols[c.id] = [c.a1, c.a2, c.a3];
  }
  renderThemeLists();
  const cur = document.documentElement.dataset.theme || 'hearth';
  if (isCustom(cur)) applyTheme(customThemes.some(c => c.id === cur) ? cur : 'hearth');
}

/* ───────── animated background (fx.js): on/off and effect override are per browser ───────── */
const bgfx = {
  on: () => store.get('fx') !== '0',
  override: () => store.get('fxOverride') || '',
  /** effect + options for a theme id: custom themes carry their own, built-ins have a default each */
  of(id) {
    const c = customThemes.find(x => x.id === id);
    if (c) return { fx: c.fx || 'plexus', density: c.density ?? 1, speed: c.speed ?? 1, glow: c.glow ?? 1 };
    return { fx: FX.themeDefault(id), density: +(store.get('fxDensity') || 1), speed: +(store.get('fxSpeed') || 1), glow: 1 };
  },
  apply(id = document.documentElement.dataset.theme || 'hearth', preview = null) {
    if (typeof FX === 'undefined') return;
    FX.enable(this.on());
    const cs = getComputedStyle(document.documentElement), o = preview || this.of(id);
    const fx = !preview && this.override() && !isCustom(id) ? this.override() : o.fx;
    FX.set(fx, { a1: cs.getPropertyValue('--a1'), a2: cs.getPropertyValue('--a2'), a3: cs.getPropertyValue('--a3') }, o);
  },
};

function applyTheme(id, user = false) {
  const t = THEMES.find(x => x.id === id) || THEMES[0];
  if (t.id === 'hearth') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t.id;
  paintPalette(t.id);
  store.set('theme', t.id);
  setText($('#themeName'), t.name);
  $$('[data-t]').forEach(b => b.classList.toggle('on', b.dataset.t === t.id));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  bgfx.apply(t.id);
  if (user) themeHooks.forEach(f => f(t.id));
}
function cycleTheme(dir = 1) {
  const cur = document.documentElement.dataset.theme || 'hearth', i = THEMES.findIndex(t => t.id === cur);
  const t = THEMES[(i + dir + THEMES.length) % THEMES.length];
  applyTheme(t.id, true); toast(`THEME // ${t.name} ${t.jp}`);
}
(function buildThemeMenu() {
  for (const p of hubPalettes) {
    if (!THEMES.some(t => t.id === p.id)) THEMES.push({ id: p.id, name: p.name, jp: p.jp || '' });
    themeCols[p.id] = [p.a1, p.a2, p.a3];
  }
  for (const c of customThemes) {
    if (!THEMES.some(t => t.id === c.id)) THEMES.push({ id: c.id, name: c.name, jp: c.jp || '' });
    themeCols[c.id] = [c.a1, c.a2, c.a3];
  }
  renderThemeLists();
  const menu = $('#themeMenu'), btn = $('#themeBtn');
  if (menu && btn) {
    const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.addEventListener('click', e => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden)); });
    menu.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      close();
      if (b.dataset.forge != null) { if (typeof openForge === 'function') openForge(); return; }
      applyTheme(b.dataset.t, true);
    });
    document.addEventListener('click', close);
  }
  $('#themeGrid')?.addEventListener('click', e => { const b = e.target.closest('button'); if (b) applyTheme(b.dataset.t, true); });
  applyTheme(QS.get('theme') || store.get('theme') || 'hearth');
})();

/* ───────── modal / toast ───────── */
const modal = {
  onclose: null, opener: null,
  open(title, body, cls = '') {
    if (!$('#modal').hidden) this.close();
    this.opener = document.activeElement;
    setText($('#modalTitle'), title);
    const b = $('#modalBody'); b.innerHTML = '';
    if (typeof body === 'string') b.innerHTML = body; else if (body) b.append(body);
    $('#modal').className = 'modal ' + cls; $('#modal').hidden = false;
    (b.querySelector('[autofocus]') || $('#modalClose')).focus();
    return b;
  },
  close() {
    if ($('#modal').hidden) return false;
    $('#modal').hidden = true;
    const fn = this.onclose; this.onclose = null; if (fn) fn();
    if (this.opener && document.contains(this.opener)) this.opener.focus({ preventScroll: true });
    return true;
  },
};
if ($('#modal')) {
  $('#modalClose').addEventListener('click', () => modal.close());
  $('#modal').addEventListener('mousedown', e => { if (e.target.id === 'modal') modal.close(); });
}
function toast(msg, lvl = '') {
  const t = html(`<div class="toast ${lvl}"></div>`); t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.classList.add('out'), 4200); setTimeout(() => t.remove(), 4800);
}
function confirmBox(text, okLabel = 'CONFIRM', danger = true) {
  return new Promise(res => {
    const b = html(`<div class="confirm"><p></p><div class="row"><button class="tgl" type="button" data-no>CANCEL</button><button class="tgl ${danger ? 'danger' : 'on'}" type="button" data-ok>${esc(okLabel)}</button></div></div>`);
    b.querySelector('p').textContent = text;
    let done = false;
    modal.open('CONFIRM // 確認', b, 'sm');
    modal.onclose = () => { if (!done) res(false); };
    b.querySelector('[data-no]').onclick = () => modal.close();
    b.querySelector('[data-ok]').onclick = () => { done = true; modal.close(); res(true); };
    b.querySelector('[data-ok]').focus();
  });
}

/* ───────── API ───────── */
async function api(method, path, body) {
  const opt = { method, headers: { 'X-Ryu': '1' } };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(path, opt);
  if (r.status === 401 && !location.pathname.endsWith('login.html')) { location.href = 'login.html'; throw new Error('login required'); }
  let j = null; try { j = await r.json(); } catch { /* no body */ }
  if (!r.ok) throw new Error((j && (typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail))) || `HTTP ${r.status}`);
  return j;
}
const GET = p => api('GET', p);
const POST = (p, b = {}) => api('POST', p, b);

/* read a fetch() response body as server-sent events */
async function* sseRead(resp) {
  const reader = resp.body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
      if (data) { try { yield JSON.parse(data); } catch { /* partial / keep-alive */ } }
    }
  }
}

function download(name, text, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function readFile(file, as = 'text') {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result); r.onerror = () => rej(r.error);
    if (as === 'dataurl') r.readAsDataURL(file); else if (as === 'buffer') r.readAsArrayBuffer(file); else r.readAsText(file);
  });
}
function b64(buf) {
  let s = ''; const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}

/* ───────── boot sequence (HEARTH intro, honours the "Boot intro" setting) ───────── */
function bootSeq(lines) {
  const root = $('#boot'), el = $('#bootLog'), bar = $('#bootBar');
  const st = { start: performance.now(), lines: false, data: false, done: false };
  const finish = (now = false) => { if (st.done) return; st.done = true; setTimeout(() => root.classList.add('done'), now ? 0 : 250); };
  if (!root) return () => {};
  if (QS.get('boot') === '0' || (QS.get('boot') !== '1' && store.get('boot') === '0')) { st.done = true; root.hidden = true; return () => {}; }
  const check = () => { if (!st.done && ((st.lines && st.data) || performance.now() - st.start > 5000)) finish(); };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.innerHTML = lines.join('\n'); bar.style.width = '100%'; st.lines = true;
  } else {
    let i = 0;
    const step = () => {
      el.innerHTML = lines.slice(0, ++i).join('\n');
      bar.style.width = (i / lines.length * 100) + '%';
      if (i < lines.length) setTimeout(step, 110 + Math.random() * 100); else { st.lines = true; check(); }
    };
    step();
  }
  const timer = setInterval(() => { check(); if (st.done) clearInterval(timer); }, 200);
  root.addEventListener('click', () => finish(true));
  return () => { st.data = true; check(); };
}
