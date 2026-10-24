'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const HDR = { 'X-Requested-With': 'matrix' };

  let me = null;
  let reactionList = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👀'];
  let replyTo = null;
  let pendingFiles = []; // File[]
  let lastJson = '';
  let firstRender = true;
  let stream = null;
  let sending = false;
  let channel = 'discussion';
  let allMessages = [];
  let seenIds = null;
  let nextPurge = null;
  let rec = null; // enregistrement vocal en cours

  // Un seul message vocal à la fois
  document.addEventListener('play', (e) => {
    for (const a of document.querySelectorAll('audio')) if (a !== e.target) a.pause();
  }, true);

  // ---------- Sons (synthétisés, aucun fichier) ----------
  const sounds = (() => {
    let ctx = null;
    let muted = false;
    try { muted = localStorage.getItem('muted') === '1'; } catch { /* ignore */ }
    function audio() {
      if (!ctx) {
        const C = window.AudioContext || window.webkitAudioContext;
        if (!C) return null;
        ctx = new C();
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    function tone(freq, start, dur, type, vol) {
      const c = audio();
      if (!c) return;
      const t = c.currentTime + start;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g);
      g.connect(c.destination);
      o.start(t);
      o.stop(t + dur + 0.02);
    }
    const play = (notes, type, vol) => { if (!muted) notes.forEach(([f, s, d]) => tone(f, s, d, type, vol)); };
    return {
      login: () => play([[440, 0, 0.09], [660, 0.09, 0.09], [880, 0.18, 0.18]], 'square', 0.05),
      logout: () => play([[660, 0, 0.09], [440, 0.09, 0.09], [330, 0.18, 0.18]], 'square', 0.05),
      send: () => play([[700, 0, 0.06], [1000, 0.06, 0.09]], 'square', 0.05),
      receive: () => play([[520, 0, 0.09], [780, 0.11, 0.14]], 'triangle', 0.1),
      react: () => play([[1100, 0, 0.06]], 'sine', 0.09),
      isMuted: () => muted,
      toggle() {
        muted = !muted;
        try { localStorage.setItem('muted', muted ? '1' : '0'); } catch { /* ignore */ }
        if (!muted) this.react();
        return muted;
      },
    };
  })();

  function updateSoundButton() {
    const b = $('#sound-btn');
    b.textContent = sounds.isMuted() ? '🔇' : '🔊';
    b.title = sounds.isMuted() ? 'Son coupé' : 'Son activé';
  }
  $('#sound-btn').addEventListener('click', () => { sounds.toggle(); updateSoundButton(); });
  updateSoundButton();

  // ---------- Appels API ----------
  async function api(method, url, body) {
    const opts = { method, headers: { ...HDR } };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(url, opts);
    let data = {};
    try { data = await r.json(); } catch { /* vide */ }
    if (r.status === 401 && url !== '/api/login') { showLogin(); throw new Error('Session expirée, reconnecte-toi.'); }
    if (!r.ok) throw new Error(data.error || 'Erreur');
    return data;
  }

  // ---------- Petits outils ----------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function formatTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const hm = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return hm;
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) + ' ' + hm;
  }
  function formatSize(n) {
    if (n < 1024) return n + ' o';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' Ko';
    return (n / 1024 / 1024).toFixed(1) + ' Mo';
  }

  // ---------- Écrans ----------
  function showLogin() {
    closeStream();
    me = null;
    document.body.classList.add('is-login');
    $('#chat').classList.add('hidden');
    $('#login').classList.remove('hidden');
    $('#password').value = '';
    $('#login-error').textContent = '';
    $('#username').focus();
  }

  async function showChat() {
    document.body.classList.remove('is-login');
    $('#login').classList.add('hidden');
    $('#chat').classList.remove('hidden');
    $('#who-name').textContent = '> ' + (me.displayName || me.username);
    $('#who-name').classList.toggle('is-admin', me.role === 'admin');
    $('#admin-btn').classList.toggle('hidden', me.role !== 'admin');
    firstRender = true;
    lastJson = '';
    seenIds = null;
    allMessages = [];
    channel = 'discussion';
    for (const d of document.querySelectorAll('.tab .dot')) d.classList.add('hidden');
    applyChannelUI();
    await loadMessages();
    openStream();
    if (me.firstLogin) showWelcome();
    else $('#text').focus();
  }

  // ---------- Message d'accueil (première connexion) ----------
  const welcome = $('#welcome-dialog');
  function showWelcome() {
    $('#welcome-name').textContent = me.displayName || me.username;
    welcome.showModal();
  }
  welcome.addEventListener('close', () => {
    if (!me || !me.firstLogin) return;
    me.firstLogin = false;
    api('POST', '/api/welcomed', {}).catch(() => {});
    $('#text').focus();
  });
  $('#welcome-ok').addEventListener('click', () => welcome.close());

  function openStream() {
    closeStream();
    startPolling();
    stream = new EventSource('/api/stream');
    stream.addEventListener('update', () => poll());
    stream.onerror = () => {
      // Si la session n'est plus valide, retour à la connexion
      fetch('/api/me', { headers: HDR }).then((r) => { if (r.status === 401) showLogin(); });
    };
  }
  function closeStream() {
    if (stream) { stream.close(); stream = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (rec) rec.stop();
  }

  // ---------- Actualisation automatique ----------
  // En plus du flux en direct, on vérifie toutes les 2 secondes s'il y a du nouveau
  // (certains réseaux, tunnels ou téléphones coupent le flux en direct).
  let pollTimer = null;
  let polling = false;
  let lastVersion = null;
  async function poll() {
    if (!me || polling) return;
    polling = true;
    try {
      const r = await fetch('/api/version', { headers: HDR, cache: 'no-store' });
      if (r.status === 401) { showLogin(); return; }
      const d = await r.json();
      if (d.v !== lastVersion) { await loadMessages(); lastVersion = d.v; }
    } catch { /* réseau coupé : on réessaie au prochain tour */ }
    finally { polling = false; }
  }
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    lastVersion = null;
    pollTimer = setInterval(poll, 2000);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  addEventListener('online', poll);
  addEventListener('focus', poll);

  // ---------- Messages ----------
  async function loadMessages() {
    const data = await api('GET', '/api/messages');
    nextPurge = data.nextPurge;
    updatePurgeNote();
    const json = JSON.stringify(data.messages);
    if (json === lastJson) return;
    lastJson = json;
    const incoming = data.messages;
    if (seenIds) {
      const fresh = incoming.filter((m) => !seenIds.has(m.id) && m.userId !== me.id);
      if (fresh.length) {
        for (const m of fresh) if (m.channel !== channel) $(`#tab-${m.channel} .dot`).classList.remove('hidden');
        sounds.receive();
      }
    }
    seenIds = new Set(incoming.map((m) => m.id));
    allMessages = incoming;
    render();
  }

  // ---------- Compte à rebours avant l'effacement de DISCUSSION ----------
  function updatePurgeNote() {
    const p = $('#purge-note');
    if (channel !== 'discussion' || !nextPurge) { p.classList.add('hidden'); return; }
    const ms = nextPurge - Date.now();
    let when;
    if (ms <= 60000) when = 'dans moins d\'une minute';
    else {
      const d = Math.floor(ms / 86400000);
      const h = Math.floor((ms % 86400000) / 3600000);
      const mi = Math.floor((ms % 3600000) / 60000);
      when = 'dans ' + (d ? `${d} j ${h} h` : h ? `${h} h ${mi} min` : `${mi} min`);
    }
    p.textContent = `> cette discussion sera entièrement effacée ${when} (tous les 2 jours)`;
    p.classList.remove('hidden');
  }
  setInterval(updatePurgeNote, 30000);

  function render() { renderMessages(allMessages.filter((m) => m.channel === channel)); }

  // ---------- Catégories (DISCUSSION / ANNONCE) ----------
  const canWrite = () => channel !== 'annonce' || (me && me.role === 'admin');
  function applyChannelUI() {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.channel === channel);
    const writable = canWrite();
    $('#composer').classList.toggle('hidden', !writable);
    $('#readonly-note').classList.toggle('hidden', writable);
  }
  function setChannel(c) {
    if (c === channel) return;
    channel = c;
    $(`#tab-${c} .dot`).classList.add('hidden');
    clearReply();
    $('#send-error').textContent = '';
    firstRender = true;
    applyChannelUI();
    updatePurgeNote();
    render();
    if (canWrite()) $('#text').focus();
  }
  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => setChannel(t.dataset.channel));

  function renderMessages(list) {
    const box = $('#messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    if (!list.length) {
      const e = el('div', 'empty', '> aucun message pour l\'instant.\n> écris le premier.');
      e.style.whiteSpace = 'pre-line';
      box.replaceChildren(e);
      return;
    }
    for (const e of box.querySelectorAll('.empty')) e.remove();

    // Mise à jour « douce » : les messages inchangés ne sont pas touchés,
    // pour ne pas couper un message vocal en cours d'écoute.
    const existing = new Map();
    for (const c of [...box.children]) if (c.dataset.id) existing.set(c.dataset.id, c);
    const wanted = new Set(list.map((m) => m.id));
    for (const [id, node] of existing) if (!wanted.has(id)) { node.remove(); existing.delete(id); }
    let cursor = box.firstElementChild;
    for (const m of list) {
      const { reactions, ...rest } = m;
      const bsig = JSON.stringify(rest);
      const rsig = JSON.stringify(reactions);
      let node = existing.get(m.id);
      if (node && node.dataset.sig !== bsig) {
        const fresh = renderMessage(m);
        fresh.dataset.sig = bsig; fresh.dataset.rsig = rsig;
        if (node === cursor) cursor = fresh;
        node.replaceWith(fresh);
        node = fresh;
      } else if (node && node.dataset.rsig !== rsig) {
        node.querySelector('.msg-foot').replaceWith(buildFoot(m));
        node.dataset.rsig = rsig;
      } else if (!node) {
        node = renderMessage(m);
        node.dataset.sig = bsig; node.dataset.rsig = rsig;
      }
      if (node === cursor) cursor = cursor.nextElementSibling;
      else box.insertBefore(node, cursor);
    }
    if (firstRender || nearBottom) {
      box.style.scrollBehavior = 'auto';
      box.scrollTop = box.scrollHeight;
      box.style.scrollBehavior = '';
    }
    firstRender = false;
  }

  function renderMessage(m) {
    const mine = m.userId === me.id;
    const root = el('article', 'msg' + (mine ? ' mine' : '') + (m.isAdmin ? ' admin' : ''));
    root.dataset.id = m.id;

    const head = el('div', 'msg-head');
    head.append(el('span', 'msg-author', m.author), el('span', 'msg-time', formatTime(m.createdAt)));
    root.append(head);

    if (m.reply) {
      if (m.reply.deleted) {
        root.append(el('div', 'quote gone', '↩ message supprimé'));
      } else {
        const q = el('button', 'quote');
        q.type = 'button';
        const b = el('b', m.reply.isAdmin ? 'is-admin' : null, m.reply.author);
        q.append('↩ ', b, ' : ' + m.reply.text);
        q.addEventListener('click', () => jumpTo(m.reply.id));
        root.append(q);
      }
    }

    if (m.text) root.append(el('div', 'msg-text', m.text));

    if (m.attachments.length) {
      const wrap = el('div', 'attachments');
      for (const a of m.attachments) {
        const url = '/api/files/' + encodeURIComponent(a.id);
        if (a.isImage) {
          const link = el('a');
          link.href = url; link.target = '_blank'; link.rel = 'noopener';
          const img = document.createElement('img');
          img.src = url; img.alt = a.name; img.loading = 'lazy';
          link.append(img);
          wrap.append(link);
        } else if (a.isAudio) {
          const voice = el('div', 'voice');
          voice.append(el('span', 'voice-label', '🎤 message vocal'));
          const au = document.createElement('audio');
          au.controls = true; au.preload = 'metadata'; au.src = url;
          voice.append(au);
          wrap.append(voice);
        } else {
          const link = el('a', 'file-chip');
          link.href = url; link.setAttribute('download', a.name);
          link.append(el('span', null, '📄'), el('span', 'name', a.name), el('small', null, formatSize(a.size)));
          wrap.append(link);
        }
      }
      root.append(wrap);
    }

    root.append(buildFoot(m));
    return root;
  }

  function buildFoot(m) {
    const foot = el('div', 'msg-foot');
    for (const r of m.reactions) {
      const b = el('button', 'reaction' + (r.mine ? ' mine' : ''), r.emoji + ' ' + r.count);
      b.type = 'button';
      b.title = r.users.join(', ');
      b.addEventListener('click', () => react(m.id, r.emoji));
      foot.append(b);
    }
    const add = el('button', 'action', '☺ réagir');
    add.type = 'button';
    add.addEventListener('click', () => togglePicker(add.closest('.msg'), m.id));
    const rep = el('button', 'action', '↩ répondre');
    rep.type = 'button';
    rep.addEventListener('click', () => setReply(m));
    foot.append(add);
    if (m.channel !== 'annonce' || me.role === 'admin') foot.append(rep);
    if (m.canDelete) {
      foot.append(el('span', 'spacer'));
      const del = el('button', 'action danger', 'supprimer');
      del.type = 'button';
      del.addEventListener('click', async () => {
        if (!confirm('Supprimer ce message pour tout le monde ?')) return;
        try { await api('DELETE', '/api/messages/' + m.id); } catch (e) { alert(e.message); }
      });
      foot.append(del);
    }
    return foot;
  }

  function buildPicker(id) {
    const p = el('div', 'picker');
    for (const emoji of reactionList) {
      const b = el('button', null, emoji);
      b.type = 'button';
      b.addEventListener('click', () => react(id, emoji));
      p.append(b);
    }
    return p;
  }
  function togglePicker(root, id) {
    const existing = root.querySelector('.picker');
    if (existing) existing.remove(); else root.append(buildPicker(id));
  }
  async function react(id, emoji) {
    try { await api('POST', `/api/messages/${id}/reactions`, { emoji }); sounds.react(); } catch (e) { alert(e.message); }
  }

  function jumpTo(id) {
    const target = document.querySelector(`.msg[data-id="${CSS.escape(id)}"]`);
    if (!target) return;
    target.scrollIntoView({ block: 'center' });
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
  }

  // ---------- Réponse ----------
  function setReply(m) {
    replyTo = m;
    $('#reply-author').textContent = m.author;
    $('#reply-text').textContent = m.text ? m.text.slice(0, 80) : '[pièce jointe]';
    $('#reply-bar').classList.remove('hidden');
    $('#text').focus();
  }
  function clearReply() { replyTo = null; $('#reply-bar').classList.add('hidden'); }
  $('#reply-cancel').addEventListener('click', clearReply);

  // ---------- Pièces jointes ----------
  const MAX_FILE = 10 * 1024 * 1024;
  function renderPending() {
    const box = $('#pending-files');
    box.replaceChildren(...pendingFiles.map((f, i) => {
      const chip = el('span', 'file-chip');
      const x = el('button', 'icon-btn', '✕');
      x.type = 'button';
      x.setAttribute('aria-label', 'Retirer ' + f.name);
      x.addEventListener('click', () => { pendingFiles.splice(i, 1); renderPending(); });
      const voice = f.type.startsWith('audio/');
      chip.append(el('span', null, voice ? '🎤' : '📎'), el('span', 'name', voice ? 'message vocal' : f.name), el('small', null, formatSize(f.size)), x);
      return chip;
    }));
  }
  $('#attach-btn').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => {
    $('#send-error').textContent = '';
    for (const f of e.target.files) {
      if (f.size > MAX_FILE) { $('#send-error').textContent = `« ${f.name} » dépasse 10 Mo.`; continue; }
      if (!f.size) { $('#send-error').textContent = `« ${f.name} » est vide.`; continue; }
      if (pendingFiles.length >= 5) { $('#send-error').textContent = '5 pièces jointes maximum par message.'; break; }
      pendingFiles.push(f);
    }
    e.target.value = '';
    renderPending();
  });

  // ---------- Messages vocaux ----------
  const micBtn = $('#mic-btn');
  const MAX_VOICE_SECONDS = 300;
  if (!window.MediaRecorder) micBtn.classList.add('hidden');

  function stopRecordingUI() {
    micBtn.textContent = '🎤';
    micBtn.classList.remove('recording');
    micBtn.setAttribute('aria-label', 'Enregistrer un message vocal');
    $('#rec-note').classList.add('hidden');
  }

  async function toggleRecording() {
    if (rec) { rec.stop(); return; }
    const err = $('#send-error');
    err.textContent = '';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      err.textContent = 'Le micro ne marche que sur une connexion sécurisée (adresse en https).';
      return;
    }
    if (pendingFiles.length >= 5) { err.textContent = '5 pièces jointes maximum par message.'; return; }
    let media;
    try { media = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { err.textContent = 'Micro refusé ou introuvable : autorise le micro pour ce site dans ton navigateur.'; return; }

    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t));
    let mr;
    try { mr = type ? new MediaRecorder(media, { mimeType: type }) : new MediaRecorder(media); }
    catch { media.getTracks().forEach((t) => t.stop()); err.textContent = 'Enregistrement vocal non pris en charge par ce navigateur.'; return; }

    const chunks = [];
    const started = Date.now();
    const note = $('#rec-note');
    const tick = () => {
      const s = Math.floor((Date.now() - started) / 1000);
      note.textContent = `● enregistrement ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}  — appuie sur ⏹ pour terminer`;
      if (s >= MAX_VOICE_SECONDS && rec) rec.stop();
    };
    const timer = setInterval(tick, 500);
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = () => {
      clearInterval(timer);
      media.getTracks().forEach((t) => t.stop());
      rec = null;
      stopRecordingUI();
      const mime = mr.mimeType || type || 'audio/webm';
      const blob = new Blob(chunks, { type: mime });
      if (!blob.size) return;
      if (blob.size > MAX_FILE) { err.textContent = 'Message vocal trop long (10 Mo max).'; return; }
      const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
      pendingFiles.push(new File([blob], `vocal-${Date.now()}.${ext}`, { type: mime }));
      renderPending();
    };
    rec = mr;
    mr.start();
    micBtn.textContent = '⏹';
    micBtn.classList.add('recording');
    micBtn.setAttribute('aria-label', 'Arrêter l\'enregistrement');
    note.classList.remove('hidden');
    tick();
  }
  micBtn.addEventListener('click', toggleRecording);

  // ---------- Envoi ----------
  async function sendMessage() {
    if (sending) return;
    const text = $('#text').value.trim();
    if (!text && !pendingFiles.length) return;
    sending = true;
    $('#send-btn').disabled = true;
    $('#send-error').textContent = '';
    try {
      const ids = [];
      for (const f of pendingFiles) {
        const r = await fetch('/api/upload?name=' + encodeURIComponent(f.name), {
          method: 'POST',
          headers: { ...HDR, 'Content-Type': 'application/octet-stream' },
          body: f,
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Envoi du fichier impossible.');
        ids.push(d.id);
      }
      await api('POST', '/api/messages', { channel, text, replyTo: replyTo ? replyTo.id : null, attachments: ids });
      sounds.send();
      $('#text').value = '';
      autosize();
      pendingFiles = [];
      renderPending();
      clearReply();
      firstRender = true; // descend en bas après un envoi
      await loadMessages();
    } catch (e) {
      $('#send-error').textContent = e.message;
    } finally {
      sending = false;
      $('#send-btn').disabled = false;
      $('#text').focus();
    }
  }
  $('#send-btn').addEventListener('click', sendMessage);
  $('#text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
  });
  function autosize() {
    const t = $('#text');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 160) + 'px';
  }
  $('#text').addEventListener('input', autosize);

  // ---------- Connexion ----------
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-error');
    err.textContent = '';
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await api('POST', '/api/login', { username: $('#username').value, password: $('#password').value });
      me = await api('GET', '/api/me');
      reactionList = me.reactions || reactionList;
      sounds.login();
      await showChat();
    } catch (ex) {
      err.textContent = '> ' + ex.message;
      $('#password').value = '';
    } finally { btn.disabled = false; }
  });

  $('#logout-btn').addEventListener('click', async () => {
    try { await api('POST', '/api/logout', {}); } catch { /* ignore */ }
    sounds.logout();
    showLogin();
  });

  // ---------- Administration ----------
  const dialog = $('#admin-dialog');
  $('#admin-btn').addEventListener('click', () => { dialog.showModal(); loadUsers(); });
  $('#admin-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

  function randomPassword() {
    const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint32Array(12));
    return Array.from(bytes, (n) => chars[n % chars.length]).join('');
  }
  $('#gen-btn').addEventListener('click', () => { $('#new-password').value = randomPassword(); });

  $('#create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#create-error');
    err.textContent = '';
    $('#create-ok').classList.add('hidden');
    const username = $('#new-username').value.trim();
    const password = $('#new-password').value;
    try {
      await api('POST', '/api/admin/users', { username, password });
      $('#ok-user').textContent = username;
      $('#ok-pass').textContent = password;
      $('#create-ok').classList.remove('hidden');
      $('#new-username').value = '';
      $('#new-password').value = '';
      loadUsers();
    } catch (ex) { err.textContent = '> ' + ex.message; }
  });

  $('#copy-btn').addEventListener('click', async () => {
    const txt = `Identifiant : ${$('#ok-user').textContent}\nMot de passe : ${$('#ok-pass').textContent}`;
    try { await navigator.clipboard.writeText(txt); $('#copy-btn').textContent = 'COPIÉ ✓'; setTimeout(() => { $('#copy-btn').textContent = 'COPIER'; }, 1500); }
    catch { $('#copy-btn').textContent = 'copie manuelle'; }
  });

  async function loadUsers() {
    const list = $('#user-list');
    $('#admin-error').textContent = '';
    try {
      const { users } = await api('GET', '/api/admin/users');
      list.replaceChildren(...users.map(renderUserRow));
    } catch (e) { $('#admin-error').textContent = '> ' + e.message; }
  }

  function renderUserRow(u) {
    const li = el('li');
    li.append(el('span', 'uname' + (u.role === 'admin' ? ' is-admin' : ''), u.role === 'admin' ? `Morpheus (identifiant : ${u.username})` : u.username));
    if (u.role === 'admin') li.append(el('span', 'badge', 'admin'));

    const pwBtn = el('button', 'btn small', 'MOT DE PASSE');
    pwBtn.type = 'button';
    pwBtn.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'text'; input.placeholder = 'nouveau mot de passe'; input.spellcheck = false;
      const ok = el('button', 'btn primary small', 'OK');
      ok.type = 'button';
      const cancel = el('button', 'btn small', '✕');
      cancel.type = 'button';
      cancel.addEventListener('click', loadUsers);
      ok.addEventListener('click', async () => {
        try {
          await api('PATCH', '/api/admin/users/' + u.id, { password: input.value });
          $('#ok-user').textContent = u.username;
          $('#ok-pass').textContent = input.value;
          $('#create-ok').classList.remove('hidden');
          loadUsers();
        } catch (ex) { $('#admin-error').textContent = '> ' + ex.message; }
      });
      li.replaceChildren(el('span', 'uname', u.role === 'admin' ? 'Morpheus' : u.username), input, ok, cancel);
      input.focus();
    });
    li.append(pwBtn);

    if (u.id !== me.id) {
      const del = el('button', 'btn small', 'SUPPRIMER');
      del.type = 'button';
      del.addEventListener('click', async () => {
        if (!confirm(`Supprimer l'accès de « ${u.username} » ? Cette personne ne pourra plus se connecter (ses anciens messages restent visibles).`)) return;
        try { await api('DELETE', '/api/admin/users/' + u.id); loadUsers(); } catch (ex) { $('#admin-error').textContent = '> ' + ex.message; }
      });
      li.append(del);
    }
    return li;
  }

  // ---------- Pluie de code façon Matrix ----------
  (function rain() {
    const canvas = $('#rain');
    const ctx = canvas.getContext('2d');
    const glyphs = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789ABCDEFZ:.=*+-<>'.split('');
    const size = 16;
    let cols = 0;
    let drops = [];
    function resize() {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = innerWidth * dpr;
      canvas.height = innerHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(innerWidth / size);
      drops = Array.from({ length: cols }, () => Math.random() * -50);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, innerWidth, innerHeight);
    }
    function frame() {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
      ctx.fillRect(0, 0, innerWidth, innerHeight);
      ctx.font = size + 'px monospace';
      for (let i = 0; i < cols; i++) {
        const y = drops[i] * size;
        ctx.fillStyle = Math.random() > 0.96 ? '#d6ffe0' : '#00ff41';
        ctx.fillText(glyphs[(Math.random() * glyphs.length) | 0], i * size, y);
        if (y > innerHeight && Math.random() > 0.975) drops[i] = 0;
        drops[i]++;
      }
    }
    resize();
    addEventListener('resize', resize);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (let k = 0; k < 120; k++) frame(); // image fixe
      return;
    }
    let timer = setInterval(frame, 55);
    document.addEventListener('visibilitychange', () => {
      clearInterval(timer);
      if (!document.hidden) timer = setInterval(frame, 55);
    });
  })();

  // ---------- Démarrage ----------
  (async function init() {
    try {
      me = await api('GET', '/api/me');
      reactionList = me.reactions || reactionList;
      await showChat();
    } catch { showLogin(); }
  })();
})();
