/* RyuCore minimal Markdown → HTML. Everything is HTML-escaped first; only http(s)/mailto links survive. */
'use strict';

const MD = (() => {
  const escH = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = u => (/^(https?:|mailto:)/i.test(u.trim()) ? u.trim().replace(/"/g, '%22') : null);

  function inline(s) {
    // s is already escaped. Protect code spans first.
    const codes = [];
    s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _t, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;.*?&quot;)?\)/g, (m, alt, u) => {
      const url = safeUrl(u); return url ? `<a href="${url}" target="_blank" rel="noopener noreferrer">🖼 ${alt || 'image'}</a>` : m;
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;.*?&quot;)?\)/g, (m, text, u) => {
      const url = safeUrl(u.replace(/&amp;/g, '&')); return url ? `<a href="${escH(url)}" target="_blank" rel="noopener noreferrer">${text}</a>` : m;
    });
    s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<]+[^\s<.,:;"')\]])/g, (m, pre, u) =>
      `${pre}<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
    s = s.replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
  }

  function table(lines) {
    const cells = l => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim());
    const head = cells(lines[0]);
    const align = cells(lines[1]).map(c => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : ''));
    const th = head.map((c, i) => `<th${align[i] ? ` style="text-align:${align[i]}"` : ''}>${inline(c)}</th>`).join('');
    const rows = lines.slice(2).map(l => `<tr>${cells(l).map((c, i) => `<td${align[i] ? ` style="text-align:${align[i]}"` : ''}>${inline(c)}</td>`).join('')}</tr>`).join('');
    return `<table><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>`;
  }

  function list(lines) {
    // nested lists by indentation: a stack of (indent, child list) frames
    const root = [], stack = [{ indent: -1, list: root }];
    for (const raw of lines) {
      const m = raw.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (!m) { const top = stack[stack.length - 1]; const cur = top.node; if (cur) cur.text += '\n' + raw.trim(); continue; }
      const indent = m[1].replace(/\t/g, '    ').length, ordered = /\d/.test(m[2]);
      while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
      const node = { text: m[3], sub: [], ordered, start: ordered ? parseInt(m[2], 10) : 1 };
      stack[stack.length - 1].list.push(node);
      stack.push({ indent, list: node.sub, node });
    }
    const render = items => {
      if (!items?.length) return '';
      const ord = items[0].ordered, tag = ord ? 'ol' : 'ul';
      const start = ord && items[0].start !== 1 ? ` start="${items[0].start}"` : '';
      return `<${tag}${start}>${items.map(it => {
        let t = it.text, box = '';
        const cb = t.match(/^\[( |x|X)\]\s+/);
        if (cb) { box = cb[1] === ' ' ? '☐ ' : '☑ '; t = t.slice(cb[0].length); }
        return `<li>${box}${inline(t).replace(/\n/g, '<br>')}${render(it.sub)}</li>`;
      }).join('')}</${tag}>`;
    };
    return render(root);
  }

  function render(src) {
    src = String(src ?? '').replace(/\r\n?/g, '\n');
    const out = [], lines = src.split('\n');
    let i = 0, para = [];
    const flush = () => { if (para.length) { out.push(`<p>${inline(escH(para.join('\n'))).replace(/\n/g, '<br>')}</p>`); para = []; } };
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/);
      if (fence) {
        flush();
        const mark = fence[1], lang = fence[2] || '', buf = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(mark)) buf.push(lines[i++]);
        i++;
        out.push(`<div class="code"><header><span>${escH(lang || 'text')}</span><button type="button" data-copy>COPY</button></header><pre><code>${escH(buf.join('\n'))}</code></pre></div>`);
        continue;
      }
      if (!line.trim()) { flush(); i++; continue; }
      const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) { flush(); const n = Math.min(h[1].length, 4); out.push(`<h${n}>${inline(escH(h[2]))}</h${n}>`); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
      if (/^\s*>/.test(line)) {
        flush(); const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${render(buf.join('\n'))}</blockquote>`); continue;
      }
      if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        flush(); const buf = [line, lines[i + 1]]; i += 2;
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) buf.push(lines[i++]);
        out.push(table(buf.map(escH))); continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        flush(); const buf = [];
        while (i < lines.length && (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && buf.length))) buf.push(lines[i++]);
        out.push(list(buf.map(escH))); continue;
      }
      para.push(line); i++;
    }
    flush();
    return out.join('');
  }

  /* split "<think>…</think>" reasoning (local models) from the visible answer */
  function splitThink(s) {
    s = String(s ?? '');
    let think = '';
    s = s.replace(/<think>([\s\S]*?)<\/think>/g, (_, t) => { think += t; return ''; });
    const open = s.indexOf('<think>');
    if (open !== -1) { think += s.slice(open + 7); s = s.slice(0, open); }
    return { think: think.trim(), text: s.replace(/^\s+/, '') };
  }

  return { render, splitThink, esc: escH };
})();
