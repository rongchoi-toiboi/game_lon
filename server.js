const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || 'https://sprouts-36491-default-rtdb.asia-southeast1.firebasedatabase.app').replace(/\/$/, '');
const START_ELO = 500;
const K_FACTOR = 32;
const LEADERBOARD_SIZE = 10;
const REPORT_GRACE_MS = 8000;
const PID_RE = /^[A-Za-z0-9_-]{8,64}$/;
// Accounts: password hashes live in Firebase under /accounts, which must be closed to the public (see README notes).
// FIREBASE_AUTH = Firebase "database secret" (server only). SESSION_SECRET signs login tokens (optional).
const FIREBASE_AUTH = process.env.FIREBASE_AUTH || '';
const SESSION_SECRET = process.env.SESSION_SECRET ||
  (FIREBASE_AUTH ? crypto.createHash('sha256').update('sprouts-session|' + FIREBASE_AUTH).digest('hex') : crypto.randomBytes(32).toString('hex'));
const USER_RE = /^[A-Za-z0-9_]{3,16}$/;
const TOKEN_MS = 30 * 24 * 3600 * 1000;
const START_DELAY_MS = 3800;          // intro (countdown + lottery) before the first clock starts, measured on the server
const SEARCH_MAX_MS = 120000;         // safety net: nobody waits in the queue forever
const RATED_N = [3, 5, 7], RATED_TM = [1, 3, 5];

const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);

app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(express.static(path.join(__dirname, 'public')));

const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 30000,
  connectTimeout: 45000,
  maxHttpBufferSize: 5e6
});

const ratings = new Map();
const waitingPlayers = new Map(); // modeKey -> socket
const privateRooms = {};          // 6-char code -> { p1: socket.id, n, tm }
let rooms = {};
let users = {};
// ---- the referee: exact test for "can anyone still move?" on the planar map ----
function movesLeft(spots, lines) {
  const lives = (s) => 3 - s.d;
  const hs = [];
  lines.forEach((l) => [0, 1].forEach((d) => { const P = d ? l.p.slice().reverse() : l.p; hs.push({ u: d ? l.b : l.a, P, ang: Math.atan2(P[1][1] - P[0][1], P[1][0] - P[0][0]) }); }));
  const rot = spots.map(() => []); hs.forEach((h, i) => rot[h.u].push(i)); rot.forEach((r) => r.sort((a, b) => hs[a].ang - hs[b].ang));
  const nxt = (i) => { const r = rot[hs[i ^ 1].u]; return r[(r.indexOf(i ^ 1) + r.length - 1) % r.length]; };
  const cyc = [], seen = new Array(hs.length).fill(false);
  hs.forEach((h, i) => {
    if (seen[i]) return; const c = { n: new Set(), poly: [], A: 0 }; let j = i;
    do { seen[j] = true; c.n.add(hs[j].u); hs[j].P.forEach((q) => c.poly.push(q)); j = nxt(j); } while (j != i);
    for (let a = 0; a < c.poly.length; a++) { const p = c.poly[a], q = c.poly[(a + 1) % c.poly.length]; c.A += p[0] * q[1] - q[0] * p[1]; }
    c.A /= 2; cyc.push(c);
  });
  const uf = spots.map((_, i) => i), fd = (x) => (uf[x] == x ? x : (uf[x] = fd(uf[x]))); lines.forEach((l) => { uf[fd(l.a)] = fd(l.b); });
  const comps = new Map(); spots.forEach((_, i) => { if (fd(i) == i) comps.set(i, []); });
  cyc.forEach((c, i) => { c.comp = fd([...c.n][0]); comps.get(c.comp).push(i); });
  const inside = (pt, poly) => { let c = false; for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) { const p = poly[a], q = poly[b]; if ((p[1] > pt[1]) != (q[1] > pt[1]) && pt[0] < (q[0] - p[0]) * (pt[1] - p[1]) / (q[1] - p[1]) + p[0]) c = !c; } return c; };
  const host = (root) => { const pt = [spots[root].x, spots[root].y]; let best = -1; cyc.forEach((c, i) => { if (c.comp != root && c.A > 1e-6 && inside(pt, c.poly) && (best < 0 || c.A < cyc[best].A)) best = i; }); return best; };
  const faces = new Map(), add = (f, s) => { if (!faces.has(f)) faces.set(f, new Set()); faces.get(f).add(s); };
  comps.forEach((ids, root) => {
    const hf = host(root); let outer = -1; ids.forEach((i) => { if (outer < 0 || cyc[i].A < cyc[outer].A) outer = i; });
    if (!ids.length) add(hf, root);
    ids.forEach((i) => { const f = i == outer ? hf : i; cyc[i].n.forEach((s) => add(f, s)); });
  });
  for (const set of faces.values()) {
    let live = 0;
    for (const s of set) { const l = lives(spots[s]); if (l > 1) return true; if (l > 0) live++; }
    if (live > 1) return true;
  }
  return false;
}
// light sanity check on a state sent by a player (shape and size only)
function validState(o) {
  if (!o || !Array.isArray(o.spots) || !Array.isArray(o.lines)) return false;
  if (o.spots.length < 1 || o.spots.length > 400 || o.lines.length > 800) return false;
  const num = (v) => typeof v === 'number' && isFinite(v) && Math.abs(v) < 1e6;
  if (!o.spots.every((s) => s && num(s.x) && num(s.y) && Number.isInteger(s.d) && s.d >= 0 && s.d <= 3)) return false;
  let pts = 0;
  for (const l of o.lines) {
    if (!l || !Array.isArray(l.p) || l.p.length < 3 || !Number.isInteger(l.a) || !Number.isInteger(l.b)) return false;
    if (l.a < 0 || l.b < 0 || l.a >= o.spots.length || l.b >= o.spots.length) return false;
    pts += l.p.length; if (pts > 60000) return false;
    if (!l.p.every((q) => Array.isArray(q) && num(q[0]) && num(q[1]))) return false;
  }
  return true;
}
const clampInt = (v, a, b, d) => { v = Math.round(Number(v)); return isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };

const accounts = new Map();   // lower-case username -> { u, salt, hash, pid, created }
const accountPids = new Set();

// --- Firebase REST Helpers ---
async function fbLoadAll() {
  if (!FIREBASE_DB_URL) return;
  try {
    const res = await fetch(`${FIREBASE_DB_URL}/users.json`);
    const data = await res.json();
    if (data && typeof data === 'object') {
      for (const [pid, rec] of Object.entries(data)) {
        if (rec && typeof rec.elo === 'number') ratings.set(pid, rec);
      }
      console.log(`Loaded ${ratings.size} profiles from Firebase.`);
    }
  } catch (e) { console.warn('Firebase load skipped:', e.message); }
}

async function fbSaveUser(pid, rec) {
  if (!FIREBASE_DB_URL || !pid || pid.startsWith('anon_')) return;
  try {
    await fetch(`${FIREBASE_DB_URL}/users/${encodeURIComponent(pid)}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rec)
    });
  } catch (e) {}
}

fbLoadAll();
setInterval(() => {   // nobody waits forever
  let changed = false;
  for (const [k, s] of waitingPlayers.entries()) {
    if (!s.connected || Date.now() - (s.waitSince || 0) > SEARCH_MAX_MS) { waitingPlayers.delete(k); if (s.connected) s.emit('search_timeout'); changed = true; }
  }
  if (changed) broadcastQueue();
}, 15000).unref();

const accUrl = (key) => `${FIREBASE_DB_URL}/accounts${key ? '/' + encodeURIComponent(key) : ''}.json?auth=${encodeURIComponent(FIREBASE_AUTH)}`;
let accountsOk = !FIREBASE_AUTH;   // without a secret we run memory-only (accounts vanish on restart)
async function fbLoadAccounts() {
  if (!FIREBASE_AUTH) { console.warn('[accounts] FIREBASE_AUTH is not set: accounts are kept in memory only and are lost on restart.'); return; }
  try {
    const res = await fetch(accUrl());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    for (const [key, rec] of Object.entries(data || {})) {
      if (rec && rec.hash && rec.salt && rec.pid) { accounts.set(key, rec); accountPids.add(rec.pid); }
    }
    accountsOk = true;
    console.log(`Loaded ${accounts.size} accounts.`);
  } catch (e) { console.warn('[accounts] load failed, will retry:', e.message); }
}
async function fbSaveAccount(key, rec) {
  if (!FIREBASE_AUTH) return true;
  try {
    // if-match: null_etag => only create when nothing exists there yet (never overwrite an existing account)
    const res = await fetch(accUrl(key), { method: 'PUT', headers: { 'Content-Type': 'application/json', 'if-match': 'null_etag' }, body: JSON.stringify(rec) });
    return res.ok;
  } catch (e) { return false; }
}
const accountsReady = fbLoadAccounts();
if (FIREBASE_AUTH) setInterval(() => { if (!accountsOk) fbLoadAccounts(); }, 30000).unref();

// ---- password hashing (scrypt, per-user salt) ----
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));
async function hashPw(pw) { const salt = crypto.randomBytes(16); const k = await scrypt(pw, salt); return { salt: salt.toString('hex'), hash: k.toString('hex') }; }
async function checkPw(pw, rec) {
  const k = await scrypt(pw, Buffer.from(rec.salt, 'hex')), h = Buffer.from(rec.hash, 'hex');
  return h.length === k.length && crypto.timingSafeEqual(h, k);
}
const DUMMY = { salt: '00'.repeat(16), hash: '00'.repeat(64) };

// ---- stateless login tokens (HMAC-signed, 30 days) ----
const sig = (body) => crypto.createHmac('sha256', SESSION_SECRET).update(body).digest();
function signToken(u, pid) {
  const body = Buffer.from(JSON.stringify({ u, pid, exp: Date.now() + TOKEN_MS })).toString('base64url');
  return body + '.' + sig(body).toString('base64url');
}
function readToken(t) {
  if (typeof t !== 'string' || t.length > 600) return null;
  const [body, mac] = t.split('.');
  if (!body || !mac) return null;
  const good = sig(body), given = Buffer.from(mac, 'base64url');
  if (given.length !== good.length || !crypto.timingSafeEqual(given, good)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p && p.exp > Date.now() ? p : null; } catch (e) { return null; }
}

// ---- brute-force limits ----
const fails = new Map(), regLog = new Map();
const throttled = (key) => { const f = fails.get(key); return !!f && f.until > Date.now(); };
function noteFail(key, limit) {
  const f = fails.get(key) || { n: 0, until: 0 };
  if (++f.n >= limit) { f.until = Date.now() + 10 * 60 * 1000; f.n = 0; }
  fails.set(key, f);
}
function allowReg(ip) {
  const now = Date.now(), list = (regLog.get(ip) || []).filter((t) => now - t < 3600e3);
  if (list.length >= 5) { regLog.set(ip, list); return false; }
  list.push(now); regLog.set(ip, list); return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, f] of fails) if (f.until < now && f.n === 0) fails.delete(k);
  for (const [k, l] of regLog) if (!l.some((t) => now - t < 3600e3)) regLog.delete(k);
}, 600000).unref();
const ipOf = (s) => String(s.handshake.headers['x-forwarded-for'] || s.handshake.address || '').split(',')[0].trim();

const cleanName = (x) => String(x == null ? '' : x).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16);

// Check if any other account (different pid) already owns this name (case-insensitive)
function isNameTaken(candidate, excludePid) {
  if (!candidate) return false;
  const low = candidate.toLowerCase();
  const acc = accounts.get(low);
  if (acc && acc.pid !== excludePid) return true;   // usernames are reserved forever
  for (const [pid, rec] of ratings.entries()) {
    if (pid !== excludePid && rec && rec.name && rec.name.toLowerCase() === low) {
      return true;
    }
  }
  return false;
}

function generateUniqueDefaultName(excludePid) {
  for (let i = 0; i < 50; i++) {
    const candidate = 'Player' + (100 + Math.floor(Math.random() * 900));
    if (!isNameTaken(candidate, excludePid)) return candidate;
  }
  return 'Player_' + crypto.randomBytes(2).toString('hex');
}

function identify(socket, data) {
  const d = data && typeof data === 'object' ? data : {};
  let u = users[socket.id];
  if (!u) {
    let pid = typeof d.pid === 'string' && PID_RE.test(d.pid) ? d.pid : 'anon_' + socket.id;
    if (accountPids.has(pid)) pid = 'anon_' + socket.id;   // an account's profile can only be used after logging in
    u = users[socket.id] = { pid };
  }
  let rec = ratings.get(u.pid);
  if (!rec) {
    rec = {
      pub: crypto.randomBytes(4).toString('hex'),
      name: generateUniqueDefaultName(u.pid),
      elo: START_ELO,
      games: 0,
      wins: 0
    };
    ratings.set(u.pid, rec);
    fbSaveUser(u.pid, rec);
  }
  if (d.name !== undefined && !u.auth) {   // logged-in players keep their username as display name
    const desired = cleanName(d.name);
    if (desired && desired.toLowerCase() !== rec.name.toLowerCase()) {
      if (isNameTaken(desired, u.pid)) {
        return { rec, nameConflict: true, attemptedName: desired };
      }
      rec.name = desired;
      fbSaveUser(u.pid, rec);
    } else if (desired) {
      rec.name = desired; // Allow case-only tweaks of their own name
      fbSaveUser(u.pid, rec);
    }
  }
  return { rec, nameConflict: false };
}

function cleanupPid(pid) {
  if (!pid || accountPids.has(pid)) return;
  if (Object.values(users).some((x) => x.pid === pid)) return;
  const r = ratings.get(pid);
  if (r && (r.games === 0 || pid.startsWith('anon_'))) ratings.delete(pid);
}
const recOf = (socketId) => (users[socketId] ? ratings.get(users[socketId].pid) : null);
const pidOf = (socketId) => (users[socketId] ? users[socketId].pid : null);
const profileOf = (rec) => ({ pub: rec.pub, name: rec.name, elo: rec.elo, games: rec.games });

function getLeaderboard() {
  const online = new Set(Object.values(users).map((u) => u.pid));
  return [...ratings.entries()]
    .filter(([pid, r]) => accountPids.has(pid) && (r.games > 0 || online.has(pid)))   // registered accounts only, never guests
    .map(([pid, r]) => ({ pub: r.pub, name: r.name, elo: r.elo, games: r.games, online: online.has(pid) }))
    .sort((a, b) => b.elo - a.elo || b.games - a.games)
    .slice(0, LEADERBOARD_SIZE);
}
const broadcastLeaderboard = () => io.emit('leaderboard_update', getLeaderboard());

// Modes that currently have a player waiting for an opponent
function queueList() {
  const out = [];
  for (const [k, s] of waitingPlayers.entries()) {
    if (!s || !s.connected) { waitingPlayers.delete(k); continue; }
    const [n, tm] = k.split('_').map(Number), r = recOf(s.id);
    if (r) out.push({ n, tm, name: r.name, elo: r.elo, pub: r.pub });
  }
  return out.sort((a, b) => a.n - b.n || a.tm - b.tm);
}
const broadcastQueue = () => io.emit('queue_update', queueList());

function generateSpots(n) {
  const spots = [];
  const W = 900, H = 600;
  for (let t = 0; spots.length < n && t < 2000; t++) {
    const p = { x: (Math.random() - 0.5) * (W - 140), y: (Math.random() - 0.5) * (H - 140), d: 0 };
    if (spots.every((s) => Math.hypot(s.x - p.x, s.y - p.y) > (t > 1000 ? 70 : 130))) spots.push(p);
  }
  return spots;
}

function finishRoom(room, winnerRole, reason) {
  if (room.finished) return;
  room.finished = true;
  clearTimeout(room.timer); clearTimeout(room.ct);

  if (room.isPrivate) {
    io.to(room.id).emit('elo_result', { void: true, privateMsg: 'Ván giao hữu kết thúc!', winner: winnerRole, reason: reason });
    return;
  }

  const wId = winnerRole === 0 ? room.p1 : room.p2;
  const lId = winnerRole === 0 ? room.p2 : room.p1;
  const W = recOf(wId), L = recOf(lId);
  if (!W || !L) return;

  const expected = 1 / (1 + Math.pow(10, (L.elo - W.elo) / 400));
  const gain = Math.max(1, Math.round(K_FACTOR * (1 - expected)));
  const newL = Math.max(0, L.elo - gain);
  const loss = L.elo - newL;
  W.elo += gain; W.games++; W.wins++;
  L.elo = newL; L.games++;

  fbSaveUser(pidOf(wId), W);
  fbSaveUser(pidOf(lId), L);

  const elo = [0, 0], delta = [0, 0];
  elo[winnerRole] = W.elo;      delta[winnerRole] = gain;
  elo[winnerRole ^ 1] = L.elo;  delta[winnerRole ^ 1] = -loss;

  io.to(room.id).emit('elo_result', { winner: winnerRole, reason, elo, delta });
  [room.p1, room.p2].forEach((id) => {
    const s = io.sockets.sockets.get(id), r = recOf(id);
    if (s && r) s.emit('profile', profileOf(r));
  });
  broadcastLeaderboard();
}

function voidRoom(room) {
  if (room.finished) return;
  room.finished = true;
  clearTimeout(room.timer); clearTimeout(room.ct);
  io.to(room.id).emit('elo_result', { void: true, privateMsg: 'Không tính Elo (Lỗi đồng bộ).', winner: 0, reason: 'nomoves' });
}

// The server owns the clock: it knows whose turn it is and when it began, and it ends the game on timeout.
const latOf = (id) => { const sk = io.sockets.sockets.get(id); return Math.min(300, (sk && sk.lat) || 0); };
function armClock(room) {
  clearTimeout(room.ct);
  if (!room.lim || room.finished) return;
  const left = room.clk[room.turn] - (Date.now() - room.turnAt);
  const who = room.turn;
  room.ct = setTimeout(() => { if (!room.finished && room.turn === who) finishRoom(room, who ^ 1, 'timeout'); },
    Math.max(0, left) + latOf(who === 0 ? room.p1 : room.p2) + 60);
}
// (Re)start a match for a room: fresh spots, random first player, server-side clocks.
function launch(room) {
  const p1 = io.sockets.sockets.get(room.p1), p2 = io.sockets.sockets.get(room.p2);
  const r1 = recOf(room.p1), r2 = recOf(room.p2);
  if (!p1 || !p2 || !r1 || !r2) return;
  clearTimeout(room.timer); clearTimeout(room.ct);
  room.finished = false; room.reports = [null, null]; room.timer = null; room.reason = 'normal'; room.rm = [false, false];
  room.lim = Math.round(room.tm * 60000); room.clk = [room.lim, room.lim];
  room.turn = Math.random() < 0.5 ? 0 : 1; room.moves = 0;
  room.startAt = Date.now() + START_DELAY_MS; room.turnAt = room.startAt;
  const spots = generateSpots(room.n);
  room.lastState = JSON.stringify({ spots: spots.map((s) => ({ ...s, hx: s.x, hy: s.y })), lines: [], turn: room.turn, lim: room.lim, clk: room.clk, n: room.n });
  armClock(room);
  const md = { roomId: room.id, spots, lines: [], turn: room.turn, tm: room.tm, p1Name: r1.name, p2Name: r2.name,
    elo: [r1.elo, r2.elo], isPrivate: room.isPrivate, startAt: room.startAt, now: Date.now() };
  p1.emit('match_start', { ...md, role: 0, opponent: r2.name });
  p2.emit('match_start', { ...md, role: 1, opponent: r1.name });
}
const startRematch = launch;

// One move from a player: check it, charge the clock, hand the authoritative state to both sides, referee the end.
function handleMove(socket, room, data) {
  const role = room.p1 === socket.id ? 0 : 1;
  const resync = () => socket.emit('game_action', { t: 'state', s: room.lastState, ts: room.turnAt, resync: 1 });
  if (room.finished) return;
  if (role !== room.turn || Date.now() < room.startAt - 500) return resync();
  let o; try { o = JSON.parse(data.s); } catch (e) { return resync(); }
  if (!validState(o)) return resync();
  const now = Date.now();
  if (room.lim) {
    room.clk[role] -= Math.max(0, now - room.turnAt - latOf(socket.id));   // credit the mover's one-way latency
    if (room.clk[role] <= 0) return finishRoom(room, role ^ 1, 'timeout');
  }
  room.turn ^= 1; room.turnAt = now; room.moves++;
  o.turn = room.turn; o.clk = room.clk.slice(); o.lim = room.lim; o.over = false; o.tout = false;
  room.lastState = JSON.stringify(o);
  socket.to(room.id).emit('game_action', { t: 'state', s: room.lastState, ts: now });
  socket.emit('move_ack', { clk: room.clk.slice(), turn: room.turn, ts: now, moves: room.moves });
  if (!movesLeft(o.spots, o.lines)) return finishRoom(room, role, 'nomoves');   // the player who cannot move loses
  armClock(room);
}

function leaveRoom(socket) {
  const room = rooms[socket.id];
  if (!room) return;
  const role = room.p1 === socket.id ? 0 : 1;
  const otherId = role === 0 ? room.p2 : room.p1;

  if (!room.finished) {
    const rep = room.reports[role] !== null ? room.reports[role] : room.reports[role ^ 1];
    if (rep !== null) finishRoom(room, rep, 'normal');
    else finishRoom(room, role ^ 1, 'forfeit');
    room.finished = true;
  }
  delete rooms[room.p1];
  delete rooms[room.p2];
  socket.leave(room.id);
  const other = io.sockets.sockets.get(otherId);
  if (other) { other.leave(room.id); other.emit('opponent_left'); }
}

io.on('connection', (socket) => {
  // clients estimate the server clock with this, and we measure each player's latency for the clock credit
  socket.on('ts', (_, cb) => { if (typeof cb === 'function') cb(Date.now()); });
  const probe = () => { const t = Date.now(); socket.emit('pg', () => { socket.lat = (Date.now() - t) / 2; }); };
  probe(); const probeIv = setInterval(probe, 5000);
  socket.on('disconnect', () => clearInterval(probeIv));
  socket.emit('leaderboard_update', getLeaderboard());
  socket.emit('queue_update', queueList());

  socket.on('set_name', (data) => {
    const { rec, nameConflict, attemptedName } = identify(socket, data);
    if (nameConflict) {
      socket.emit('name_error', {
        msg: `Tên "${attemptedName}" đã có người dùng!`,
        currentName: rec.name
      });
    }
    socket.emit('profile', profileOf(rec));
    broadcastLeaderboard();
  });

  // --- ACCOUNTS ---
  const authErr = (msg, silent) => socket.emit('auth_error', { msg, silent: !!silent });
  const busyMsg = () => {
    const r = rooms[socket.id];
    if (r && !r.finished) return 'Hãy thoát khỏi ván đấu trước.';
    for (const s of waitingPlayers.values()) if (s.id === socket.id) return 'Hãy hủy tìm trận trước.';
    return '';
  };
  async function startSession(acct) {
    for (const [k, v] of waitingPlayers.entries()) if (v.id === socket.id) waitingPlayers.delete(k);
    for (const k in privateRooms) if (privateRooms[k].p1 === socket.id) delete privateRooms[k];
    if (rooms[socket.id]) leaveRoom(socket);
    const old = users[socket.id];
    users[socket.id] = { pid: acct.pid, auth: true, uname: acct.u };
    if (old && old.pid !== acct.pid) cleanupPid(old.pid);
    let rec = ratings.get(acct.pid);
    if (!rec) { rec = { pub: crypto.randomBytes(4).toString('hex'), name: acct.u, elo: START_ELO, games: 0, wins: 0 }; ratings.set(acct.pid, rec); fbSaveUser(acct.pid, rec); }
    else if (rec.name !== acct.u) { rec.name = acct.u; fbSaveUser(acct.pid, rec); }
    socket.emit('auth_ok', { username: acct.u, token: signToken(acct.u, acct.pid) });
    socket.emit('profile', profileOf(rec));
    broadcastQueue();
    broadcastLeaderboard();
  }
  const credentials = (data) => {
    const d = data && typeof data === 'object' ? data : {};
    return { username: String(d.username == null ? '' : d.username).trim(), pw: d.password };
  };

  socket.on('register', async (data) => {
    try {
      await accountsReady;
      if (!accountsOk) return authErr('Máy chủ đang khởi động, hãy thử lại sau ít phút.');
      const busy = busyMsg(); if (busy) return authErr(busy);
      const { username, pw } = credentials(data);
      if (!USER_RE.test(username)) return authErr('Tên đăng nhập gồm 3–16 ký tự: chữ, số hoặc dấu _');
      if (typeof pw !== 'string' || pw.length < 6 || pw.length > 72) return authErr('Mật khẩu phải từ 6 đến 72 ký tự.');
      if (!allowReg(ipOf(socket))) return authErr('Bạn tạo tài khoản quá nhanh. Hãy thử lại sau.');
      const low = username.toLowerCase();
      if (accounts.has(low)) return authErr('Tên đăng nhập đã tồn tại.');
      if (isNameTaken(username, null)) return authErr('Tên này đang được người chơi khác sử dụng.');
      accounts.set(low, { pending: true });   // reserve the name while hashing
      let acct;
      try {
        const { salt, hash } = await hashPw(pw);
        acct = { u: username, salt, hash, pid: crypto.randomBytes(16).toString('hex'), created: Date.now() };
        if (!(await fbSaveAccount(low, acct))) throw new Error('save failed');
      } catch (e) { accounts.delete(low); return authErr('Không tạo được tài khoản (có thể tên đã tồn tại). Hãy thử lại.'); }
      accounts.set(low, acct); accountPids.add(acct.pid);
      await startSession(acct);
    } catch (e) { authErr('Lỗi máy chủ, hãy thử lại.'); }
  });

  socket.on('login', async (data) => {
    try {
      await accountsReady;
      if (!accountsOk) return authErr('Máy chủ đang khởi động, hãy thử lại sau ít phút.');
      const busy = busyMsg(); if (busy) return authErr(busy);
      const { username, pw } = credentials(data), ip = ipOf(socket), low = username.toLowerCase();
      const bad = 'Sai tên đăng nhập hoặc mật khẩu.';
      if (!USER_RE.test(username) || typeof pw !== 'string' || pw.length > 72) return authErr(bad);
      if (throttled('ui:' + low + '|' + ip) || throttled('u:' + low) || throttled('ip:' + ip)) return authErr('Thử sai quá nhiều lần. Vui lòng đợi 10 phút.');
      const acct = accounts.get(low);
      const ok = acct && !acct.pending ? await checkPw(pw, acct) : (await checkPw(pw, DUMMY), false);   // same work either way
      // 6 misses per (user, address) locks that address out; the per-user and per-address caps are higher so a
      // stranger can't lock the real owner out of their own account just by guessing at it.
      if (!ok) { noteFail('ui:' + low + '|' + ip, 6); noteFail('u:' + low, 40); noteFail('ip:' + ip, 25); return authErr(bad); }
      await startSession(acct);
    } catch (e) { authErr('Lỗi máy chủ, hãy thử lại.'); }
  });

  socket.on('resume', async (data) => {
    try {
      await accountsReady;
      const p = readToken(data && data.token), acct = p && accounts.get(String(p.u).toLowerCase());
      if (!accountsOk || !acct || acct.pending || acct.pid !== p.pid || busyMsg()) return authErr('', true);
      await startSession(acct);
    } catch (e) { authErr('', true); }
  });

  socket.on('logout', () => {
    const u = users[socket.id];
    if (!u || !u.auth) return;
    const busy = busyMsg(); if (busy) return authErr(busy);
    delete users[socket.id];
    cleanupPid(u.pid);
    socket.emit('auth_out');
    broadcastLeaderboard();
  });

  // --- MULTI-MODE QUICK MATCHMAKING ---
  socket.on('find_match', (data) => {
    // Rated games are for registered accounts only (guests can still play friend rooms, bot and local games)
    const who = users[socket.id];
    if (!who || !who.auth) {
      return socket.emit('match_error', { msg: 'Chế độ xếp hạng cần đăng nhập. Hãy đăng nhập hoặc đăng ký tài khoản.', needLogin: true });
    }
    const { rec, nameConflict, attemptedName } = identify(socket, data);
    if (nameConflict) {
      return socket.emit('name_error', {
        msg: `Tên "${attemptedName}" đã có người dùng!`,
        currentName: rec.name
      });
    }
    socket.emit('profile', profileOf(rec));

    if (rooms[socket.id]) {
      if (rooms[socket.id].finished) leaveRoom(socket);
      else return socket.emit('match_error', { msg: 'Bạn đang trong một ván đấu.' });
    }
    const n = Number(data.n) || 5;
    const tm = Number(data.tm) || 3;
    if (!RATED_N.includes(n) || !RATED_TM.includes(tm)) return socket.emit('match_error', { msg: 'Chế độ xếp hạng chỉ có 3/5/7 chấm và 1/3/5 phút.' });
    const modeKey = `${n}_${tm}`;

    let wp = waitingPlayers.get(modeKey);
    if (wp && !wp.connected) {
      waitingPlayers.delete(modeKey);
      wp = null;
    }

    if (wp && wp.id !== socket.id) {
      if (users[wp.id] && users[wp.id].pid === users[socket.id].pid) {
        return socket.emit('match_error', { msg: 'Tài khoản này đang tìm trận ở tab khác.' });
      }
      waitingPlayers.delete(modeKey);
      
      broadcastQueue();
      const p1 = wp;
      const p2 = socket;
      const roomId = 'room_' + p1.id + '_' + p2.id;
      p1.join(roomId);
      p2.join(roomId);
      const room = { id: roomId, p1: p1.id, p2: p2.id, finished: false, reports: [null, null], timer: null, reason: 'normal', isPrivate: false, n, tm, rm: [false, false] };
      rooms[p1.id] = room; rooms[p2.id] = room;
      rooms[p1.id] = room;
      rooms[p2.id] = room;

      launch(room);
    } else {
      socket.waitSince = Date.now();
      waitingPlayers.set(modeKey, socket);
      broadcastQueue();
      socket.emit('waiting_for_match');
    }
  });

  socket.on('cancel_match', () => {
    for(let [k,v] of waitingPlayers.entries()){ if(v.id === socket.id) waitingPlayers.delete(k); } broadcastQueue();
  });

  // --- PRIVATE ROOMS (6-CHAR CODE) VIA SOCKET.IO ---
  socket.on('host_private', (data) => {
    identify(socket, data);
    if(rooms[socket.id] && !rooms[socket.id].finished) leaveRoom(socket);
    if (!data || !/^[A-Z0-9]{6}$/.test(String(data.code))) return;
    privateRooms[data.code] = { p1: socket.id, n: clampInt(data.n, 2, 12, 5), tm: clampInt(data.tm, 0, 60, 3) };
  });

  socket.on('join_private', (data) => {
    identify(socket, data);
    const code = data.code;
    const pr = privateRooms[code];
    if (!pr) return socket.emit('private_error', { msg: 'Không tìm thấy phòng ' + code });
    if (pr.p1 === socket.id) return socket.emit('private_error', { msg: 'Bạn không thể tự vào phòng của mình.' });

    const p1Socket = io.sockets.sockets.get(pr.p1);
    if (!p1Socket) {
      delete privateRooms[code];
      return socket.emit('private_error', { msg: 'Chủ phòng đã thoát.' });
    }

    delete privateRooms[code];
    const p1 = p1Socket;
    const p2 = socket;

    const roomId = 'priv_' + p1.id + '_' + p2.id;
    p1.join(roomId);
    p2.join(roomId);

    const { rec: r1 } = identify(p1, {});
    const { rec: r2 } = identify(p2, {});

    const room = { id: roomId, p1: p1.id, p2: p2.id, finished: false, reports: [null, null], timer: null, reason: 'normal', isPrivate: true, n: pr.n, tm: pr.tm, rm: [false, false] };
    rooms[p1.id] = room;
    rooms[p2.id] = room;

    launch(room);
  });

  socket.on('game_action', (data) => {
    const room = rooms[socket.id];
    if (!room || !data || typeof data !== 'object') return;
    if (data.t === 'state') return handleMove(socket, room, data);
    if (data.t === 'resign') { if (!room.finished) finishRoom(room, (room.p1 === socket.id ? 0 : 1) ^ 1, 'resign'); return; }
    if (data.t === 'name') socket.to(room.id).emit('game_action', { t: 'name', i: data.i === 1 ? 1 : 0, v: String(data.v == null ? '' : data.v).slice(0, 16) });
  });

  // Both players must ask for a rematch (either can withdraw the request)
  socket.on('rematch', (data) => {
    const room = rooms[socket.id];
    if (!room || !room.finished) return;
    const role = room.p1 === socket.id ? 0 : 1;
    const other = io.sockets.sockets.get(role === 0 ? room.p2 : room.p1);
    if (!other) return;
    room.rm = room.rm || [false, false];
    room.rm[role] = !!(data && data.on);
    if (room.rm[0] && room.rm[1]) return startRematch(room);
    socket.emit('rematch_state', { me: room.rm[role], opp: room.rm[role ^ 1] });
    other.emit('rematch_state', { me: room.rm[role ^ 1], opp: room.rm[role] });
  });

  socket.on('leave_match', () => leaveRoom(socket));

  socket.on('disconnect', () => {
    for(let [k,v] of waitingPlayers.entries()){ if(v.id === socket.id) waitingPlayers.delete(k); } broadcastQueue();
    for(let k in privateRooms){ if(privateRooms[k].p1 === socket.id) delete privateRooms[k]; }
    leaveRoom(socket);
    
    const u = users[socket.id];
    delete users[socket.id];
    if (u) {
      cleanupPid(u.pid);
    }
    broadcastLeaderboard();
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
