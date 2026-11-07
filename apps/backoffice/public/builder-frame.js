/* Runs inside the canvas iframe. Adds selection, hover, inline editing and drag-and-drop on top of the
   exact HTML the renderer produces. Talks to the Angular host through window.parent.osBuilderHost. */
(() => {
  const host = () => window.parent && window.parent.osBuilderHost;
  const NAMES = { section: 'Section', column: 'Column', heading: 'Heading', text: 'Text', image: 'Image', button: 'Button', spacer: 'Spacer', divider: 'Divider', iconBox: 'Icon box', stat: 'Stat', testimonial: 'Testimonial', faq: 'FAQ', gallery: 'Gallery', productGrid: 'Products', productTitle: 'Product name', productPrice: 'Price', productDescription: 'Description', productGallery: 'Product photos', addToCart: 'Add to cart', searchBox: 'Search box', dynamicTitle: 'Page title', categoryNav: 'Categories' };
  const ICON = {
    grip: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.8"/><circle cx="15" cy="6" r="1.8"/><circle cx="9" cy="12" r="1.8"/><circle cx="15" cy="12" r="1.8"/><circle cx="9" cy="18" r="1.8"/><circle cx="15" cy="18" r="1.8"/></svg>',
    up: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>',
    down: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    parent: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v5"/></svg>',
    dup: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
    del: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  };

  const style = document.createElement('style');
  style.textContent = `
    html.os-edit, html.os-edit body{cursor:default}
    #os-ov{position:absolute;left:0;top:0;width:0;height:0;z-index:2147483000;pointer-events:none;font:600 11px/1 'Figtree',system-ui,sans-serif}
    .os-box{position:absolute;pointer-events:none;border-radius:3px;transition:left .12s,top .12s,width .12s,height .12s}
    .os-hover{outline:1.5px solid rgba(43,75,255,.6);background:rgba(43,75,255,.045)}
    .os-hover::after{content:attr(data-label);position:absolute;left:-1.5px;top:-21px;background:#2B4BFF;color:#fff;padding:5px 8px;border-radius:6px 6px 6px 0;white-space:nowrap}
    .os-hover.os-in::after{top:0;border-radius:0 0 6px 0}
    .os-sel{outline:2px solid #2B4BFF;transition:none}
    .os-bar{position:absolute;left:-2px;top:-38px;display:flex;align-items:center;gap:1px;background:#141A33;color:#fff;border-radius:10px 10px 10px 3px;padding:3px;pointer-events:auto;box-shadow:0 10px 28px rgba(10,15,40,.4);white-space:nowrap}
    .os-bar.os-in{top:5px;left:5px;border-radius:10px}
    .os-bar button,.os-bar .os-grip{all:unset;box-sizing:border-box;width:26px;height:26px;display:grid;place-items:center;border-radius:7px;cursor:pointer;color:#fff}
    .os-bar button:hover,.os-bar .os-grip:hover{background:rgba(255,255,255,.18)}
    .os-bar .os-grip{cursor:grab;color:#FFD23F}
    .os-bar .os-lbl{padding:0 9px 0 5px;font-size:11px;letter-spacing:.01em}
    .os-bar .os-sep{width:1px;height:16px;background:rgba(255,255,255,.2);margin:0 3px}
    .os-line{position:absolute;background:#FFD23F;border-radius:4px;box-shadow:0 0 0 2px #141A33,0 8px 22px rgba(255,210,63,.6)}
    .os-line::after{content:attr(data-label);position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:#141A33;color:#FFD23F;padding:5px 9px;border-radius:99px;white-space:nowrap;font-size:11px}
    .os-line.os-v::after{display:none}
    .os-dropbox{position:absolute;border:2px dashed #141A33;background:rgba(255,210,63,.42);border-radius:12px}
    .os-empty{min-height:104px;display:grid;place-items:center;border:1.5px dashed rgba(120,130,170,.6);border-radius:14px;color:rgba(110,120,160,1);font:500 13px 'Figtree',system-ui;background:repeating-linear-gradient(135deg,transparent 0 10px,rgba(120,130,170,.08) 10px 20px)}
    .os-blank{margin:48px auto;max-width:560px;padding:64px 24px;text-align:center;border:2px dashed rgba(120,130,170,.6);border-radius:22px;color:rgba(100,110,150,1);font:500 16px/1.5 'Figtree',system-ui}
    [data-edit][contenteditable]{outline:2px solid #FFD23F;outline-offset:4px;border-radius:3px;cursor:text;box-shadow:0 0 0 6px rgba(255,210,63,.25)}
    html.os-edit [data-edit]:hover{cursor:text}
    html.os-edit img{-webkit-user-drag:none;user-select:none}
    html.os-edit [data-node]:not([data-type=section]):not([data-type=column]):not([data-edit]){cursor:grab}
    html.os-moving,html.os-moving *{cursor:grabbing!important;user-select:none!important}
    .os-dragging{opacity:.35!important;transition:opacity .15s}
    .os-ghost{position:fixed;z-index:2147483600;pointer-events:none;display:none;background:#141A33;color:#fff;border-radius:10px;padding:7px 12px 7px 9px;box-shadow:0 14px 34px rgba(10,15,40,.45);white-space:nowrap;transform:translate(14px,14px)}
    .os-ghost i{color:#FFD23F;margin-right:6px;font-style:normal}
  `;
  document.head.appendChild(style);
  document.documentElement.classList.add('os-edit');

  const ov = document.createElement('div'); ov.id = 'os-ov'; document.documentElement.appendChild(ov);
  const mk = (cls) => { const d = document.createElement('div'); d.className = cls; d.style.display = 'none'; ov.appendChild(d); return d; };
  const hoverBox = mk('os-box os-hover'), selBox = mk('os-box os-sel'), line = mk('os-line'), dropBox = mk('os-dropbox');
  const bar = document.createElement('div'); bar.className = 'os-bar'; selBox.appendChild(bar);
  const ghost = document.createElement('div'); ghost.className = 'os-ghost'; ov.appendChild(ghost);

  let selected = null, hovered = null, mode = 'edit', editing = null, movingId = null, lastDrop = null;

  const byId = (id) => id ? document.querySelector('[data-node="' + CSS.escape(id) + '"]') : null;
  const typeOf = (el) => el && el.dataset.type;
  const kindOf = (type) => type === 'section' ? 'section' : type === 'column' ? 'column' : 'widget';
  const place = (box, r, pad = 0) => {
    box.style.display = 'block';
    box.style.left = (r.left + scrollX - pad) + 'px'; box.style.top = (r.top + scrollY - pad) + 'px';
    box.style.width = (r.width + pad * 2) + 'px'; box.style.height = (r.height + pad * 2) + 'px';
  };

  function buildBar(el) {
    const t = typeOf(el);
    bar.innerHTML = '';
    const grip = document.createElement('div'); grip.className = 'os-grip'; grip.title = 'Drag to move'; grip.innerHTML = ICON.grip;
    const lbl = document.createElement('span'); lbl.className = 'os-lbl'; lbl.textContent = NAMES[t] || t;
    bar.append(grip, lbl);
    const btn = (name, icon, title) => { const b = document.createElement('button'); b.innerHTML = icon; b.title = title; b.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); const h = host(); if (h) h.action(name, el.dataset.node); }); return b; };
    const sep = () => { const s = document.createElement('span'); s.className = 'os-sep'; return s; };
    if (t !== 'section') bar.append(sep(), btn('parent', ICON.parent, 'Select parent'));
    bar.append(sep(), btn('up', ICON.up, 'Move up'), btn('down', ICON.down, 'Move down'), btn('duplicate', ICON.dup, 'Duplicate (Ctrl+D)'), btn('delete', ICON.del, 'Delete'));
  }

  function refresh() {
    hovered && !document.contains(hovered) && (hovered = null);
    const sel = byId(selected);
    if (mode !== 'edit') { hoverBox.style.display = selBox.style.display = 'none'; return; }
    if (sel) {
      const r = sel.getBoundingClientRect();
      place(selBox, r);
      if (selBox.dataset.for !== selected || selBox.dataset.t !== String(typeOf(sel))) { buildBar(sel); selBox.dataset.for = selected; selBox.dataset.t = String(typeOf(sel)); }
      bar.classList.toggle('os-in', r.top < 46);
    } else selBox.style.display = 'none';
    if (hovered && hovered !== sel) {
      const r = hovered.getBoundingClientRect();
      place(hoverBox, r);
      hoverBox.dataset.label = NAMES[typeOf(hovered)] || '';
      hoverBox.classList.toggle('os-in', r.top < 28);
    } else hoverBox.style.display = 'none';
  }
  const hideDrop = () => { line.style.display = dropBox.style.display = 'none'; lastDrop = null; };

  // ---- hover / select ----
  document.addEventListener('mouseover', (e) => {
    if (mode !== 'edit' || editing || movingId) return;
    if (e.target.closest && e.target.closest('#os-ov')) return;
    const n = e.target.closest && e.target.closest('[data-node]');
    if (n !== hovered) { hovered = n; refresh(); const h = host(); h && h.hover && h.hover(n ? n.dataset.node : null); }
  }, true);
  document.documentElement.addEventListener('mouseleave', () => { hovered = null; refresh(); const h = host(); h && h.hover && h.hover(null); });

  document.addEventListener('click', (e) => {
    const t = e.target;
    if (suppressClick) { e.preventDefault(); e.stopPropagation(); return; }
    if (mode !== 'edit') { const a = t.closest && t.closest('a[href]'); if (a && !a.getAttribute('href').startsWith('#')) e.preventDefault(); return; }
    if (t.closest && t.closest('#os-ov')) return;
    if (editing && editing.el.contains(t)) return;
    e.preventDefault(); e.stopPropagation();
    const n = t.closest && t.closest('[data-node]');
    const id = n ? n.dataset.node : null;
    const editable = t.closest && t.closest('[data-edit]');
    if (id && id === selected && editable) { startEdit(editable); return; }
    const h = host(); h && h.select(id);
  }, true);
  document.addEventListener('dblclick', (e) => {
    if (mode !== 'edit') return;
    const editable = e.target.closest && e.target.closest('[data-edit]');
    if (editable) { e.preventDefault(); const n = editable.closest('[data-node]'); if (n) { const h = host(); h && h.select(n.dataset.node); } startEdit(editable); }
  }, true);

  // ---- inline editing ----
  function startEdit(el) {
    if (editing) return;
    const node = el.closest('[data-node]'); if (!node) return;
    const path = el.dataset.edit;
    const single = /^H[1-6]$/.test(el.tagName) || !(/^text$|\.a$|^quote$/.test(path));
    editing = { el, id: node.dataset.node, path, orig: el.textContent, cancelled: false };
    try { el.contentEditable = 'plaintext-only'; } catch (_) {}
    if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
    el.focus();
    const sel = getSelection(); sel.selectAllChildren(el); sel.collapseToEnd();
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { editing.cancelled = true; el.blur(); }
      else if (e.key === 'Enter' && (single || e.ctrlKey || e.metaKey)) { e.preventDefault(); el.blur(); }
    };
    const onBlur = () => {
      el.removeEventListener('keydown', onKey, true);
      el.removeAttribute('contenteditable');
      const done = editing; editing = null;
      const v = el.textContent;
      if (done.cancelled) { el.textContent = done.orig; return; }
      if (v !== done.orig) { const h = host(); h && h.edit(done.id, done.path, v); }
      refresh();
    };
    el.addEventListener('keydown', onKey, true);
    el.addEventListener('blur', onBlur, { once: true });
  }

  // ---- keyboard (forwarded to the host) ----
  document.addEventListener('keydown', (e) => {
    if (editing) return;
    const h = host(); if (!h) return;
    if (h.key({ key: e.key, mod: e.ctrlKey || e.metaKey, shift: e.shiftKey })) e.preventDefault();
  });

  // ---- drag and drop ----
  const dragKind = (types) => { const t = Array.from(types || []); return t.includes('application/x-os-section') ? 'section' : t.includes('application/x-os-column') ? 'column' : t.includes('application/x-os-widget') ? 'widget' : null; };

  function computeTarget(kind, x, y) {
    const hit = document.elementFromPoint(x, y);
    const sections = Array.from(document.querySelectorAll('[data-type="section"]'));
    if (!sections.length) return { id: null, pos: 'end', rect: null, orient: 'h', label: 'Start here' };
    let sec = hit && hit.closest && hit.closest('[data-type="section"]');
    if (!sec) { // outside any section: snap to the nearest end
      const first = sections[0].getBoundingClientRect();
      return y < first.top ? { id: sections[0].dataset.node, pos: 'before', rect: first, orient: 'h', label: 'New section' } : { id: sections[sections.length - 1].dataset.node, pos: 'after', rect: sections[sections.length - 1].getBoundingClientRect(), orient: 'h', label: 'New section' };
    }
    const sr = sec.getBoundingClientRect();
    const asSection = (pos) => ({ id: sec.dataset.node, pos, rect: sr, orient: 'h', label: kind === 'section' ? 'Drop section' : 'New section' });
    if (kind === 'section') return asSection(y < sr.top + sr.height / 2 ? 'before' : 'after');
    if (y - sr.top < 18) return asSection('before');
    if (sr.bottom - y < 18) return asSection('after');
    const col = hit.closest('[data-type="column"]');
    if (kind === 'column') {
      if (!col) return asSection(y < sr.top + sr.height / 2 ? 'before' : 'after');
      const r = col.getBoundingClientRect();
      return { id: col.dataset.node, pos: x < r.left + r.width / 2 ? 'before' : 'after', rect: r, orient: 'v', label: '' };
    }
    if (!col) return asSection(y < sr.top + sr.height / 2 ? 'before' : 'after');
    const kids = Array.from(col.children).filter((c) => c.dataset && c.dataset.node);
    const cr = col.getBoundingClientRect();
    if (!kids.length) return { id: col.dataset.node, pos: 'inside', rect: cr, orient: 'box', label: '' };
    const row = getComputedStyle(col).flexDirection === 'row';
    for (const k of kids) {
      if (k.dataset.node === movingId) continue;
      const r = k.getBoundingClientRect();
      const before = row ? x < r.left + r.width / 2 : y < r.top + r.height / 2;
      const nearer = row ? x < r.right : y < r.bottom;
      if (before) return { id: k.dataset.node, pos: 'before', rect: r, orient: row ? 'v' : 'h', label: 'Drop here' };
      if (nearer) return { id: k.dataset.node, pos: 'after', rect: r, orient: row ? 'v' : 'h', label: 'Drop here' };
    }
    const last = kids[kids.length - 1], lr = last.getBoundingClientRect();
    return { id: last.dataset.node, pos: 'after', rect: lr, orient: row ? 'v' : 'h', label: 'Drop here' };
  }

  function showDrop(t) {
    if (!t || !t.rect) { hideDrop(); if (t) lastDrop = t; return; }
    lastDrop = t;
    const r = t.rect;
    if (t.orient === 'box') { line.style.display = 'none'; place(dropBox, r, 0); return; }
    dropBox.style.display = 'none';
    line.style.display = 'block';
    line.classList.toggle('os-v', t.orient === 'v');
    line.dataset.label = t.label || '';
    const edge = t.pos === 'before' ? 0 : 1;
    if (t.orient === 'h') { line.style.left = (r.left + scrollX) + 'px'; line.style.width = r.width + 'px'; line.style.height = '5px'; line.style.top = (r.top + scrollY + edge * r.height - 2.5) + 'px'; }
    else { line.style.top = (r.top + scrollY) + 'px'; line.style.height = r.height + 'px'; line.style.width = '5px'; line.style.left = (r.left + scrollX + edge * r.width - 2.5) + 'px'; }
  }

  document.addEventListener('dragover', (e) => {
    const kind = dragKind(e.dataTransfer && e.dataTransfer.types);
    if (!kind) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = movingId ? 'move' : 'copy';
    if (e.clientY < 70) scrollBy(0, -16); else if (e.clientY > innerHeight - 70) scrollBy(0, 16);
    showDrop(computeTarget(kind, e.clientX, e.clientY));
  });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) hideDrop(); });
  document.addEventListener('drop', (e) => {
    const kind = dragKind(e.dataTransfer && e.dataTransfer.types);
    if (!kind) return;
    e.preventDefault();
    const t = lastDrop || computeTarget(kind, e.clientX, e.clientY);
    const move = e.dataTransfer.getData('application/x-os-move') || null;
    let item = null;
    try { item = JSON.parse(e.dataTransfer.getData('application/x-os-' + kind) || 'null'); } catch (_) {}
    hideDrop(); movingId = null;
    const h = host(); h && h.drop({ kind, move, item: move ? null : item, targetId: t && t.id, pos: t && t.pos });
  });
  document.addEventListener('dragend', () => { hideDrop(); });
  // Inside the canvas nothing uses native drag (moves use pointer events below), so stop the browser dragging images or links.
  document.addEventListener('dragstart', (e) => { if (e.dataTransfer && !dragKind(e.dataTransfer.types)) e.preventDefault(); }, true);

  // ---- pointer-based moves: grab a widget (or the grip on any selection) and drag it ----
  let pd = null, suppressClick = false;
  const typeName = (el) => NAMES[typeOf(el)] || '';
  document.addEventListener('pointerdown', (e) => {
    if (mode !== 'edit' || editing || e.button !== 0) return;
    const t = e.target;
    if (!t.closest) return;
    let node = null;
    if (t.closest('.os-grip')) node = byId(selected);
    else if (!t.closest('#os-ov') && !t.closest('[contenteditable]')) { const n = t.closest('[data-node]'); if (n && kindOf(typeOf(n)) === 'widget') node = n; }
    if (node) pd = { node, id: node.dataset.node, x: e.clientX, y: e.clientY, active: false };
  }, true);
  document.addEventListener('pointermove', (e) => {
    if (!pd) return;
    if (!pd.active) {
      if (Math.hypot(e.clientX - pd.x, e.clientY - pd.y) < 6) return;
      pd.active = true; movingId = pd.id; pd.kind = kindOf(typeOf(pd.node));
      document.documentElement.classList.add('os-moving');
      pd.node.classList.add('os-dragging');
      ghost.innerHTML = '<i>' + ICON.grip + '</i>' + typeName(pd.node); ghost.style.display = 'block';
      hoverBox.style.display = 'none';
      const h = host(); if (h && selected !== pd.id) h.select(pd.id);
    }
    e.preventDefault();
    ghost.style.left = e.clientX + 'px'; ghost.style.top = e.clientY + 'px';
    if (e.clientY < 70) scrollBy(0, -16); else if (e.clientY > innerHeight - 70) scrollBy(0, 16);
    const t = computeTarget(pd.kind, e.clientX, e.clientY);
    const self = pd.node, target = t && t.id ? byId(t.id) : null;
    if (target && (target === self || self.contains(target))) { hideDrop(); return; }
    showDrop(t);
  }, true);
  const endMove = (commit) => {
    if (!pd) return;
    const st = pd; pd = null;
    if (!st.active) return;
    const t = lastDrop;
    document.documentElement.classList.remove('os-moving'); st.node.classList.remove('os-dragging');
    ghost.style.display = 'none'; hideDrop(); movingId = null;
    suppressClick = true; setTimeout(() => { suppressClick = false; }, 60);
    if (commit && t) { const h = host(); h && h.drop({ kind: st.kind, move: st.id, item: null, targetId: t.id, pos: t.pos }); }
  };
  document.addEventListener('pointerup', () => endMove(true), true);
  document.addEventListener('pointercancel', () => endMove(false), true);
  document.addEventListener('selectstart', (e) => { if (pd && pd.active) e.preventDefault(); }, true);
  document.addEventListener('keydown', (e) => { if (pd && pd.active && e.key === 'Escape') { e.stopPropagation(); endMove(false); } }, true);

  // ---- API for the host ----
  window.osEditor = {
    setSelected(id) { selected = id; selBox.dataset.for = ''; refresh(); },
    setHover(id) { hovered = byId(id); refresh(); },
    setMode(m) { mode = m; document.documentElement.classList.toggle('os-edit', m === 'edit'); refresh(); },
    refresh,
    scrollTo(id) { const el = byId(id); if (el) { const r = el.getBoundingClientRect(); if (r.top < 60 || r.bottom > innerHeight - 40) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } },
  };
  new ResizeObserver(refresh).observe(document.documentElement);
  addEventListener('resize', refresh);
  addEventListener('load', refresh);
})();
