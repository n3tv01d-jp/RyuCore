/* RyuCore 竜核 — main UI. Depends on md.js (MD) and ui.js (helpers). */
'use strict';

/* touch screens: don't summon the on-screen keyboard unless the user tapped a text field */
const TOUCH = matchMedia('(pointer: coarse)');

const S = {
  view: 'chat', info: {}, settings: {}, models: [], modelStatus: {}, providers: [], chats: [],
  chat: null, msgs: [], live: null, streaming: null, attach: [], skillChips: [], skills: [],
  openFolds: new Set(), feed: [], mcp: [], brainCount: 0, sessQ: '',
};
const VIEWS = ['chat', 'brain', 'skills', 'mcp', 'models', 'system'];

/* ═════════════ helpers ═════════════ */
const modelInfo = id => S.models.find(m => m.id === id);
function modelName(id) {
  if (!id) return '';
  const m = modelInfo(id);
  return m ? m.name : id.split('::').slice(1).join('::') || id;
}
function modelTag(id) {
  const m = modelInfo(id);
  if (m) return m.local ? '<span class="lc local">LOCAL</span>' : '<span class="lc cloud">CLOUD</span>';
  const p = S.providers.find(x => x.id === (id || '').split('::')[0]);
  return p ? (p.local ? '<span class="lc local">LOCAL</span>' : '<span class="lc cloud">CLOUD</span>') : '';
}
function setModelBtn(btn, id, noneLabel = 'SELECT MODEL') {
  btn.innerHTML = id ? `${modelTag(id)}<span class="mb-name" title="${esc(id)}">${esc(modelName(id))}</span>`
    : `<span class="mb-name mb-none">${esc(noneLabel)}</span>`;
}
function fold(key, cls, summary, inner, openDefault = false) {
  const open = S.openFolds.has(key) || (openDefault && !S.openFolds.has('!' + key));
  return `<details class="fold ${cls}" data-fold="${esc(key)}"${open ? ' open' : ''}><summary>${summary}</summary><div class="in">${inner}</div></details>`;
}
document.addEventListener('toggle', e => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.dataset.fold) return;
  const k = d.dataset.fold;
  if (d.open) { S.openFolds.add(k); S.openFolds.delete('!' + k); } else { S.openFolds.delete(k); S.openFolds.add('!' + k); }
}, true);
const nearBottom = el => el.scrollHeight - el.scrollTop - el.clientHeight < 120;
const copyText = async t => { try { await navigator.clipboard.writeText(t); toast('COPIED // 複写', 'ok'); } catch { toast('Clipboard unavailable', 'warn'); } };

/* ═════════════ popover (model picker, slash menu) ═════════════ */
const pop = {
  el: $('#pop'), anchor: null, onkey: null,
  open(anchor, content, { width } = {}) {
    this.close();
    this.anchor = anchor;
    this.el.innerHTML = ''; this.el.append(content);
    this.el.hidden = false;
    const r = anchor.getBoundingClientRect(), w = Math.max(width || 300, r.width);
    this.el.style.width = Math.min(w, innerWidth - 24) + 'px';
    let left = Math.min(r.left, innerWidth - Math.min(w, innerWidth - 24) - 12);
    this.el.style.left = Math.max(12, left) + 'px';
    this.el.style.maxHeight = '';
    const below = innerHeight - r.bottom, ph = this.el.offsetHeight, up = below < ph + 12 && r.top > below;
    if (up) { this.el.style.top = ''; this.el.style.bottom = (innerHeight - r.top + 6) + 'px'; }
    else { this.el.style.bottom = ''; this.el.style.top = (r.bottom + 6) + 'px'; }
    this.el.style.maxHeight = Math.max(160, Math.min(520, (up ? r.top : below) - 18)) + 'px';
    anchor.setAttribute?.('aria-expanded', 'true');
  },
  close() {
    if (this.el.hidden) return false;
    this.el.hidden = true; this.anchor?.setAttribute?.('aria-expanded', 'false'); this.anchor = null; this.onkey = null;
    return true;
  },
};
document.addEventListener('mousedown', e => { if (!pop.el.hidden && !pop.el.contains(e.target) && !pop.anchor?.contains(e.target)) pop.close(); });

function openModelPicker(anchor, current, onPick, { none = null, filter = null } = {}) {
  const box = html(`<div style="display:contents"><input type="search" placeholder="FILTER MODELS…" aria-label="Filter models"><div class="pl" role="listbox"></div></div>`);
  const input = box.querySelector('input'), list = box.querySelector('.pl');
  let sel = 0, items = [];
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const ms = S.models.filter(m => (!filter || filter(m)) && (!q || (m.name + ' ' + m.provider_name).toLowerCase().includes(q)));
    const groups = new Map();
    for (const m of ms) { if (!groups.has(m.provider)) groups.set(m.provider, []); groups.get(m.provider).push(m); }
    let h = none ? `<button type="button" class="pi${!current ? ' on' : ''}" data-id=""><span>${esc(none)}</span></button>` : '';
    for (const p of S.providers.filter(p => p.enabled)) {
      const g = groups.get(p.id) || [], st = S.modelStatus[p.id] || {};
      if (!g.length && q) continue;
      h += `<h5>${esc(p.name)} ${p.local ? '<span class="lc local">LOCAL</span>' : '<span class="lc cloud">CLOUD</span>'}<small>${g.length}</small></h5>`;
      if (st.error && !g.length) h += `<div class="perr">⚠ ${esc(st.error)}</div>`;
      h += g.map(m => `<button type="button" class="pi${m.id === current ? ' on' : ''}" data-id="${esc(m.id)}" title="${esc(m.id)}"><span>${esc(m.name)}</span></button>`).join('');
    }
    if (!S.providers.length) h += `<div class="pempty">No providers yet. Open <b>MODELS 演算</b> and add Ollama, vLLM, llama.cpp, OpenAI, Anthropic, Grok…</div>`;
    else if (!ms.length && q) h += `<div class="pempty">No model matches “${esc(q)}”.</div>`;
    h += `<div style="padding:6px 4px 0;display:flex;gap:6px"><button type="button" class="tgl sm" data-rescan>↻ RESCAN</button><button type="button" class="tgl sm" data-manage>MANAGE</button></div>`;
    list.innerHTML = h;
    items = $$('.pi', list);
    sel = Math.max(0, items.findIndex(b => b.classList.contains('on')));
    mark();
  };
  const mark = () => { items.forEach((b, i) => b.classList.toggle('sel', i === sel)); items[sel]?.scrollIntoView({ block: 'nearest' }); };
  list.addEventListener('click', async e => {
    if (e.target.closest('[data-rescan]')) { await loadModels(true); draw(); return; }
    if (e.target.closest('[data-manage]')) { pop.close(); showView('models'); return; }
    const b = e.target.closest('.pi'); if (!b) return;
    pop.close(); onPick(b.dataset.id);
  });
  input.addEventListener('input', () => { draw(); sel = items.length && items[0].dataset.id === '' && input.value ? 1 : 0; mark(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); mark(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); mark(); e.preventDefault(); }
    else if (e.key === 'Enter') { e.preventDefault(); items[sel]?.click(); }
    else if (e.key === 'Escape') { pop.close(); anchor.focus(); }
  });
  draw();
  pop.open(anchor, box, { width: 360 });
  if (!TOUCH.matches) input.focus();
}

/* ═════════════ data loading ═════════════ */
async function loadModels(refresh = false) {
  try {
    const [r, p] = await Promise.all([GET('api/models' + (refresh ? '?refresh=1' : '')), GET('api/providers')]);
    S.models = r.models; S.modelStatus = r.status; S.providers = p;
    if (refresh) {
      const bad = Object.entries(r.status).filter(([, s]) => s.error);
      toast(`SCAN // ${r.models.length} models${bad.length ? ` · ${bad.length} provider${bad.length > 1 ? 's' : ''} unreachable` : ''}`, bad.length ? 'warn' : 'ok');
    }
  } catch (e) { toast('Model scan failed: ' + e.message, 'crit'); }
  renderChatBar();
  if (S.view === 'models') renderProviders();
  if (S.view === 'brain') renderBrainSettings();
}
async function loadChats() {
  try { S.chats = await GET('api/chats' + (S.sessQ ? '?q=' + encodeURIComponent(S.sessQ) : '')); } catch (e) { toast(e.message, 'crit'); }
  renderSessions();
}
async function loadSettings() { S.settings = await GET('api/settings'); }

/* ═════════════ sessions ═════════════ */
function renderSessions() {
  const list = $('#sessList');
  const day = 86400, now = Date.now() / 1000, today = new Date(); today.setHours(0, 0, 0, 0);
  const t0 = today.getTime() / 1000;
  const bucket = c => (c.pinned ? 'PINNED 固定' : c.updated >= t0 ? 'TODAY 本日' : c.updated >= t0 - day ? 'YESTERDAY 昨日' : c.updated >= now - 7 * day ? 'THIS WEEK 今週' : 'EARLIER 以前');
  let h = '', last = '';
  for (const c of S.chats) {
    const b = bucket(c);
    if (b !== last) { h += `<h6>${b}</h6>`; last = b; }
    const badges = [c.pinned ? '<span class="bdg b-pin">PIN</span>' : '', c.council ? '<span class="bdg b-council">COUNCIL</span>' : '',
      c.agent ? '<span class="bdg b-agent">AGENT</span>' : '', !c.brain ? '<span class="bdg b-ghost">GHOST</span>' : ''].join('');
    h += `<li class="si${S.chat?.id === c.id ? ' on' : ''}" data-id="${c.id}" tabindex="0">
      <span class="si-t">${esc(c.title || 'Untitled')}</span>
      <span class="si-m">${badges}<span>${since(c.updated)}</span><span>${esc(c.council ? '' : modelName(c.model))}</span></span>
      <span class="si-x"><button type="button" data-act="pin" title="${c.pinned ? 'Unpin' : 'Pin'}">${c.pinned ? '★' : '☆'}</button><button type="button" class="del" data-act="del" title="Delete">✕</button></span></li>`;
  }
  list.innerHTML = h || `<li class="empty">${S.sessQ ? 'No session matches.' : 'No sessions yet. Say something!'}</li>`;
  setText($('#sessMeta'), String(S.chats.length));
}
$('#sessList').addEventListener('click', async e => {
  const li = e.target.closest('.si'); if (!li) return;
  const act = e.target.closest('[data-act]')?.dataset.act, c = S.chats.find(x => x.id === li.dataset.id);
  if (act === 'pin') { await api('PATCH', `api/chats/${c.id}`, { pinned: !c.pinned }); if (S.chat?.id === c.id) S.chat.pinned = !c.pinned; loadChats(); return; }
  if (act === 'del') {
    if (!await confirmBox(`Delete “${c.title}” and all its messages?`, 'DELETE')) return;
    await api('DELETE', `api/chats/${c.id}`);
    if (S.chat?.id === c.id) newDraft();
    loadChats(); return;
  }
  openChat(c.id);
  setDrawer(false);
});
$('#sessList').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('.si')) e.target.click(); });
let sessT;
$('#sessQ').addEventListener('input', e => { clearTimeout(sessT); sessT = setTimeout(() => { S.sessQ = e.target.value.trim(); loadChats(); }, 250); });
$('#newChat').addEventListener('click', () => { newDraft(); setDrawer(false); });
$('#newGhost').addEventListener('click', () => { newDraft({ brain: false }); setDrawer(false); toast('GHOST SESSION // 無記憶 — the brain is off', ''); });
$('#sessToggle').addEventListener('click', () => setDrawer(!$('#sessPanel').classList.contains('open')));
$('#sessClose').addEventListener('click', () => setDrawer(false));
$('#sessScrim').addEventListener('click', () => setDrawer(false));
/* sessions slide in as a drawer on narrow screens */
function setDrawer(on) {
  $('#sessPanel').classList.toggle('open', on);
  $('#sessScrim').classList.toggle('on', on);
  $('#sessToggle').setAttribute('aria-expanded', String(on));
}

function newDraft(opts = {}) {
  if (S.streaming) stop();
  const prev = S.chat;
  const fallback = (S.models.find(m => !/embed/i.test(m.name)) || {}).id || '';
  S.chat = { id: null, title: 'New session', model: S.settings.default_model || prev?.model || fallback, system: '', agent: !!prev?.agent && !opts.reset,
    brain: opts.brain ?? true, council: null, temperature: null, pinned: false };
  if (opts.brain === false) S.chat.agent = prev?.agent || false;
  S.msgs = []; S.live = null; S.openFolds.clear();
  store.set('chat', '');
  renderChat();
  if (!TOUCH.matches) $('#input').focus();
}
async function openChat(id) {
  if (S.streaming) stop();
  try {
    const r = await GET(`api/chats/${id}`);
    S.chat = r.chat; S.msgs = r.messages; S.live = null; S.openFolds.clear();
    store.set('chat', id);
    renderChat(true);
  } catch (e) { toast(e.message, 'crit'); newDraft(); }
}
async function reloadChat() {
  if (!S.chat?.id) return;
  const box = $('#msgs'), stick = nearBottom(box), top = box.scrollTop;
  const r = await GET(`api/chats/${S.chat.id}`);
  S.chat = r.chat; S.msgs = r.messages;
  renderChat(false);
  if (stick) box.scrollTop = box.scrollHeight; else box.scrollTop = top;
}
async function patchChat(fields) {
  Object.assign(S.chat, fields);
  if (S.chat.id) {
    try { S.chat = await api('PATCH', `api/chats/${S.chat.id}`, fields); loadChats(); } catch (e) { toast(e.message, 'crit'); }
  }
  renderChatBar();
  if (!S.msgs.length && !S.live) renderMessages();
}

/* ═════════════ chat header / toolbar ═════════════ */
function renderChat(scroll = true) {
  setText($('#chatTitle'), (S.chat.title || 'New session').toUpperCase());
  renderChatBar();
  renderMessages();
  if (scroll && S.msgs.length) { const b = $('#msgs'); b.scrollTop = b.scrollHeight; }
  $$('.si').forEach(li => li.classList.toggle('on', li.dataset.id === S.chat.id));
}
function renderChatBar() {
  const c = S.chat; if (!c) return;
  const councilOn = !!(c.council && c.council.members?.length);
  setModelBtn($('#modelBtn'), councilOn ? '' : c.model, councilOn ? `COUNCIL OF ${c.council.members.length}` : 'SELECT MODEL');
  if (councilOn) $('#modelBtn').innerHTML = `<span class="lc" style="color:var(--amber)">⚖</span><span class="mb-name">COUNCIL OF ${c.council.members.length}</span>`;
  const set = (el, on, label) => { el.classList.toggle('on', on); el.setAttribute('aria-pressed', String(on)); if (label) el.title = label; };
  set($('#agentTgl'), !!c.agent);
  set($('#brainTgl'), !!c.brain);
  $('#brainTgl').classList.toggle('brain-off', !c.brain);
  set($('#councilTgl'), councilOn);
  $('#ghostBanner').hidden = !!c.brain;
  const bits = [];
  if (c.temperature != null) bits.push(`T ${c.temperature}`);
  if ((c.system || '').trim()) bits.push('PROMPT');
  bits.push(c.id ? `#${c.id.slice(0, 6)}` : 'DRAFT');
  setText($('#chatMeta'), bits.join(' · '));
}
$('#modelBtn').addEventListener('click', () => {
  if (S.chat.council?.members?.length) { openCouncil(); return; }
  openModelPicker($('#modelBtn'), S.chat.model, id => { patchChat({ model: id }); if (!S.settings.default_model) saveSettings({ default_model: id }, true); });
});
$('#agentTgl').addEventListener('click', () => { patchChat({ agent: !S.chat.agent }); toast(S.chat.agent ? 'AGENT MODE // 自律 — tools armed' : 'AGENT MODE OFF'); });
$('#brainTgl').addEventListener('click', () => {
  patchChat({ brain: !S.chat.brain });
  toast(S.chat.brain ? 'BRAIN ON // 記憶 — recalling and learning' : 'BRAIN OFF // 無記憶 — nothing recalled or remembered from here on', S.chat.brain ? 'ok' : '');
});
$('#councilTgl').addEventListener('click', () => openCouncil());
$('#chatTitle').addEventListener('click', () => {
  if (!S.chat.id) return toast('Send a message first, then rename the session.');
  const f = html(`<form class="g-form"><label>TITLE<input name="t" maxlength="120" autofocus></label><div class="row"><span class="sp"></span><button class="tgl on" type="submit">RENAME</button></div></form>`);
  f.t.value = S.chat.title;
  f.addEventListener('submit', async e => { e.preventDefault(); modal.close(); await patchChat({ title: f.t.value.trim() || 'Untitled' }); setText($('#chatTitle'), S.chat.title.toUpperCase()); });
  modal.open('RENAME SESSION', f, 'sm'); f.t.select();
});
$('#sysBtn').addEventListener('click', () => {
  const f = html(`<form class="g-form">
    <label>SESSION PROMPT<textarea name="sys" rows="8" placeholder="Extra instructions for this session only (role, format, constraints)…"></textarea></label>
    <label>TEMPERATURE <span class="hint">empty = the model's default · 0 precise … 2 wild</span><input name="temp" type="number" step="0.05" min="0" max="2" placeholder="default"></label>
    <div class="row"><span class="sp"></span><button class="tgl on" type="submit">APPLY</button></div></form>`);
  f.sys.value = S.chat.system || ''; f.temp.value = S.chat.temperature ?? '';
  f.addEventListener('submit', e => { e.preventDefault(); modal.close(); patchChat({ system: f.sys.value, temperature: f.temp.value === '' ? null : Number(f.temp.value) }); });
  modal.open('TUNE SESSION // 調整', f);
  f.sys.focus();
});
$('#exportBtn').addEventListener('click', () => {
  if (!S.chat.id) return toast('Nothing to export yet.');
  const b = html(`<div class="g-form"><p class="g-note">Download this session.</p><div class="row">
    <a class="tgl on" href="api/chats/${S.chat.id}/export?fmt=md" download>MARKDOWN</a><a class="tgl" href="api/chats/${S.chat.id}/export?fmt=json" download>JSON</a></div></div>`);
  b.addEventListener('click', e => { if (e.target.closest('a')) setTimeout(() => modal.close(), 100); });
  modal.open('EXPORT // 書出', b, 'sm');
});

/* ═════════════ council 評議会 ═════════════ */
function openCouncil() {
  const c = S.chat;
  let members = (c.council?.members || []).map(m => ({ ...m }));
  if (!members.length) {
    const first = c.model || S.settings.default_model || '';
    members = [{ model: first, name: '', persona: '' }, { model: '', name: '', persona: '' }, { model: '', name: '', persona: '' }];
  }
  const presets = S.settings.councils || [];
  const f = html(`<form class="g-form">
    <p class="g-note">Every member answers your message on its own. Then each member ranks the <b>other</b> members' anonymised answers (nobody can vote for itself).
      The answer with the most first-choice votes wins; ties go to the Borda count. You see every answer and every ballot.</p>
    <div class="cm-rows"></div>
    <div class="row"><button class="tgl" type="button" data-add>＋ MEMBER</button><span class="sp"></span>
      <select name="preset" aria-label="Council presets" style="max-width:200px"><option value="">PRESETS…</option>${presets.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('')}</select>
      <button class="tgl" type="button" data-save>SAVE PRESET</button></div>
    <div class="row">${c.council ? '<button class="tgl" type="button" data-off style="color:var(--red)">DISBAND</button>' : ''}<span class="sp"></span>
      <button class="tgl on" type="submit">${c.council ? 'UPDATE COUNCIL' : 'CONVENE COUNCIL'}</button></div></form>`);
  const rows = f.querySelector('.cm-rows');
  const draw = () => {
    rows.innerHTML = '';
    members.forEach((m, i) => {
      const r = html(`<div class="cm-row"><span class="no">${String(i + 1).padStart(2, '0')}</span><button class="model-btn" type="button"></button>
        <input class="nm" placeholder="Name (optional)" maxlength="40"><button class="x-btn" type="button" title="Remove">✕</button>
        <span></span><input class="persona" placeholder="Persona / angle, e.g. “skeptical security reviewer” (optional)" maxlength="400"></div>`);
      setModelBtn(r.querySelector('.model-btn'), m.model, 'PICK MODEL');
      r.querySelector('.nm').value = m.name || ''; r.querySelector('.persona').value = m.persona || '';
      r.querySelector('.nm').oninput = e => { m.name = e.target.value; };
      r.querySelector('.persona').oninput = e => { m.persona = e.target.value; };
      r.querySelector('.model-btn').onclick = e => openModelPicker(e.currentTarget, m.model, id => { m.model = id; draw(); });
      r.querySelector('.x-btn').onclick = () => { members.splice(i, 1); draw(); };
      rows.append(r);
    });
  };
  draw();
  f.querySelector('[data-add]').onclick = () => { if (members.length >= 8) return toast('Eight members at most.', 'warn'); members.push({ model: '', name: '', persona: '' }); draw(); };
  f.preset.onchange = () => { const p = presets[f.preset.value]; if (p) { members = p.members.map(m => ({ ...m })); draw(); } };
  f.querySelector('[data-save]').onclick = async () => {
    const name = prompt('Preset name:', 'My council'); if (!name) return;
    const list = [...presets.filter(p => p.name !== name), { name, members: members.filter(m => m.model) }];
    await saveSettings({ councils: list }); toast('PRESET SAVED', 'ok');
  };
  f.querySelector('[data-off]')?.addEventListener('click', () => { modal.close(); patchChat({ council: null }); toast('COUNCIL DISBANDED'); });
  f.addEventListener('submit', e => {
    e.preventDefault();
    const ms = members.filter(m => m.model);
    if (ms.length < 2) return toast('A council needs at least 2 members with models.', 'warn');
    modal.close(); patchChat({ council: { members: ms } });
    toast(`COUNCIL OF ${ms.length} CONVENED // 評議会`, 'ok');
  });
  modal.open('COUNCIL // 評議会', f, 'wide');
}

function renderCouncil(cn, live) {
  const seats = cn.members || [], answers = cn.answers || [], ballots = cn.ballots || [];
  const votes = seats.map((_, i) => (cn.first ? cn.first[i] : ballots.filter(b => b.ranking?.[0] === i).length));
  const nb = Math.max(1, ballots.filter(b => b.ranking?.length).length);
  const phase = cn.winner != null ? 'VERDICT 評決' : cn.phase === 'vote' ? 'VOTING 投票中' : 'DELIBERATING 審議中';
  const name = i => esc(seats[i]?.name || modelName(seats[i]?.model) || `#${i + 1}`);
  const cards = seats.map((s, i) => {
    const err = cn.errors?.[i], done = cn.done ? cn.done[i] : true, win = cn.winner === i;
    const st = err ? '<span class="sst" style="color:var(--red)">FAILED</span>'
      : !done ? '<span class="sst go">ANSWERING</span>'
      : cn.winner != null ? (win ? '<span class="crown">♛</span>' : `<span class="sst">${votes[i]} VOTE${votes[i] === 1 ? '' : 'S'}</span>`)
      : cn.phase === 'vote' ? '<span class="sst go">VOTING</span>' : '<span class="sst">READY</span>';
    const why = ballots.filter(b => b.ranking?.[0] === i && b.reason).map(b => `<li><b>${name(b.voter)}</b>${esc(b.reason)}</li>`).join('');
    const text = answers[i] || '';
    const body = !done && live ? `<div class="preview">${esc(text.slice(-240)) || '…'}</div>` : '';
    return `<div class="seat${win ? ' win' : ''}${err ? ' bad' : ''}"><header><b>${name(i)}</b>${st}</header>
      <small>${esc(modelName(s.model))}${s.persona ? ' · ' + esc(s.persona) : ''}</small>
      ${cn.winner != null || ballots.length ? `<div class="vbar"><div class="bar"><i style="--w:${(votes[i] / nb * 100).toFixed(0)}%"></i></div><span>${votes[i]}/${nb}</span></div>` : ''}
      ${body}${err ? `<div class="err" style="font:11px var(--f-mono);color:var(--red)">${esc(err)}</div>` : ''}
      ${done && text ? fold(`seat:${cn._key}:${i}`, '', `ANSWER <em>回答</em><code>${text.length} chars</code>`, `<div class="md">${MD.render(MD.splitThink(text).text)}</div>`) : ''}
      ${why ? `<ul class="why">${why}</ul>` : ''}</div>`;
  }).join('');
  const verdict = cn.winner != null ? `<div class="cn-verdict"><b>WINNER ♛</b>${name(cn.winner)}<small>${esc(cn.method || '')} · ${votes[cn.winner]} of ${nb} first-choice vote${nb === 1 ? '' : 's'}</small></div>` : '';
  return `<div class="council"><div class="cn-head">⚖ COUNCIL<em>評議会</em><span class="ph-s">${phase} · ${seats.length} SEATS</span></div>
    <div class="cn-seats">${cards}</div>${verdict}</div>`;
}

/* ═════════════ messages ═════════════ */
const WELCOME = [
  ['RESEARCH', 'Research the trade-offs between vLLM, llama.cpp and Ollama for serving a 70B model at home.'],
  ['EXPLAIN', 'Explain how retrieval-augmented generation works, with a small diagram in text.'],
  ['CODE', 'Write a Python script that watches a folder and summarises new text files.'],
  ['ABOUT ME', 'Ask me five questions so you can learn how I like to work.'],
];
function welcome() {
  const c = S.chat, councilOn = !!c.council?.members?.length;
  const nTools = S.mcp.reduce((n, s) => n + (s.status === 'ready' ? s.tools.length : 0), 0);
  let kao = '(｀・ω・´)', mood = 'ONLINE', line = 'Core online. What are we building today?', jp = '竜核、起動完了。ご用件をどうぞ。';
  if (!S.models.length) { kao = '(・・;)ゞ'; mood = 'NO MODEL'; line = 'No model linked yet. Open MODELS and connect Ollama, vLLM, llama.cpp or a cloud provider.'; jp = 'モデル未接続です。'; }
  else if (councilOn) { kao = '(・ω・)ノ⚖'; mood = 'COUNCIL'; line = `The council of ${c.council.members.length} is assembled. Ask, and they'll answer, argue it out and vote.`; jp = '評議会、招集完了。'; }
  else if (!c.brain) { kao = '(￣ー￣)ゞ'; mood = 'GHOST'; line = "Ghost session. I won't recall anything, and I'll forget all of this. Promise."; jp = '記憶なしモードです。'; }
  else if (c.agent) { kao = '(ง •̀_•́)ง'; mood = 'AGENT'; line = `Agent mode armed${nTools ? `: ${nTools} MCP tools online` : ''}. Give me a mission and I'll use my tools.`; jp = '自律モード、待機中。'; }
  else if (S.brainCount) { line = `Core online. I remember ${S.brainCount} thing${S.brainCount === 1 ? '' : 's'} about you. What are we building today?`; }
  const chips = [
    councilOn ? `<span class="tag warn">COUNCIL ×${c.council.members.length}</span>` : (c.model ? `<span class="tag ok">${esc(modelName(c.model))}</span>` : '<span class="tag warn">NO MODEL</span>'),
    c.agent ? '<span class="tag ok">AGENT</span>' : '<span class="tag dim">CHAT</span>',
    c.brain ? `<span class="tag ok">BRAIN · ${S.brainCount}</span>` : '<span class="tag dim">BRAIN OFF</span>',
  ].join('');
  return html(`<div class="welcome">
    <div class="nav-body"><div class="nav-face${!S.models.length ? ' warn' : ''}"><div class="nf-screen"><span id="navKao">${esc(kao)}</span></div><div class="nf-name">RYU · 竜</div></div>
      <div class="nav-talk"><div class="nt-mood">${mood}</div><p class="w-line">${esc(line)}</p><p class="nt-jp">${jp}</p><div class="w-modes">${chips}</div></div></div>
    <div class="w-sugg">${WELCOME.map(([k, t]) => `<button type="button" data-p="${esc(t)}"><b>${k}</b>${esc(t)}</button>`).join('')}</div></div>`);
}
$('#msgs').addEventListener('click', e => {
  const sug = e.target.closest('.w-sugg button');
  if (sug) { $('#input').value = sug.dataset.p; autosize(); $('#input').focus(); return; }
  const cp = e.target.closest('[data-copy]');
  if (cp) { copyText(cp.closest('.code').querySelector('code').textContent); return; }
  const img = e.target.closest('.m-imgs img');
  if (img) { const lb = html(`<div class="lightbox"><img alt=""></div>`); lb.querySelector('img').src = img.src; lb.onclick = () => lb.remove(); document.body.append(lb); return; }
  const a = e.target.closest('[data-mact]'); if (!a) return;
  const art = a.closest('.msg'), act = a.dataset.mact;
  if (act === 'copy') copyText(art._copy || '');
  else if (act === 'regen') send('', 'regenerate');
  else if (act === 'edit') editUser(art.dataset.id);
});

function groupTurns(rows) {
  const out = [];
  for (const r of rows) {
    if (r.role === 'user') out.push({ kind: 'user', row: r });
    else if (out.length && out[out.length - 1].kind === 'ai') out[out.length - 1].rows.push(r);
    else out.push({ kind: 'ai', rows: [r] });
  }
  return out;
}
const FILE_RE = /\n*<file name="([^"]*)">\n[\s\S]*?\n<\/file>/g;
function renderUser(r) {
  const files = [...(r.content || '').matchAll(FILE_RE)].map(m => m[1]);
  const text = (r.content || '').replace(FILE_RE, '').trim();
  const art = html(`<article class="msg user" data-id="${r.id || ''}"><header><time>${r.created ? hm(r.created) : ''}</time><span class="who">YOU</span><em>操縦者</em></header>
    <div class="body"></div><div class="m-imgs"></div><div class="m-files"></div>
    <div class="m-act"><button type="button" data-mact="copy">COPY</button>${r.id && !S.streaming ? '<button type="button" data-mact="edit">EDIT</button>' : ''}</div></article>`);
  art.querySelector('.body').textContent = text || (files.length ? '(files)' : '');
  art._copy = r.content;
  const im = art.querySelector('.m-imgs');
  for (const u of r.meta?.images || []) { const i = document.createElement('img'); i.src = u; i.alt = 'attachment'; im.append(i); }
  art.querySelector('.m-files').innerHTML = [...(r.meta?.skills || []).map(s => `<span class="cchip skill"><span>/${esc(s)}</span></span>`),
    ...files.map(f => `<span class="cchip"><span>📄 ${esc(f)}</span></span>`)].join('');
  return art;
}
function renderAI(rows, { live = false, isLast = false } = {}) {
  const asst = rows.filter(r => r.role === 'assistant');
  const results = new Map(rows.filter(r => r.role === 'tool').map(r => [r.meta?.tool_call_id, r]));
  const first = asst[0], lastA = asst[asst.length - 1];
  const model = lastA?.meta?.model || '';
  const art = html(`<article class="msg ai${live ? ' streaming' : ''}"><header><span class="who">RYU</span><em>竜</em><span class="mdl"></span><time></time></header><div class="stack"></div><div class="m-act"></div></article>`);
  setText(art.querySelector('.mdl'), model ? `${modelName(model)}${asst.some(r => r.meta?.tool_calls?.length) ? ' · agent' : ''}` : '');
  setText(art.querySelector('time'), first?.created ? hm(first.created) : '');
  const stack = art.querySelector('.stack');
  let h = '';
  const recalled = first?.meta?.recalled || (live ? S.live?.recalled : null);
  const key0 = first?.id || 'live';
  if (recalled?.length) {
    h += fold(`recall:${key0}`, 'recall', `◈ RECALLED ${recalled.length} MEMOR${recalled.length === 1 ? 'Y' : 'IES'}<em>想起</em>`,
      `<ul>${recalled.map(m => `<li><span class="tag k-${esc(m.kind)}">${esc(m.kind)}</span>${esc(m.text)}</li>`).join('')}</ul>`);
  }
  let finalText = '';
  asst.forEach((r, idx) => {
    const meta = r.meta || {}, key = r.id || `live${idx}`;
    if (meta.council) { meta.council._key = key; h += renderCouncil(meta.council, live); }
    const { think, text } = MD.splitThink(r.content || '');
    const reasoning = ((meta.reasoning || '') + (think ? '\n' + think : '')).trim();
    const streamingHere = live && idx === asst.length - 1;
    if (reasoning) h += fold(`think:${key}`, 'think', `${streamingHere && !text ? '◌ THINKING' : 'REASONING'} <em>思考</em><code>${reasoning.length} chars</code>`, esc(reasoning), streamingHere && !text);
    if (text) { h += `<div class="md">${MD.render(text)}</div>`; finalText = text; }
    else if (streamingHere && !reasoning && !(meta.tool_calls || []).length && !meta.council) h += '<div class="md empty"></div>';
    for (const tc of meta.tool_calls || []) {
      const res = results.get(tc.id);
      const st = res ? (/^ERROR/.test(res.content) ? 'bad' : 'ok') : (live ? 'run' : 'bad');
      const stl = res ? (st === 'bad' ? 'ERROR' : 'DONE') : (live ? 'RUNNING' : 'NO RESULT');
      const argStr = JSON.stringify(tc.arguments ?? {}, null, 1);
      const isMcp = tc.name.includes('__');
      h += fold(`tool:${tc.id}`, `tool ${st}`, `${isMcp ? '⧉' : '⚙'} <b>${esc(tc.name)}</b><code>${esc(argStr.replace(/\s+/g, ' ').slice(0, 140))}</code><span class="tst">${stl}</span>`,
        `<label>INPUT</label><pre>${esc(argStr)}</pre>${res ? `<label>OUTPUT · ${res.content.length} chars</label><pre>${esc(res.content)}</pre>` : ''}`);
    }
    if (meta.error && meta.error !== 'interrupted') h += `<div class="m-err"><b>FAULT // 障害</b>${esc(meta.error)}</div>`;
    else if (meta.error === 'interrupted') h += '<div class="m-note">■ stopped</div>';
  });
  if (live && S.live) {
    for (const n of S.live.notices) h += `<div class="m-note">${esc(n)}</div>`;
    if (S.live.error) h += `<div class="m-err"><b>FAULT // 障害</b>${esc(S.live.error)}</div>`;
  }
  stack.innerHTML = h;
  art._copy = finalText;
  if (!live) {
    const usage = lastA?.meta?.usage;
    const tok = usage ? (usage.completion_tokens ?? usage.output_tokens) : null;
    art.querySelector('.m-act').innerHTML = `<button type="button" data-mact="copy">COPY</button>${isLast && !S.streaming ? '<button type="button" data-mact="regen">↻ REGENERATE</button>' : ''}${tok ? `<span class="usage">${tok} tok</span>` : ''}`;
  }
  return art;
}
function renderMessages() {
  const box = $('#msgs');
  box.innerHTML = '';
  if (!S.msgs.length && !S.live) { box.append(welcome()); return; }
  const turns = groupTurns(S.msgs);
  turns.forEach((t, i) => box.append(t.kind === 'user' ? renderUser(t.row) : renderAI(t.rows, { isLast: i === turns.length - 1 })));
  if (S.live) { const el = renderAI(S.live.rows, { live: true }); el.id = 'liveTurn'; box.append(el); }
}
let liveRaf = 0;
function paintLive() {
  if (liveRaf) return;
  liveRaf = requestAnimationFrame(() => {
    liveRaf = 0;
    const old = $('#liveTurn'); if (!old || !S.live) return;
    const box = $('#msgs'), stick = nearBottom(box);
    const el = renderAI(S.live.rows, { live: true }); el.id = 'liveTurn'; el.style.animation = 'none';
    old.replaceWith(el);
    if (stick) box.scrollTop = box.scrollHeight;
  });
}

/* ═════════════ send / stream ═════════════ */
function setSending(on) {
  const b = $('#sendBtn');
  b.classList.toggle('stop', on);
  b.innerHTML = on ? '■<span class="sl"> STOP</span>' : '<span class="sl">TRANSMIT </span>▸';
  b.setAttribute('aria-label', on ? 'Stop' : 'Send');
  b.type = on ? 'button' : 'submit';
}
function stop() { S.streaming?.ctrl.abort(); }
$('#sendBtn').addEventListener('click', e => { if (S.streaming) { e.preventDefault(); stop(); } });

async function ensureChat() {
  if (S.chat.id) return;
  const c = S.chat;
  const created = await POST('api/chats', { model: c.model, agent: c.agent, brain: c.brain, council: c.council, system: c.system, temperature: c.temperature });
  S.chat = created; store.set('chat', created.id);
  S.chats.unshift({ ...created, council: !!created.council });
  renderSessions();
}

function onEvent(ev) {
  const L = S.live, cur = () => L.rows.filter(r => r.role === 'assistant').at(-1);
  switch (ev.type) {
    case 'recall': L.recalled = ev.memories; break;
    case 'step': L.rows.push({ role: 'assistant', content: '', meta: { model: ev.model, tool_calls: [], reasoning: '' }, created: Date.now() / 1000 }); break;
    case 'text': if (cur()) cur().content += ev.text; break;
    case 'reasoning': if (cur()) cur().meta.reasoning += ev.text; break;
    case 'tool_call': cur()?.meta.tool_calls.push({ id: ev.id, name: ev.name, arguments: ev.arguments }); break;
    case 'tool_result': L.rows.push({ role: 'tool', content: ev.content, meta: { tool_call_id: ev.id, name: ev.name } }); break;
    case 'notice': L.notices.push(ev.text); break;
    case 'error': L.error = ev.error; break;
    case 'council_start':
      L.rows.push({ role: 'assistant', content: '', created: Date.now() / 1000,
        meta: { council: { members: ev.members, answers: ev.members.map(() => ''), errors: [], done: ev.members.map(() => false), ballots: [], phase: 'answer' } } });
      break;
    case 'member_text': { const c = cur().meta.council; c.answers[ev.i] += ev.text; break; }
    case 'member_done': { const c = cur().meta.council; c.done[ev.i] = true; c.errors[ev.i] = ev.error; break; }
    case 'phase': cur().meta.council.phase = ev.phase; break;
    case 'ballot': cur().meta.council.ballots.push(ev); break;
    case 'verdict': { const r = cur(), c = r.meta.council; Object.assign(c, ev, { phase: 'verdict' }); r.content = c.answers[ev.winner] || ''; r.meta.model = c.members[ev.winner]?.model; break; }
    default: break;
  }
  paintLive();
}

async function send(text, mode = 'new') {
  if (S.streaming) return;
  const c = S.chat;
  if (mode === 'new' && !text.trim() && !S.attach.length) return;
  if (!c.council?.members?.length && !c.model) { toast('Pick a model first.', 'warn'); openModelPicker($('#modelBtn'), '', id => patchChat({ model: id })); return; }
  let payload;
  if (mode === 'new') {
    const imgs = S.attach.filter(a => a.kind === 'image'), files = S.attach.filter(a => a.kind === 'text');
    let content = text;
    for (const f of files) content += `\n\n<file name="${f.name.replace(/"/g, '')}">\n${f.text}\n</file>`;
    payload = { content, images: imgs.map(a => a.dataUrl), skills: S.skillChips.slice(), files: files.map(f => f.name) };
  } else payload = { mode: 'regenerate' };
  try { await ensureChat(); } catch (e) { toast(e.message, 'crit'); return; }
  if (mode === 'new') {
    S.msgs.push({ role: 'user', content: payload.content, meta: { images: payload.images, skills: payload.skills }, created: Date.now() / 1000 });
    $('#input').value = ''; S.attach = []; S.skillChips = []; renderChips(); autosize();
  } else {
    const lu = S.msgs.map(r => r.role).lastIndexOf('user');
    S.msgs = S.msgs.slice(0, lu + 1);
  }
  S.live = { rows: [], recalled: null, notices: [], error: null };
  renderMessages();
  $('#msgs').scrollTop = $('#msgs').scrollHeight;
  const ctrl = new AbortController();
  S.streaming = { ctrl };
  setSending(true);
  const chatId = S.chat.id;
  try {
    const r = await fetch(`api/chats/${chatId}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ryu': '1' }, body: JSON.stringify(payload), signal: ctrl.signal });
    if (!r.ok) { let d = `HTTP ${r.status}`; try { d = (await r.json()).detail || d; } catch { /* */ } throw new Error(d); }
    for await (const ev of sseRead(r)) onEvent(ev);
  } catch (e) {
    if (e.name !== 'AbortError') { S.live.error = e.message; paintLive(); toast(e.message, 'crit'); }
  } finally {
    S.streaming = null;
    setSending(false);
    const err = S.live?.error;
    if (S.chat.id === chatId) {
      await new Promise(r => setTimeout(r, 150));
      // Drop the live turn before re-rendering so the saved reply replaces it instead of appearing beside it.
      const live = S.live;
      S.live = null;
      try { await reloadChat(); } catch { /* offline: keep showing what streamed */ S.live = live; renderMessages(); S.live = null; }
      if (err && !S.msgs.some(m => m.meta?.error)) { S.live = { rows: [], recalled: null, notices: [], error: err }; renderMessages(); S.live = null; }
    } else S.live = null;
    loadChats();
  }
}

async function editUser(id) {
  const r = S.msgs.find(m => m.id === id); if (!r) return;
  const f = html(`<form class="g-form"><p class="g-note">Everything after this message will be replaced by a new reply.</p>
    <label>MESSAGE<textarea name="t" rows="8" autofocus></textarea></label><div class="row"><span class="sp"></span><button class="tgl on" type="submit">RESEND ▸</button></div></form>`);
  f.t.value = r.content;
  f.addEventListener('submit', async e => {
    e.preventDefault(); modal.close();
    await api('PUT', `api/messages/${id}`, { content: f.t.value });
    await reloadChat(); send('', 'regenerate');
  });
  modal.open('EDIT // 編集', f, 'wide');
}

/* ═════════════ composer ═════════════ */
const input = $('#input');
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, innerHeight * 0.4) + 'px'; }
input.addEventListener('input', () => { autosize(); slashCheck(); });
const PHONE = matchMedia('(max-width: 700px)');
const syncPlaceholder = () => { input.placeholder = PHONE.matches ? 'TRANSMIT // 送信  ( / skills )' : 'TRANSMIT TO THE CORE… // 送信  ( / for skills )'; };
PHONE.addEventListener?.('change', syncPlaceholder); syncPlaceholder();
/* phones: the section tabs fold into a ☰ menu in the header; the page is sized to the height actually visible,
   which 100vh/100dvh get wrong in some mobile browsers (toolbars, in-app webviews), pushing the composer off-screen */
const navBtn = $('#navBtn');
function setNavMenu(on) { document.body.classList.toggle('nav-open', on); navBtn.setAttribute('aria-expanded', String(on)); }
navBtn.addEventListener('click', e => { e.stopPropagation(); setNavMenu(!document.body.classList.contains('nav-open')); });
document.addEventListener('click', e => { if (!e.target.closest('#viewNav')) setNavMenu(false); });
PHONE.addEventListener?.('change', () => setNavMenu(false));
const fitApp = () => document.documentElement.style.setProperty('--app-h', innerHeight + 'px');
addEventListener('resize', fitApp); visualViewport?.addEventListener('resize', fitApp); fitApp();
input.addEventListener('keydown', e => {
  if (!pop.el.hidden && pop.onkey && pop.onkey(e)) return;
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(hover: none)').matches) { e.preventDefault(); $('#composer').requestSubmit(); }
});
$('#composer').addEventListener('submit', e => { e.preventDefault(); if (!S.streaming) send(input.value); });

function renderChips() {
  $('#cpChips').innerHTML = [
    ...S.skillChips.map((s, i) => `<span class="cchip skill"><span>/${esc(s)}</span><button type="button" data-rm="s${i}" aria-label="Remove">✕</button></span>`),
    ...S.attach.map((a, i) => `<span class="cchip">${a.kind === 'image' ? `<img src="${a.dataUrl}" alt="">` : '📄'}<span>${esc(a.name)}</span><button type="button" data-rm="a${i}" aria-label="Remove">✕</button></span>`),
  ].join('');
}
$('#cpChips').addEventListener('click', e => {
  const b = e.target.closest('[data-rm]'); if (!b) return;
  const k = b.dataset.rm, i = +k.slice(1);
  if (k[0] === 's') S.skillChips.splice(i, 1); else S.attach.splice(i, 1);
  renderChips();
});

const TEXT_EXT = /\.(txt|md|markdown|py|js|mjs|ts|tsx|jsx|json|ya?ml|toml|ini|cfg|conf|csv|tsv|html?|css|scss|sh|bash|zsh|go|rs|c|h|cc|cpp|hpp|java|kt|rb|php|sql|xml|log|env|dockerfile|tf|lua|r|swift|vue|svelte)$/i;
async function shrinkImage(file) {
  const url = await readFile(file, 'dataurl');
  if (file.size < 1.5e6 && !/heic|tiff|bmp/i.test(file.type)) return url;
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  const k = Math.min(1, 1568 / Math.max(img.width, img.height));
  const cv = document.createElement('canvas'); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  return cv.toDataURL('image/jpeg', 0.88);
}
async function addFiles(files) {
  for (const f of files) {
    try {
      if (f.type.startsWith('image/')) {
        if (S.attach.filter(a => a.kind === 'image').length >= 8) { toast('Eight images at most.', 'warn'); continue; }
        S.attach.push({ kind: 'image', name: f.name || 'pasted image', dataUrl: await shrinkImage(f) });
      } else if (f.type.startsWith('text/') || TEXT_EXT.test(f.name) || f.type === 'application/json') {
        if (f.size > 600e3) { toast(`${f.name}: text files up to 600 KB`, 'warn'); continue; }
        S.attach.push({ kind: 'text', name: f.name, text: await readFile(f) });
      } else toast(`${f.name}: only images and text files can be attached`, 'warn');
    } catch (e) { toast(`${f.name}: ${e.message || 'unreadable'}`, 'crit'); }
  }
  renderChips();
}
$('#attachBtn').addEventListener('click', () => $('#fileIn').click());
$('#fileIn').addEventListener('change', e => { addFiles([...e.target.files]); e.target.value = ''; });
input.addEventListener('paste', e => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); addFiles(fs); } });
const comp = $('#composer');
['dragenter', 'dragover'].forEach(t => comp.addEventListener(t, e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); comp.classList.add('drag'); } }));
['dragleave', 'drop'].forEach(t => comp.addEventListener(t, () => comp.classList.remove('drag')));
comp.addEventListener('drop', e => { e.preventDefault(); addFiles([...e.dataTransfer.files]); });

/* slash menu: "/name" at the start of a line attaches a skill */
async function slashCheck() {
  const pos = input.selectionStart, before = input.value.slice(0, pos);
  const m = before.match(/(?:^|\n)\/([\w-]*)$/);
  if (!m) { if (pop.anchor === input) pop.close(); return; }
  if (!S.skills.length) { try { S.skills = await GET('api/skills'); } catch { return; } }
  const q = m[1].toLowerCase();
  const list = S.skills.filter(s => s.enabled && (s.slug.includes(q) || s.name.toLowerCase().includes(q))).slice(0, 12);
  const box = html(`<div class="pl" role="listbox"></div>`);
  box.innerHTML = list.length ? `<h5>SKILLS 技能<small>↵ / TAB</small></h5>` + list.map((s, i) => `<button type="button" class="pi${i === 0 ? ' sel' : ''}" data-s="${esc(s.slug)}"><span>/${esc(s.slug)}</span><small>${esc(s.description)}</small></button>`).join('')
    : `<div class="pempty">No skill matches “${esc(q)}”. Create one in SKILLS.</div>`;
  let sel = 0;
  const pick = slug => {
    const start = pos - m[1].length - 1;
    input.value = input.value.slice(0, start) + input.value.slice(pos);
    input.setSelectionRange(start, start);
    if (!S.skillChips.includes(slug)) S.skillChips.push(slug);
    renderChips(); pop.close(); input.focus();
  };
  box.addEventListener('mousedown', e => { const b = e.target.closest('.pi'); if (b) { e.preventDefault(); pick(b.dataset.s); } });
  pop.open(input, box, { width: 420 });
  pop.onkey = e => {
    const items = $$('.pi', box);
    if (!items.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items.forEach((b, i) => b.classList.toggle('sel', i === sel)); e.preventDefault(); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(items[sel].dataset.s); return true; }
    if (e.key === 'Escape') { pop.close(); return true; }
    return false;
  };
}

/* ═════════════ views ═════════════ */
function showView(v) {
  if (!VIEWS.includes(v)) v = 'chat';
  S.view = v;
  document.body.dataset.view = v;
  for (const x of VIEWS) $(`#v-${x}`).hidden = x !== v;
  $$('.vtab').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  pop.close(); setNavMenu(false);
  if (location.hash !== '#' + v) history.replaceState(null, '', v === 'chat' ? location.pathname + location.search : '#' + v);
  ({ brain: loadBrain, skills: loadSkills, mcp: loadMcp, models: renderProviders, system: renderSystem, chat: () => { if (!TOUCH.matches) input.focus(); } })[v]?.();
}
$('#viewNav').addEventListener('click', e => { const b = e.target.closest('.vtab'); if (b) showView(b.dataset.v); });

async function saveSettings(patch, quiet = false) {
  try { S.settings = await api('PUT', 'api/settings', patch); if (!quiet) toast('SAVED // 保存', 'ok'); } catch (e) { toast(e.message, 'crit'); }
}

/* ═════════════ BRAIN 記憶 ═════════════ */
let memKind = '';
async function loadBrain() {
  try {
    const r = await GET(`api/brain?q=${encodeURIComponent($('#memQ').value.trim())}&kind=${memKind}`);
    S.brainCount = r.stats.total;
    const kinds = ['', ...r.kinds];
    $('#memKinds').innerHTML = kinds.map(k => `<button type="button" data-k="${k}" class="${k === memKind ? 'on' : ''}">${k ? k.toUpperCase() : 'ALL'}</button>`).join('');
    $('#memList').innerHTML = r.memories.map(m => memRow(m)).join('') || `<li class="empty">${$('#memQ').value || memKind ? 'Nothing matches.' : 'The brain is empty. Chat with the brain on (or add a memory) and it will start learning about you.'}</li>`;
    setText($('#memMeta'), `${r.memories.length} / ${r.stats.total}`);
    const st = r.stats;
    $('#brainStats').innerHTML = `<div><label>MEMORIES</label><b>${st.total}</b></div><div><label>PINNED</label><b>${st.pinned}</b></div><div><label>EMBEDDED</label><b>${st.embedded}</b></div>`
      + Object.entries(st.kinds).map(([k, n]) => `<div style="border-color:var(--a3)"><label>${esc(k.toUpperCase())}</label><b>${n}</b></div>`).join('');
  } catch (e) { toast(e.message, 'crit'); }
  renderBrainSettings();
  renderFeed();
}
function memRow(m, extra = '') {
  return `<li class="mem" data-id="${m.id}"><span class="tag k-${esc(m.kind)}">${esc(m.kind)}</span><div class="tx">${esc(m.text)}</div>
    <div class="ma"><button type="button" data-a="pin" class="${m.pinned ? 'on' : ''}" title="${m.pinned ? 'Unpin' : 'Pin: always recalled'}">★</button><button type="button" data-a="edit" title="Edit">✎</button><button type="button" data-a="del" class="del" title="Forget">✕</button></div>
    <div class="mi">${extra}<span>recalled ${m.hits}×</span><span>${m.last_used ? 'last ' + since(m.last_used) + ' ago' : 'never used'}</span><span>${m.source === 'manual' ? 'added by you' : m.source === 'import' ? 'imported' : m.source ? '<a href="#" data-src="' + esc(m.source) + '" style="color:var(--dim)">from a session</a>' : ''}</span><span>${since(m.updated)} ago</span></div></li>`;
}
function renderBrainSettings() {
  const s = S.settings;
  const a = $('#bAuto'); a.classList.toggle('on', !!s.brain_autolearn); a.textContent = s.brain_autolearn ? 'ON' : 'OFF';
  setModelBtn($('#bModel'), s.brain_model, 'SAME AS SESSION');
  setModelBtn($('#bEmbed'), s.brain_embed_model, 'KEYWORD RECALL');
  $('#bK').value = s.brain_recall_k;
}
function renderFeed() {
  $('#brainFeed').innerHTML = S.feed.map(f => `<li><time>${hm(f.t)}</time><span class="op ${f.op}">${f.op.toUpperCase()}</span><span>${esc(f.text)}</span></li>`).join('')
    || '<li class="empty" style="display:block">Waiting for the brain to learn something…</li>';
}
$('#memKinds').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { memKind = b.dataset.k; loadBrain(); } });
let memT; $('#memQ').addEventListener('input', () => { clearTimeout(memT); memT = setTimeout(loadBrain, 250); });
async function memAction(e) {
  const src = e.target.closest('[data-src]');
  if (src) { e.preventDefault(); showView('chat'); openChat(src.dataset.src); return; }
  const b = e.target.closest('[data-a]'); if (!b) return;
  const li = b.closest('.mem'), id = li.dataset.id, a = b.dataset.a;
  if (a === 'pin') { await api('PATCH', `api/brain/${id}`, { pinned: !b.classList.contains('on') }); loadBrain(); }
  else if (a === 'del') { await api('DELETE', `api/brain/${id}`); li.remove(); toast('FORGOTTEN // 忘却'); }
  else if (a === 'edit') {
    const tx = li.querySelector('.tx'), before = tx.textContent;
    tx.contentEditable = 'true'; tx.focus();
    document.getSelection().selectAllChildren(tx);
    const done = async save => {
      tx.contentEditable = 'false'; tx.onkeydown = tx.onblur = null;
      const v = tx.textContent.trim();
      if (save && v && v !== before) { await api('PATCH', `api/brain/${id}`, { text: v }); toast('MEMORY REWRITTEN', 'ok'); } else tx.textContent = before;
    };
    tx.onkeydown = ev => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); done(true); } else if (ev.key === 'Escape') { ev.stopPropagation(); done(false); } };
    tx.onblur = () => done(true);
  }
}
$('#memList').addEventListener('click', memAction);
$('#recallList').addEventListener('click', memAction);
$('#memAdd').addEventListener('click', () => {
  const f = html(`<form class="g-form"><label>MEMORY<textarea name="t" rows="3" placeholder="The user prefers concise answers with code examples." autofocus></textarea></label>
    <div class="two"><label>KIND<select name="k">${['fact', 'preference', 'project', 'person', 'instruction', 'other'].map(k => `<option>${k}</option>`).join('')}</select></label>
    <label class="chk" style="align-self:end"><input type="checkbox" name="p"> PIN (ALWAYS RECALLED)</label></div>
    <div class="row"><span class="sp"></span><button class="tgl on" type="submit">IMPRINT</button></div></form>`);
  f.addEventListener('submit', async e => {
    e.preventDefault();
    try { await POST('api/brain', { text: f.t.value, kind: f.k.value, pinned: f.p.checked }); modal.close(); toast('IMPRINTED // 記憶', 'ok'); loadBrain(); } catch (err) { toast(err.message, 'crit'); }
  });
  modal.open('NEW MEMORY // 新規記憶', f);
});
$('#bAuto').addEventListener('click', async () => { await saveSettings({ brain_autolearn: !S.settings.brain_autolearn }, true); renderBrainSettings(); });
$('#bModel').addEventListener('click', e => openModelPicker(e.currentTarget, S.settings.brain_model, async id => { await saveSettings({ brain_model: id }); renderBrainSettings(); }, { none: 'SAME AS SESSION' }));
$('#bEmbed').addEventListener('click', e => openModelPicker(e.currentTarget, S.settings.brain_embed_model, async id => {
  await saveSettings({ brain_embed_model: id }, true); renderBrainSettings();
  if (id) { toast('Embedding memories…'); try { const r = await POST('api/brain/reembed'); toast(`EMBEDDED ${r.embedded} MEMORIES`, 'ok'); } catch (err) { toast('Embedding failed: ' + err.message, 'crit'); } loadBrain(); }
}, { none: 'KEYWORD RECALL (no embeddings)', filter: m => /embed|bge|e5|minilm|gte|nomic|arctic|mxbai/i.test(m.name) || !!$('.pop input')?.value }));
$('#bK').addEventListener('change', e => saveSettings({ brain_recall_k: Math.max(1, Math.min(30, +e.target.value || 6)) }));
$('#bReembed').addEventListener('click', async () => {
  if (!S.settings.brain_embed_model) return toast('Pick an embedding model first.', 'warn');
  try { const r = await POST('api/brain/reembed'); toast(`EMBEDDED ${r.embedded} MEMORIES`, 'ok'); loadBrain(); } catch (e) { toast(e.message, 'crit'); }
});
$('#bExport').addEventListener('click', async () => { const r = await GET('api/brain/export'); download('ryucore-brain.json', JSON.stringify(r, null, 1)); });
$('#bImport').addEventListener('click', () => $('#bImportFile').click());
$('#bImportFile').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try { const r = await POST('api/brain/import', JSON.parse(await readFile(f))); toast(`IMPORTED ${r.imported} MEMORIES`, 'ok'); loadBrain(); } catch (err) { toast('Import failed: ' + err.message, 'crit'); }
});
$('#bWipe').addEventListener('click', async () => {
  if (!await confirmBox('Wipe the entire brain? Every memory will be deleted. Export first if you might want it back.', 'WIPE BRAIN')) return;
  const r = await POST('api/brain/wipe'); toast(`WIPED ${r.deleted} MEMORIES`, 'warn'); loadBrain();
});
$('#recallForm').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('#recallQ').value.trim(); if (!q) return;
  const r = await POST('api/brain/recall', { q });
  $('#recallList').innerHTML = r.memories.map(m => memRow(m, m.score != null ? `<span style="color:var(--a1)">score ${m.score}</span>` : '<span style="color:var(--a2)">pinned</span>')).join('') || '<li class="empty">Nothing would be recalled.</li>';
});

/* ═════════════ SKILLS 技能 ═════════════ */
const SKILL_TEMPLATE = `---
name: my-skill
description: What this skill does and WHEN to use it (the model reads this to decide).
---

# My skill

Step-by-step instructions the model should follow when this skill is active.
`;
async function loadSkills() {
  try { S.skills = await GET('api/skills'); } catch (e) { return toast(e.message, 'crit'); }
  setText($('#skMeta'), `${S.skills.filter(s => s.enabled).length} / ${S.skills.length} enabled`);
  $('#skList').innerHTML = S.skills.map(s => `<div class="card${s.enabled ? '' : ' off'}" data-slug="${esc(s.slug)}" style="--sc:var(--a3)">
    <header><b>${esc(s.name)}</b><span class="chip mono">/${esc(s.slug)}</span></header>
    <div class="desc">${esc(s.description) || '<span style="color:var(--amber)">No description: agents will not know when to use it.</span>'}</div>
    <div class="sub2">${s.body_chars} chars${s.files.length ? ` · ${s.files.length} extra file${s.files.length > 1 ? 's' : ''}` : ''}</div>
    <div class="acts"><button class="tgl ${s.enabled ? 'on' : ''}" data-a="tog">${s.enabled ? 'ENABLED' : 'DISABLED'}</button><button class="tgl" data-a="edit">EDIT</button><button class="tgl" data-a="use">USE IN CHAT</button><button class="tgl" data-a="del" style="color:var(--red)">DELETE</button></div></div>`).join('')
    || '<div class="empty">No skills yet. Create one or import a SKILL.md / .zip.</div>';
}
async function editSkill(slug) {
  const s = slug ? await GET(`api/skills/${slug}`) : null;
  const f = html(`<form class="g-form"><label>SKILL.md<textarea class="code-ed" name="c" spellcheck="false"></textarea></label>
    <p class="g-note">${s?.files?.length ? 'Extra files: ' + s.files.map(esc).join(', ') : 'Front matter needs <b>name</b> and <b>description</b>.'}</p>
    <div class="row"><span class="sp"></span><button class="tgl on" type="submit">SAVE SKILL</button></div></form>`);
  f.c.value = s?.content || SKILL_TEMPLATE;
  f.c.addEventListener('keydown', e => { if (e.key === 'Tab') { e.preventDefault(); f.c.setRangeText('  ', f.c.selectionStart, f.c.selectionEnd, 'end'); } });
  f.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const name = (f.c.value.match(/^name:\s*(.+)$/m) || [])[1]?.trim();
      const r = await api('PUT', `api/skills/${encodeURIComponent(name || slug || '_new')}`, { content: f.c.value, rename_from: slug || undefined });
      modal.close(); toast(`SKILL SAVED // /${r.slug}`, 'ok'); loadSkills();
    } catch (err) { toast(err.message, 'crit'); }
  });
  modal.open(slug ? `EDIT SKILL // ${slug}` : 'NEW SKILL // 新技能', f, 'wide');
  f.c.focus();
}
$('#skNew').addEventListener('click', () => editSkill(null));
$('#skImport').addEventListener('click', () => $('#skFile').click());
$('#skFile').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try { const r = await POST('api/skills-import', { filename: f.name, data: b64(await readFile(f, 'buffer')) }); toast(`IMPORTED ${r.imported.join(', ')}`, 'ok'); loadSkills(); }
  catch (err) { toast(err.message, 'crit'); }
});
$('#skList').addEventListener('click', async e => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  const slug = b.closest('.card').dataset.slug, s = S.skills.find(x => x.slug === slug);
  if (b.dataset.a === 'tog') { await POST(`api/skills/${slug}/enabled`, { enabled: !s.enabled }); loadSkills(); }
  else if (b.dataset.a === 'edit') editSkill(slug);
  else if (b.dataset.a === 'use') { if (!S.skillChips.includes(slug)) S.skillChips.push(slug); renderChips(); showView('chat'); }
  else if (b.dataset.a === 'del' && await confirmBox(`Delete the skill “${s.name}” and its files?`, 'DELETE')) { await api('DELETE', `api/skills/${slug}`); loadSkills(); }
});

/* ═════════════ MCP 接続 ═════════════ */
const MCP_ST = { ready: 'var(--green)', starting: 'var(--amber)', error: 'var(--red)', stopped: 'var(--faint)' };
function mcpDot() {
  const on = S.mcp.filter(s => s.enabled);
  $('#mcpDot').style.setProperty('--sc', !on.length ? 'transparent' : on.some(s => s.status === 'error') ? 'var(--red)' : on.some(s => s.status === 'starting') ? 'var(--amber)' : 'var(--green)');
}
async function loadMcp(quiet) {
  try { S.mcp = await GET('api/mcp'); } catch (e) { if (!quiet) toast(e.message, 'crit'); return; }
  mcpDot();
  if (S.view !== 'mcp') return;
  const ready = S.mcp.filter(s => s.status === 'ready');
  setText($('#mcpMeta'), `${ready.length} ready · ${ready.reduce((n, s) => n + s.tools.length, 0)} tools`);
  $('#mcpList').innerHTML = S.mcp.map(s => `<div class="card${s.enabled ? '' : ' off'}" data-id="${s.id}" style="--sc:${MCP_ST[s.status] || 'var(--faint)'}">
    <header><span class="a-dot" style="--sc:${MCP_ST[s.status]}"></span><b>${esc(s.name)}</b><span class="chip">${esc(s.transport.toUpperCase())}</span><span class="chip" style="color:${MCP_ST[s.status]}">${esc(s.status.toUpperCase())}</span></header>
    <div class="sub2" title="${esc(s.transport === 'stdio' ? s.command + ' ' + s.args.join(' ') : s.url)}">${esc(s.transport === 'stdio' ? `$ ${s.command} ${s.args.join(' ')}` : s.url)}</div>
    ${s.server_info?.name ? `<div class="sub2">${esc(s.server_info.name)} ${esc(s.server_info.version || '')}</div>` : ''}
    ${s.error ? `<div class="err">${esc(s.error)}</div>` : ''}
    ${s.tools.length ? `<div class="chips">${s.tools.slice(0, 14).map(t => `<span class="chip mono" title="${esc(t.description)}">${esc(t.name)}</span>`).join('')}${s.tools.length > 14 ? `<span class="chip">+${s.tools.length - 14}</span>` : ''}</div>` : ''}
    <div class="acts"><button class="tgl" data-a="restart">↻ RESTART</button><button class="tgl" data-a="log">≡ LOG</button><button class="tgl" data-a="edit">EDIT</button>
      <button class="tgl ${s.enabled ? 'on' : ''}" data-a="tog">${s.enabled ? 'ENABLED' : 'DISABLED'}</button><button class="tgl" data-a="del" style="color:var(--red)">DELETE</button></div></div>`).join('')
    || '<div class="empty">No MCP servers yet. Add one, or paste a Claude Desktop style <code>mcpServers</code> JSON with IMPORT.</div>';
  try {
    const t = await GET('api/tools');
    const dis = new Set(S.settings.tools_disabled || []);
    setText($('#toolMeta'), `${t.builtin.filter(x => x.enabled).length} armed${t.shell ? '' : ' · shell locked (RYU_ALLOW_SHELL=0)'}`);
    $('#toolList').innerHTML = t.builtin.map(x => `<label class="trow${x.locked ? ' locked' : ''}" title="${x.locked ? 'Set RYU_ALLOW_SHELL=1 to unlock' : ''}"><input type="checkbox" data-t="${x.name}" ${!dis.has(x.name) && !x.locked ? 'checked' : ''} ${x.locked ? 'disabled' : ''}>
      <b>${esc(x.name)}<span class="chip">${esc(x.group.toUpperCase())}</span></b><small>${esc(x.description)}</small></label>`).join('');
  } catch { /* ignore */ }
}
$('#toolList').addEventListener('change', e => {
  const cb = e.target.closest('[data-t]'); if (!cb) return;
  const dis = new Set(S.settings.tools_disabled || []);
  if (cb.checked) dis.delete(cb.dataset.t); else dis.add(cb.dataset.t);
  saveSettings({ tools_disabled: [...dis] }, true);
});
const kvToText = (o, sep) => Object.entries(o || {}).map(([k, v]) => `${k}${sep}${v}`).join('\n');
const textToKv = (t, sep) => Object.fromEntries(t.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const i = l.indexOf(sep); return i < 0 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + sep.length).trim()]; }));
function editMcp(s) {
  const f = html(`<form class="g-form">
    <div class="two"><label>NAME<input name="name" required placeholder="filesystem" autofocus></label>
      <label>TRANSPORT<select name="transport"><option value="stdio">stdio — run a command</option><option value="http">http — Streamable HTTP</option><option value="sse">sse — legacy HTTP+SSE</option></select></label></div>
    <label data-for="stdio">COMMAND<input name="command" placeholder="npx"></label>
    <label data-for="stdio">ARGUMENTS (ONE PER LINE)<textarea name="args" rows="3" placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/data/workspace"></textarea></label>
    <label data-for="stdio">ENVIRONMENT (KEY=VALUE PER LINE)<textarea name="env" rows="2" placeholder="GITHUB_TOKEN=ghp_…"></textarea></label>
    <label data-for="http">URL<input name="url" placeholder="http://host.docker.internal:3000/mcp"></label>
    <label data-for="http">HEADERS (KEY: VALUE PER LINE)<textarea name="headers" rows="2" placeholder="Authorization: Bearer …"></textarea></label>
    <p class="g-note">stdio commands run inside the container in <code>/data/workspace</code>. Secret values show as •••• and are kept unless you change them.</p>
    <div class="row"><label class="chk"><input type="checkbox" name="enabled" checked> ENABLED</label><span class="sp"></span><button class="tgl on" type="submit">${s ? 'SAVE & RESTART' : 'CONNECT'}</button></div></form>`);
  const sync = () => $$('[data-for]', f).forEach(l => { l.hidden = (f.transport.value === 'stdio') !== (l.dataset.for === 'stdio'); });
  if (s) {
    f.name.value = s.name; f.transport.value = s.transport; f.command.value = s.command; f.args.value = (s.args || []).join('\n');
    f.env.value = kvToText(s.env, '='); f.url.value = s.url; f.headers.value = kvToText(s.headers, ': '); f.enabled.checked = s.enabled;
  }
  f.transport.onchange = sync; sync();
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const body = { id: s?.id, name: f.name.value.trim(), transport: f.transport.value, command: f.command.value.trim(),
      args: f.args.value.split('\n').map(x => x.trim()).filter(Boolean), env: textToKv(f.env.value, '='), url: f.url.value.trim(),
      headers: textToKv(f.headers.value, ':'), enabled: f.enabled.checked };
    try { await POST('api/mcp', body); modal.close(); toast(`MCP // ${body.name} connecting…`); setTimeout(() => loadMcp(), 600); } catch (err) { toast(err.message, 'crit'); }
  });
  modal.open(s ? `MCP // ${s.name}` : 'NEW MCP SERVER // 新規接続', f, 'wide');
}
$('#mcpAdd').addEventListener('click', () => editMcp(null));
$('#mcpImport').addEventListener('click', () => {
  const f = html(`<form class="g-form"><label>MCP CONFIG JSON<textarea class="code-ed" name="j" spellcheck="false" style="min-height:40vh" autofocus placeholder='{
  "mcpServers": {
    "fetch": { "command": "uvx", "args": ["mcp-server-fetch"] },
    "memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] },
    "remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer …" } }
  }
}'></textarea></label>
    <p class="g-note">The <code>mcpServers</code> format used by Claude Desktop, Cursor and most MCP READMEs.</p>
    <div class="row"><span class="sp"></span><button class="tgl on" type="submit">IMPORT</button></div></form>`);
  f.addEventListener('submit', async e => {
    e.preventDefault();
    try { const r = await POST('api/mcp/import', JSON.parse(f.j.value)); modal.close(); toast(`IMPORTED ${r.imported} SERVER${r.imported === 1 ? '' : 'S'}`, 'ok'); setTimeout(() => loadMcp(), 800); }
    catch (err) { toast('Import failed: ' + err.message, 'crit'); }
  });
  modal.open('IMPORT MCP // 一括接続', f, 'wide');
});
$('#mcpList').addEventListener('click', async e => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  const id = b.closest('.card').dataset.id, s = S.mcp.find(x => x.id === id), a = b.dataset.a;
  if (a === 'restart') { b.textContent = '…'; await POST(`api/mcp/${id}/restart`); loadMcp(); }
  else if (a === 'edit') editMcp(s);
  else if (a === 'tog') { await POST('api/mcp', { id, enabled: !s.enabled }); setTimeout(() => loadMcp(), 400); }
  else if (a === 'del' && await confirmBox(`Remove the MCP server “${s.name}”?`, 'REMOVE')) { await api('DELETE', `api/mcp/${id}`); loadMcp(); }
  else if (a === 'log') {
    const r = await GET(`api/mcp/${id}/log`);
    const pre = html('<pre class="logbox"></pre>'); pre.textContent = r.log.join('\n') || '(no output yet)';
    modal.open(`LOG // ${s.name}`, pre, 'wide'); pre.scrollTop = pre.scrollHeight;
  }
});

/* ═════════════ MODELS 演算 ═════════════ */
let presets = null;
async function renderProviders() {
  setModelBtn($('#defModel'), S.settings.default_model, 'NONE');
  const ps = S.providers;
  setText($('#provMeta'), `${ps.filter(p => p.enabled).length} online · ${S.models.length} models`);
  $('#provList').innerHTML = ps.map(p => {
    const st = S.modelStatus[p.id] || {};
    const sc = !p.enabled ? 'var(--faint)' : st.error ? 'var(--red)' : 'var(--green)';
    const key = p.key_set ? `<span class="tag ok">KEY ${esc(p.key_hint)}</span>` : p.key_from_env ? `<span class="tag ok">KEY · ${esc(p.key_env)}</span>` : (p.local ? '' : '<span class="tag warn">NO KEY</span>');
    return `<div class="card${p.enabled ? '' : ' off'}" data-id="${p.id}" style="--sc:${sc}">
      <header><span class="a-dot" style="--sc:${sc}"></span><b>${esc(p.name)}</b>${p.local ? '<span class="lc local">LOCAL</span>' : '<span class="lc cloud">CLOUD</span>'}<span class="chip">${p.kind === 'anthropic' ? 'ANTHROPIC API' : 'OPENAI API'}</span></header>
      <div class="sub2">${esc(p.base_url)}</div>
      <div class="chips">${key}<span class="tag ${st.error ? 'crit' : 'dim'}">${p.enabled ? (st.count ?? 0) + ' MODELS' : 'DISABLED'}</span></div>
      ${st.error && p.enabled ? `<div class="err">${esc(st.error)}</div>` : ''}
      <div class="acts"><button class="tgl" data-a="test">⚡ TEST</button><button class="tgl" data-a="edit">EDIT</button><button class="tgl ${p.enabled ? 'on' : ''}" data-a="tog">${p.enabled ? 'ENABLED' : 'DISABLED'}</button><button class="tgl" data-a="del" style="color:var(--red)">DELETE</button></div></div>`;
  }).join('') || '<div class="empty">No providers. Add one: local (Ollama, vLLM, llama.cpp, LM Studio) or cloud (OpenAI, Anthropic, Grok, Gemini, OpenRouter…).</div>';
}
async function editProvider(p, preset) {
  presets = presets || await GET('api/presets');
  if (!p && !preset) {
    const box = html(`<div class="g-form"><p class="g-note">Pick a starting point; every field can be changed on the next screen.</p><div class="presets"></div></div>`);
    box.querySelector('.presets').innerHTML = presets.map(x => `<button type="button" data-p="${x.id}">${esc(x.name)}<small>${x.local ? 'LOCAL' : 'CLOUD'} · ${x.kind === 'anthropic' ? 'anthropic' : 'openai-compatible'}</small></button>`).join('');
    box.addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (b) editProvider(null, presets.find(x => x.id === b.dataset.p)); });
    modal.open('ADD PROVIDER // 演算核追加', box, 'wide');
    return;
  }
  const v = p || { name: preset.name, kind: preset.kind, base_url: preset.base_url, key_env: preset.key_env, local: preset.local, models: '', preset: preset.id };
  const f = html(`<form class="g-form">
    <div class="two"><label>NAME<input name="name" required></label>
      <label>API FORMAT<select name="kind"><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic Messages</option></select></label></div>
    <label>BASE URL<input name="base_url" required placeholder="http://host.docker.internal:11434/v1"></label>
    <div class="two"><label>API KEY<input name="api_key" type="password" autocomplete="off" placeholder="${p?.key_set ? 'set (' + esc(p.key_hint) + ') — leave empty to keep' : 'none'}"></label>
      <label>OR READ KEY FROM ENV VAR<input name="key_env" placeholder="OPENAI_API_KEY"></label></div>
    <label>EXTRA MODEL NAMES (COMMA-SEPARATED, OPTIONAL)<input name="models" placeholder="for servers that don't list models, e.g. my-finetune, qwen3:32b"></label>
    <div class="row"><label class="chk"><input type="checkbox" name="local"> LOCAL (SELF-HOSTED)</label>${p?.key_set ? '<label class="chk"><input type="checkbox" name="clear"> CLEAR STORED KEY</label>' : ''}<span class="sp"></span>
      <span class="g-note" id="pTest"></span><button class="tgl" type="button" data-test>⚡ TEST</button><button class="tgl on" type="submit">SAVE</button></div></form>`);
  f.name.value = v.name; f.kind.value = v.kind; f.base_url.value = v.base_url; f.key_env.value = v.key_env || ''; f.models.value = v.models || ''; f.local.checked = !!v.local;
  const body = () => ({ id: p?.id, preset: v.preset, name: f.name.value.trim(), kind: f.kind.value, base_url: f.base_url.value.trim(), api_key: f.api_key.value,
    key_env: f.key_env.value.trim(), models: f.models.value, local: f.local.checked, clear_key: !!f.clear?.checked });
  let saved = p;
  const save = async () => { saved = await POST('api/providers', { ...body(), id: saved?.id }); f.api_key.value = ''; return saved; };
  f.querySelector('[data-test]').onclick = async () => {
    const out = $('#pTest', f); out.textContent = 'testing…'; out.style.color = '';
    try { const s = await save(); const r = await POST(`api/providers/${s.id}/test`); out.textContent = r.ok ? `✓ ${r.models.length} models · ${r.ms} ms` : `✕ ${r.error}`; out.style.color = r.ok ? 'var(--green)' : 'var(--red)'; }
    catch (err) { out.textContent = '✕ ' + err.message; out.style.color = 'var(--red)'; }
  };
  f.addEventListener('submit', async e => { e.preventDefault(); try { await save(); modal.close(); toast(`PROVIDER // ${f.name.value} saved`, 'ok'); await loadModels(true); } catch (err) { toast(err.message, 'crit'); } });
  modal.open(p ? `PROVIDER // ${p.name}` : `ADD // ${preset.name}`, f, 'wide');
}
$('#provAdd').addEventListener('click', () => editProvider(null));
$('#provRefresh').addEventListener('click', () => loadModels(true));
$('#defModel').addEventListener('click', e => openModelPicker(e.currentTarget, S.settings.default_model, async id => { await saveSettings({ default_model: id }); renderProviders(); }, { none: 'NONE' }));
$('#provList').addEventListener('click', async e => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  const id = b.closest('.card').dataset.id, p = S.providers.find(x => x.id === id), a = b.dataset.a;
  if (a === 'test') {
    b.textContent = '…';
    const r = await POST(`api/providers/${id}/test`);
    toast(r.ok ? `${p.name} // ${r.models.length} models · ${r.ms} ms` : `${p.name} // ${r.error}`, r.ok ? 'ok' : 'crit');
    loadModels();
  } else if (a === 'edit') editProvider(p);
  else if (a === 'tog') { await POST('api/providers', { id, enabled: !p.enabled }); loadModels(); }
  else if (a === 'del' && await confirmBox(`Delete the provider “${p.name}”? Sessions using its models will need a new model.`, 'DELETE')) { await api('DELETE', `api/providers/${id}`); loadModels(); }
});

/* ═════════════ SYSTEM 設定 ═════════════ */
function renderSystem() {
  const s = S.settings, i = S.info;
  $('#sGlobal').value = s.system_prompt || ''; $('#sSteps').value = s.max_steps; $('#sHist').value = s.history_limit;
  $('#sAnth').value = s.anthropic_max_tokens; $('#sTitle').value = s.auto_title ? '1' : '0';
  const boot = store.get('boot') !== '0'; $('#bootTgl').classList.toggle('on', boot); $('#bootTgl').textContent = boot ? 'ON' : 'OFF';
  $('#sysInfo').innerHTML = `<dt>VERSION</dt><dd>${esc(i.version)}</dd><dt>LOGIN</dt><dd class="${i.auth ? '' : 'warn'}">${i.auth ? 'password' : 'OFF — open to anyone who can reach it'}</dd>
    <dt>SHELL TOOLS</dt><dd class="${i.shell ? 'warn' : ''}">${i.shell ? 'ENABLED' : 'locked'}</dd><dt>WEB SEARCH</dt><dd>${i.searxng ? 'SearXNG' : 'DuckDuckGo'}</dd>
    <dt>DATA</dt><dd>${esc(i.data)}</dd><dt>WORKSPACE</dt><dd>${esc(i.workspace)}</dd><dt>PROVIDERS</dt><dd>${S.providers.length}</dd><dt>MODELS</dt><dd>${S.models.length}</dd>
    <dt>MCP</dt><dd>${S.mcp.filter(x => x.status === 'ready').length} / ${S.mcp.length} ready</dd><dt>MEMORIES</dt><dd>${S.brainCount}</dd>`;
  $('#logoutBtn').hidden = !i.auth;
}
$('#sysForm').addEventListener('submit', e => {
  e.preventDefault();
  saveSettings({ system_prompt: $('#sGlobal').value, max_steps: Math.max(1, +$('#sSteps').value || 12), history_limit: Math.max(4, +$('#sHist').value || 80),
    anthropic_max_tokens: Math.max(256, +$('#sAnth').value || 8192), auto_title: $('#sTitle').value === '1' });
});
$('#bootTgl').addEventListener('click', () => { store.set('boot', store.get('boot') === '0' ? '1' : '0'); renderSystem(); });
$('#logoutBtn').addEventListener('click', async () => { await POST('api/logout'); location.href = 'login.html'; });

/* ═════════════ live events ═════════════ */
function connectEvents() {
  // The browser auto-retries an EventSource only for some failures; when the server is down or answers
  // with an error (e.g. mid-restart, proxy 502) it closes the stream for good. Reopen it ourselves, with backoff.
  const R = connectEvents.retry ||= { delay: 1000, timer: 0, es: null };
  clearTimeout(R.timer);
  R.es?.close();
  const es = R.es = new EventSource('api/events');
  const link = on => { $('#link').classList.toggle('on', on); setText($('#link span'), on ? 'LINKED' : 'NO LINK'); };
  es.onopen = () => { R.delay = 1000; link(true); };
  es.onerror = () => {
    link(false);
    if (es.readyState === EventSource.CLOSED && R.es === es) {
      R.timer = setTimeout(connectEvents, R.delay);
      R.delay = Math.min(R.delay * 2, 30000);
    }
  };
  if (!connectEvents.wired) {
    connectEvents.wired = true;
    // Retry immediately when the network comes back or the tab is looked at again.
    const kick = () => { if (R.es?.readyState === EventSource.CLOSED) { R.delay = 1000; connectEvents(); } };
    addEventListener('online', kick);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
  }
  es.onmessage = e => {
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.type === 'chat_title') {
      const c = S.chats.find(x => x.id === ev.id); if (c) { c.title = ev.title; renderSessions(); }
      if (S.chat?.id === ev.id) { S.chat.title = ev.title; setText($('#chatTitle'), ev.title.toUpperCase()); }
    } else if (ev.type === 'brain_learned') {
      for (const ch of ev.changes) S.feed.unshift({ t: Date.now() / 1000, op: ch.op, text: ch.text });
      S.feed.length = Math.min(S.feed.length, 100);
      const adds = ev.changes.filter(c => c.op === 'add').length;
      S.brainCount += adds - ev.changes.filter(c => c.op === 'forget').length;
      const first = ev.changes[0];
      toast(`◈ BRAIN // ${first.op === 'add' ? 'learned' : first.op === 'update' ? 'updated' : 'forgot'}: ${first.text}${ev.changes.length > 1 ? ` (+${ev.changes.length - 1})` : ''}`, 'ok');
      if (S.view === 'brain') loadBrain();
    } else if (ev.type === 'brain_error') {
      S.feed.unshift({ t: Date.now() / 1000, op: 'err', text: 'learning failed: ' + ev.error });
      if (S.view === 'brain') renderFeed();
    } else if (ev.type === 'mcp') {
      clearTimeout(connectEvents.t); connectEvents.t = setTimeout(() => loadMcp(true), 300);
      if (ev.status === 'error') toast(`MCP // server failed: ${ev.error}`, 'crit');
    }
  };
}

/* ═════════════ keyboard ═════════════ */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (pop.close() || modal.close()) return;
    if ($('.lightbox')) { $('.lightbox').remove(); return; }
    if (document.body.classList.contains('nav-open')) { setNavMenu(false); navBtn.focus(); return; }
    if (S.streaming) { stop(); return; }
    setDrawer(false);
    return;
  }
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  const k = e.key.toLowerCase();
  if (k === 'n') { e.preventDefault(); showView('chat'); newDraft(); }
  else if (k === 'g') { e.preventDefault(); showView('chat'); newDraft({ brain: false }); }
  else if (k === 't') { e.preventDefault(); cycleTheme(e.shiftKey ? -1 : 1); }
  else if (/^[1-6]$/.test(k)) { e.preventDefault(); showView(VIEWS[+k - 1]); }
});
addEventListener('hashchange', () => showView(location.hash.slice(1) || 'chat'));

/* ═════════════ boot ═════════════ */
(async function boot() {
  const ready = bootSeq([
    'RYUCORE 竜核 // AI COMMAND CORE',
    'igniting dragon core ................ <span class="ok">OK</span>',
    'linking model providers ............. <span class="ok">OK</span>',
    'mounting brain cortex 記憶 ........... <span class="ok">OK</span>',
    'arming agent toolchain 自律 .......... <span class="ok">OK</span>',
    'opening MCP channels 接続 ............ <span class="ok">OK</span>',
    'convening the council 評議会 ......... <span class="ok">OK</span>',
    'waking navigator RYU ................ <span class="ok">OK</span>',
  ]);
  try {
    [S.info] = await Promise.all([GET('api/info'), loadSettings()]);
  } catch (e) { toast('Core unreachable: ' + e.message, 'crit'); }
  await Promise.all([loadModels(), loadChats(), loadMcp(true), GET('api/brain').then(r => { S.brainCount = r.stats.total; }).catch(() => {})]);
  setText($('#footInfo'), S.info.auth ? `v${S.info.version}` : `v${S.info.version} · `);
  if (!S.info.auth) $('#foot').insertAdjacentHTML('beforeend', '<span class="warn">NO LOGIN<span class="long"> — set RYU_PASSWORD before exposing beyond your LAN</span></span>');
  const last = store.get('chat');
  if (last && S.chats.some(c => c.id === last)) await openChat(last); else newDraft({ reset: true });
  connectEvents();
  showView(location.hash.slice(1) || 'chat');
  ready();
})();
