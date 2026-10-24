'use strict';
/*
 * Messagerie privée « Matrix »
 * - Aucun compte public : seul l'administrateur crée les identifiants.
 * - Un seul fil de discussion partagé par tous les membres connectés.
 * - Réponses, réactions, pièces jointes, mise à jour en temps réel.
 * Aucune dépendance externe : uniquement Node.js (>= 18).
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { hashPassword, verifyPassword } = require('./lib');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_FILE = 10 * 1024 * 1024; // 10 Mo par fichier
const MAX_FILES_PER_MESSAGE = 5;
const MAX_TEXT = 4000;
const SESSION_MS = 30 * 24 * 3600 * 1000;
const CHANNELS = ['discussion', 'annonce'];
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👀'];
const AUDIO_TYPES = {
  '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aac': 'audio/aac',
};
const IMAGE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
};

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- Base de données (fichier JSON) ----------
let db = { users: [], messages: [], sessions: {}, pending: {} };
if (fs.existsSync(DB_FILE)) {
  db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
}
function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
const uid = (n = 12) => crypto.randomBytes(n).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
// L'administrateur est toujours affiché sous le nom « Morpheus » (son identifiant de connexion reste privé).
const ADMIN_DISPLAY = 'Morpheus';
const displayName = (u) => (u.role === 'admin' ? ADMIN_DISPLAY : u.username);
const nameOf = (id) => { const u = db.users.find((x) => x.id === id); return u ? displayName(u) : 'ancien membre'; };
const isAdminId = (id) => { const u = db.users.find((x) => x.id === id); return !!u && u.role === 'admin'; };
const authorOf = (m) => { const u = db.users.find((x) => x.id === m.userId); return u ? displayName(u) : m.author; };

// ---------- Utilitaires HTTP ----------
function send(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}
const fail = (res, status, error) => send(res, status, { error });

function readJson(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('too big'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

function isHttps(req) {
  return TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https';
}

function currentUser(req) {
  const token = getCookie(req, 'sid');
  if (!token) return null;
  const key = sha(token);
  const s = db.sessions[key];
  if (!s) return null;
  if (Date.now() - s.created > SESSION_MS) { delete db.sessions[key]; save(); return null; }
  const user = db.users.find((u) => u.id === s.userId);
  if (!user) return null;
  return { user, sessionKey: key };
}

// ---------- Anti force brute sur la connexion ----------
const attempts = new Map(); // ip -> {count, first}
const WINDOW = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;
function tooManyAttempts(ip) {
  const a = attempts.get(ip);
  if (!a) return false;
  if (Date.now() - a.first > WINDOW) { attempts.delete(ip); return false; }
  return a.count >= MAX_ATTEMPTS;
}
function recordFailure(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() - a.first > WINDOW) attempts.set(ip, { count: 1, first: Date.now() });
  else a.count++;
}
setInterval(() => { for (const [ip, a] of attempts) if (Date.now() - a.first > WINDOW) attempts.delete(ip); }, 60000).unref();

// ---------- Temps réel (Server-Sent Events) ----------
const streams = new Set(); // {res, userId}
// Numéro de version : change à chaque modification, les navigateurs le consultent toutes les 2 s
const bootId = crypto.randomBytes(4).toString('hex');
let versionN = 0;
function broadcast() {
  versionN++;
  for (const c of streams) c.res.write('event: update\ndata: {}\n\n');
}
setInterval(() => { for (const c of streams) c.res.write(': ping\n\n'); }, 25000).unref();

function dropUserStreams(userId) {
  for (const c of [...streams]) if (c.userId === userId) { streams.delete(c); c.res.end(); }
}

// ---------- Mise en forme des messages ----------
function serialize(m, me) {
  const reactions = Object.entries(m.reactions || {})
    .filter(([, ids]) => ids.length)
    .map(([emoji, ids]) => ({ emoji, count: ids.length, mine: ids.includes(me.id), users: ids.map(nameOf) }));
  let reply = null;
  if (m.replyTo) {
    const o = db.messages.find((x) => x.id === m.replyTo);
    reply = o
      ? { id: o.id, author: authorOf(o), isAdmin: isAdminId(o.userId), text: (o.text || (o.attachments.length ? '[pièce jointe]' : '')).slice(0, 140) }
      : { id: m.replyTo, deleted: true };
  }
  return {
    id: m.id,
    channel: m.channel || 'discussion',
    userId: m.userId,
    author: authorOf(m),
    isAdmin: isAdminId(m.userId),
    text: m.text,
    createdAt: m.createdAt,
    reply,
    reactions,
    attachments: m.attachments.map((a) => {
      const ext = path.extname(a.name).toLowerCase();
      return { id: a.id, name: a.name, size: a.size, isImage: !!IMAGE_TYPES[ext], isAudio: !!AUDIO_TYPES[ext] };
    }),
    canDelete: m.userId === me.id || me.role === 'admin',
  };
}

function removeMessageFiles(m) {
  for (const a of m.attachments) fs.unlink(path.join(UPLOAD_DIR, a.id), () => {});
}

// ---------- Effacement automatique de DISCUSSION tous les 2 jours ----------
// Tout le fil DISCUSSION (messages de l'admin compris, avec leurs fichiers) est supprimé.
// ANNONCE n'est jamais touchée.
const PURGE_MS = 2 * 24 * 3600 * 1000;
function purgeDiscussion() {
  const keep = [];
  for (const m of db.messages) {
    if ((m.channel || 'discussion') === 'discussion') removeMessageFiles(m);
    else keep.push(m);
  }
  db.messages = keep;
}
function checkPurge() {
  const now = Date.now();
  if (!db.nextPurge) { db.nextPurge = now + PURGE_MS; save(); return; }
  if (now < db.nextPurge) return;
  purgeDiscussion();
  while (db.nextPurge <= now) db.nextPurge += PURGE_MS; // garde le rythme de 2 jours
  save();
  broadcast();
}

function cleanName(raw) {
  let n = '';
  try { n = decodeURIComponent(String(raw || '')); } catch { n = String(raw || ''); }
  n = n.replace(/[\\/\0-\x1f\x7f"<>:*?|]/g, '_').trim().slice(0, 120);
  return n || 'fichier';
}

// ---------- Routes ----------
const routes = [];
function route(method, pattern, opts, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, opts, handler });
}

// Connexion / déconnexion
route('POST', '/api/login', {}, async (req, res) => {
  const ip = clientIp(req);
  if (tooManyAttempts(ip)) return fail(res, 429, 'Trop de tentatives. Réessaie dans quelques minutes.');
  const body = await readJson(req);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const user = db.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  const ok = await verifyPassword(password, user ? user.passwordHash : DUMMY_HASH);
  if (!user || !ok) {
    recordFailure(ip);
    return fail(res, 401, 'Identifiant ou mot de passe incorrect.');
  }
  attempts.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[sha(token)] = { userId: user.id, created: Date.now() };
  save();
  const cookie = `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${isHttps(req) ? '; Secure' : ''}`;
  send(res, 200, { ok: true, username: user.username, role: user.role }, { 'Set-Cookie': cookie });
});

route('POST', '/api/logout', { auth: true }, async (req, res, ctx) => {
  delete db.sessions[ctx.sessionKey];
  save();
  send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
});

route('GET', '/api/me', { auth: true }, async (req, res, ctx) => {
  send(res, 200, {
    id: ctx.user.id, username: ctx.user.username, displayName: displayName(ctx.user), role: ctx.user.role, reactions: REACTIONS,
    firstLogin: ctx.user.role !== 'admin' && !ctx.user.welcomed,
  });
});

// Le message d'accueil a été lu : il ne sera plus affiché
route('POST', '/api/welcomed', { auth: true }, async (req, res, ctx) => {
  ctx.user.welcomed = true;
  save();
  send(res, 200, { ok: true });
});

// Flux temps réel
route('GET', '/api/stream', { auth: true }, async (req, res, ctx) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const c = { res, userId: ctx.user.id };
  streams.add(c);
  req.on('close', () => streams.delete(c));
});

route('GET', '/api/version', { auth: true }, async (req, res) => {
  send(res, 200, { v: `${bootId}.${versionN}` });
});

// Messages
route('GET', '/api/messages', { auth: true }, async (req, res, ctx) => {
  const list = db.messages.slice(-500).map((m) => serialize(m, ctx.user));
  send(res, 200, { messages: list, nextPurge: db.nextPurge || null });
});

route('POST', '/api/messages', { auth: true }, async (req, res, ctx) => {
  const body = await readJson(req);
  const channel = body.channel === undefined ? 'discussion' : String(body.channel);
  if (!CHANNELS.includes(channel)) return fail(res, 400, 'Catégorie inconnue.');
  if (channel === 'annonce' && ctx.user.role !== 'admin') return fail(res, 403, 'Seul l\'administrateur peut écrire dans ANNONCE.');
  const text = String(body.text || '').replace(/\r\n/g, '\n').trim();
  if (text.length > MAX_TEXT) return fail(res, 400, `Message trop long (${MAX_TEXT} caractères max).`);
  const ids = Array.isArray(body.attachments) ? body.attachments.map(String).slice(0, MAX_FILES_PER_MESSAGE) : [];
  const attachments = [];
  for (const id of ids) {
    const p = db.pending[id];
    if (!p || p.userId !== ctx.user.id) return fail(res, 400, 'Pièce jointe invalide.');
    attachments.push({ id, name: p.name, size: p.size });
  }
  if (!text && !attachments.length) return fail(res, 400, 'Message vide.');
  let replyTo = null;
  if (body.replyTo) {
    const target = db.messages.find((m) => m.id === String(body.replyTo));
    if (!target || (target.channel || 'discussion') !== channel) return fail(res, 400, 'Message introuvable.');
    replyTo = target.id;
  }
  for (const a of attachments) delete db.pending[a.id];
  const m = {
    id: uid(8), userId: ctx.user.id, author: displayName(ctx.user), channel, text,
    replyTo, attachments, reactions: {}, createdAt: Date.now(),
  };
  db.messages.push(m);
  save();
  broadcast();
  send(res, 201, { ok: true, id: m.id });
});

route('DELETE', '/api/messages/:id', { auth: true }, async (req, res, ctx, p) => {
  const i = db.messages.findIndex((m) => m.id === p.id);
  if (i < 0) return fail(res, 404, 'Message introuvable.');
  const m = db.messages[i];
  if (m.userId !== ctx.user.id && ctx.user.role !== 'admin') return fail(res, 403, 'Interdit.');
  db.messages.splice(i, 1);
  removeMessageFiles(m);
  save();
  broadcast();
  send(res, 200, { ok: true });
});

route('POST', '/api/messages/:id/reactions', { auth: true }, async (req, res, ctx, p) => {
  const body = await readJson(req);
  const emoji = String(body.emoji || '');
  if (!REACTIONS.includes(emoji)) return fail(res, 400, 'Réaction non autorisée.');
  const m = db.messages.find((x) => x.id === p.id);
  if (!m) return fail(res, 404, 'Message introuvable.');
  m.reactions = m.reactions || {};
  const list = (m.reactions[emoji] = m.reactions[emoji] || []);
  const i = list.indexOf(ctx.user.id);
  if (i >= 0) list.splice(i, 1); else list.push(ctx.user.id);
  if (!list.length) delete m.reactions[emoji];
  save();
  broadcast();
  send(res, 200, { ok: true });
});

// Pièces jointes : envoi du fichier brut, puis rattachement au message
route('POST', '/api/upload', { auth: true, raw: true }, async (req, res, ctx) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const name = cleanName(q.get('name'));
  const declared = Number(req.headers['content-length']);
  const mine = Object.values(db.pending).filter((p) => p.userId === ctx.user.id).length;
  if (mine >= 10) return fail(res, 429, 'Trop de fichiers en attente.');
  if (!declared) return fail(res, 411, 'Taille du fichier manquante.');
  if (declared > MAX_FILE) {
    res.on('finish', () => req.destroy());
    return fail(res, 413, 'Fichier trop volumineux (10 Mo max).');
  }
  const id = uid(16);
  const file = path.join(UPLOAD_DIR, id);
  const ws = fs.createWriteStream(file, { flags: 'wx' });
  let size = 0;
  let aborted = false;
  const abort = (status, msg) => {
    if (aborted) return;
    aborted = true;
    ws.destroy();
    fs.unlink(file, () => {});
    if (!res.headersSent) fail(res, status, msg);
    req.destroy();
  };
  ws.on('error', () => abort(500, 'Erreur d\'enregistrement.'));
  req.on('data', (c) => { size += c.length; if (size > MAX_FILE) abort(413, 'Fichier trop volumineux (10 Mo max).'); });
  req.on('aborted', () => abort(400, 'Envoi interrompu.'));
  req.pipe(ws);
  ws.on('finish', () => {
    if (aborted) return;
    if (!size) { fs.unlink(file, () => {}); return fail(res, 400, 'Fichier vide.'); }
    db.pending[id] = { userId: ctx.user.id, name, size, created: Date.now() };
    save();
    send(res, 201, { id, name, size });
  });
});

route('GET', '/api/files/:id', { auth: true }, async (req, res, ctx, p) => {
  let att = null;
  for (const m of db.messages) { att = m.attachments.find((a) => a.id === p.id); if (att) break; }
  if (!att || !/^[a-f0-9]+$/.test(att.id)) return fail(res, 404, 'Fichier introuvable.');
  const file = path.join(UPLOAD_DIR, att.id);
  if (!fs.existsSync(file)) return fail(res, 404, 'Fichier introuvable.');
  const ext = path.extname(att.name).toLowerCase();
  const inlineType = IMAGE_TYPES[ext] || AUDIO_TYPES[ext];
  const encoded = encodeURIComponent(att.name).replace(/['()]/g, escape);
  const size = fs.statSync(file).size;

  // Lecture par morceaux (« Range ») : obligatoire pour que les vocaux marchent sur iPhone / Safari
  let status = 200;
  let start = 0;
  let end = size - 1;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] !== '' || range[2] !== '')) {
    if (range[1] === '') { start = Math.max(0, size - Number(range[2])); }
    else { start = Number(range[1]); if (range[2] !== '') end = Math.min(Number(range[2]), size - 1); }
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    status = 206;
  }
  const headers = {
    'Content-Type': inlineType || 'application/octet-stream',
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `${inlineType ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`,
    'Cache-Control': 'private, max-age=3600',
    'Content-Security-Policy': 'sandbox; default-src \'none\'',
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);
  fs.createReadStream(file, { start, end }).pipe(res);
});

// Administration des comptes
route('GET', '/api/admin/users', { auth: true, admin: true }, async (req, res) => {
  send(res, 200, { users: db.users.map((u) => ({ id: u.id, username: u.username, role: u.role, createdAt: u.createdAt })) });
});

const validUsername = (s) => /^[A-Za-z0-9_.-]{3,24}$/.test(s);
const validPassword = (s) => typeof s === 'string' && s.length >= 6 && s.length <= 100;

route('POST', '/api/admin/users', { auth: true, admin: true }, async (req, res) => {
  const body = await readJson(req);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!validUsername(username)) return fail(res, 400, 'Identifiant : 3 à 24 caractères (lettres, chiffres, . _ -).');
  if (!validPassword(password)) return fail(res, 400, 'Mot de passe : 6 caractères minimum.');
  if (username.toLowerCase() === ADMIN_DISPLAY.toLowerCase()) return fail(res, 409, 'Ce pseudo est réservé.');
  if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) return fail(res, 409, 'Cet identifiant existe déjà.');
  db.users.push({ id: uid(8), username, passwordHash: await hashPassword(password), role: 'user', createdAt: Date.now() });
  save();
  send(res, 201, { ok: true });
});

route('PATCH', '/api/admin/users/:id', { auth: true, admin: true }, async (req, res, ctx, p) => {
  const body = await readJson(req);
  const u = db.users.find((x) => x.id === p.id);
  if (!u) return fail(res, 404, 'Utilisateur introuvable.');
  if (!validPassword(body.password)) return fail(res, 400, 'Mot de passe : 6 caractères minimum.');
  u.passwordHash = await hashPassword(body.password);
  // Déconnecte les sessions de cet utilisateur (sauf celle de l'admin qui agit)
  for (const [k, s] of Object.entries(db.sessions)) if (s.userId === u.id && k !== ctx.sessionKey) delete db.sessions[k];
  if (u.id !== ctx.user.id) dropUserStreams(u.id);
  save();
  send(res, 200, { ok: true });
});

route('DELETE', '/api/admin/users/:id', { auth: true, admin: true }, async (req, res, ctx, p) => {
  const u = db.users.find((x) => x.id === p.id);
  if (!u) return fail(res, 404, 'Utilisateur introuvable.');
  if (u.id === ctx.user.id) return fail(res, 400, 'Tu ne peux pas supprimer ton propre compte.');
  db.users = db.users.filter((x) => x.id !== u.id);
  for (const [k, s] of Object.entries(db.sessions)) if (s.userId === u.id) delete db.sessions[k];
  dropUserStreams(u.id);
  save();
  broadcast();
  send(res, 200, { ok: true });
});

// ---------- Fichiers statiques ----------
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

function serveStatic(req, res, pathname) {
  const entry = STATIC[pathname];
  if (!entry) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Introuvable'); }
  fs.readFile(path.join(PUBLIC_DIR, entry[0]), (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Introuvable'); }
    res.writeHead(200, { 'Content-Type': entry[1], 'Content-Length': buf.length, 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// ---------- Serveur ----------
let DUMMY_HASH = '';

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  try {
    const { pathname } = new URL(req.url, 'http://x');
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Méthode non autorisée.');
      return serveStatic(req, res, pathname);
    }
    // Protection CSRF : en-tête personnalisé obligatoire pour toute action qui modifie des données
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'matrix') return fail(res, 403, 'Requête refusée.');

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      let ctx = {};
      if (r.opts.auth) {
        const cu = currentUser(req);
        if (!cu) return fail(res, 401, 'Non connecté.');
        ctx = { user: cu.user, sessionKey: cu.sessionKey };
        if (r.opts.admin && cu.user.role !== 'admin') return fail(res, 403, 'Réservé à l\'administrateur.');
      }
      return await r.handler(req, res, ctx, params);
    }
    fail(res, 404, 'Introuvable.');
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e && e.status) return fail(res, e.status, e.status === 413 ? 'Requête trop volumineuse.' : 'Requête invalide.');
    console.error(e);
    fail(res, 500, 'Erreur du serveur.');
  }
});

async function main() {
  DUMMY_HASH = await hashPassword(uid(8));

  // Premier démarrage : création du compte administrateur
  if (!db.users.some((u) => u.role === 'admin')) {
    const username = process.env.ADMIN_USER || 'admin';
    let password = process.env.ADMIN_PASSWORD;
    const generated = !password;
    if (generated) password = crypto.randomBytes(9).toString('base64url');
    db.users.push({ id: uid(8), username, passwordHash: await hashPassword(password), role: 'admin', createdAt: Date.now() });
    save();
    console.log('\n==============================================');
    console.log(' Compte administrateur créé');
    console.log(`   Identifiant   : ${username}`);
    console.log(`   Mot de passe  : ${password}${generated ? '   (note-le, il ne sera plus affiché)' : ''}`);
    console.log('==============================================\n');
  }

  // Nettoyage des fichiers envoyés mais jamais rattachés à un message
  const sweep = () => {
    let changed = false;
    for (const [id, p] of Object.entries(db.pending)) {
      if (Date.now() - p.created > 3600 * 1000) { fs.unlink(path.join(UPLOAD_DIR, id), () => {}); delete db.pending[id]; changed = true; }
    }
    if (changed) save();
  };
  sweep();
  setInterval(sweep, 10 * 60 * 1000).unref();

  // Effacement de DISCUSSION : vérifié au démarrage puis chaque minute
  checkPurge();
  setInterval(checkPurge, 60 * 1000).unref();

  server.listen(PORT, HOST, () => console.log(`Messagerie Matrix prête : http://localhost:${PORT}`));
}

main();
