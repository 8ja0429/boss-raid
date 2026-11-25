// 강의 전 보스 레이드 — 서버 (외부 패키지 없음, Node.js만 있으면 실행)
// 실행: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = __dirname;
const cfg = {
  title: '강의 전 보스 레이드',
  bossName: '버그 대마왕',
  prize: '',
  port: 3000,
  durationSec: 60,
  hpPerPlayer: 250,
  minHp: 500,
  adminKey: '',
};
try {
  Object.assign(cfg, JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')));
} catch (e) {
  if (e.code !== 'ENOENT') console.error('config.json 을 읽지 못해 기본값으로 실행합니다:', e.message);
}
const PORT = Number(process.env.PORT) || cfg.port;
const ADMIN_KEY = String(process.env.ADMIN_KEY || cfg.adminKey || crypto.randomBytes(3).toString('hex'));
let lastCsv = ''; // 마지막 판 결과 (진행 화면에서 내려받기용)

const TICK_MS = 200;
const MAX_TAPS_PER_SEC = 22; // 사람 손으로 가능한 한계 근처. 그 이상은 버림
const STUN_MS = 3000;
const MAX_PLAYERS = 500;

// ---------- 상태 ----------
const players = new Map(); // id -> player
let nextPid = 1;
const G = {
  state: 'lobby', // lobby | countdown | fight | result
  round: 0,
  hp: 0,
  max: 0,
  startsAt: 0,
  endsAt: 0,
  feverUntil: 0,
  nextFever: 0,
  atkFrom: 0,
  atkUntil: 0,
  nextAtk: 0,
  win: false,
  lastHit: null,
  clearMs: 0,
};
let hits = []; // 직전 틱 동안 들어온 타격 (화면 연출용)
let ranking = []; // 점수순 정렬 캐시
const rankOf = new Map(); // pid -> 순위
const clients = new Set(); // SSE 연결
let seq = 0; // 전송 순번 (같은 내용을 두 번 처리하지 않도록)
let lastPayload = ''; // 마지막 전송 내용 (실시간 연결이 막힌 환경의 /state 조회용)

const rand = (a, b) => a + Math.random() * (b - a);
const enraged = () => G.state === 'fight' && G.hp <= G.max / 2;

function activePlayers() {
  let n = 0;
  const now = Date.now();
  for (const p of players.values()) if (p.bot || p.conns > 0 || now - (p.seenAt || 0) < 5000) n++;
  return n;
}

function cleanName(raw, pid) {
  let s = String(raw || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  s = Array.from(s).slice(0, 10).join('');
  if (!s) s = '용사' + pid;
  const taken = new Set();
  for (const p of players.values()) taken.add(p.name);
  if (!taken.has(s)) return s;
  for (let i = 2; ; i++) {
    const c = Array.from(s).slice(0, 8).join('') + i;
    if (!taken.has(c)) return c;
  }
}

function rebuildRanking() {
  ranking = Array.from(players.values()).sort((a, b) => b.score - a.score || a.scoreAt - b.scoreAt);
  rankOf.clear();
  ranking.forEach((p, i) => rankOf.set(p.pid, i + 1));
}

// ---------- 게임 진행 ----------
function startRound() {
  if (G.state !== 'lobby') return;
  for (const p of players.values()) {
    p.score = 0;
    p.scoreAt = 0;
    p.stunUntil = 0;
    p.stuns = 0;
  }
  G.round++;
  G.max = Math.max(cfg.minHp, Math.round(activePlayers() * cfg.hpPerPlayer));
  G.hp = G.max;
  G.win = false;
  G.lastHit = null;
  G.feverUntil = G.atkFrom = G.atkUntil = 0;
  G.state = 'countdown';
  G.startsAt = Date.now() + 4000;
  broadcast();
}

function beginFight(now) {
  G.state = 'fight';
  G.endsAt = now + cfg.durationSec * 1000;
  G.nextFever = now + rand(9000, 13000);
  G.nextAtk = now + rand(5000, 7000);
}

function finish(win, lastHitter) {
  const now = Date.now();
  G.state = 'result';
  G.win = win;
  G.lastHit = lastHitter ? { pid: lastHitter.pid, name: lastHitter.name } : null;
  G.clearMs = cfg.durationSec * 1000 - Math.max(0, G.endsAt - now);
  G.hp = Math.max(0, G.hp);
  rebuildRanking();
  saveCsv();
  broadcast();
}

function resetToLobby() {
  G.state = 'lobby';
  for (const p of players.values()) {
    p.score = 0;
    p.stunUntil = 0;
  }
  for (const [id, p] of players) if (p.bot) players.delete(id);
  rebuildRanking();
  broadcast();
}

function applyDamage(p, taps, now) {
  if (G.state !== 'fight' || taps <= 0) return;
  const dmg = taps * (now < G.feverUntil ? 2 : 1);
  p.score += dmg;
  p.scoreAt = now;
  G.hp -= dmg;
  const last = hits[hits.length - 1];
  if (last && last[0] === p.pid) last[2] += dmg;
  else hits.push([p.pid, p.name, dmg]);
  if (G.hp <= 0) finish(true, p);
}

function tick() {
  const now = Date.now();
  if (G.state === 'countdown' && now >= G.startsAt) beginFight(now);
  if (G.state === 'fight') {
    const inAtk = now >= G.atkFrom && now < G.atkUntil;
    for (const p of players.values()) {
      if (!p.bot || G.state !== 'fight') continue;
      if (now < p.stunUntil) continue;
      if (inAtk && Math.random() < 0.04) {
        p.stunUntil = now + STUN_MS;
        continue;
      }
      if (inAtk) continue;
      applyDamage(p, Math.floor(rand(0, p.skill)), now);
    }
  }
  if (G.state === 'fight') {
    if (now >= G.nextAtk) {
      const fast = enraged();
      G.atkFrom = now + 1500;
      G.atkUntil = G.atkFrom + (fast ? 2600 : 2000);
      G.nextAtk = G.atkUntil + (fast ? rand(4000, 7000) : rand(7000, 11000));
    }
    if (now >= G.nextFever) {
      G.feverUntil = now + 5000;
      G.nextFever = G.feverUntil + rand(9000, 14000);
    }
    if (now >= G.endsAt) finish(false, null);
  }
  if (G.state !== 'result') {
    rebuildRanking();
    broadcast();
  } else if (now % 2000 < TICK_MS) {
    broadcast(); // 결과 화면은 늦게 들어온 사람용으로 가끔만 재전송
  }
}

function snapshot() {
  const now = Date.now();
  const m = { q: seq, s: G.state, round: G.round, n: players.size, hp: Math.max(0, G.hp), max: G.max };
  if (G.state === 'lobby') {
    m.names = Array.from(players.values()).slice(-300).map((p) => [p.pid, p.name]);
  } else if (G.state === 'countdown') {
    m.t = Math.max(0, G.startsAt - now);
  } else if (G.state === 'fight') {
    m.t = Math.max(0, G.endsAt - now);
    m.fever = Math.max(0, G.feverUntil - now);
    m.aw = Math.max(0, G.atkFrom - now);
    m.ae = Math.max(0, G.atkUntil - now);
    m.enr = enraged() ? 1 : 0;
    m.top = ranking.slice(0, 10).map((p) => [p.pid, p.name, p.score]);
    m.hits = hits.slice(-14);
    let st = 0;
    for (const p of players.values()) if (now < p.stunUntil) st++;
    m.stun = st;
  } else {
    m.win = G.win;
    m.last = G.lastHit;
    m.clear = G.clearMs;
    m.rank = ranking.slice(0, 200).map((p) => [p.pid, p.name, p.score]);
  }
  return m;
}

function broadcast() {
  seq++;
  lastPayload = JSON.stringify(snapshot());
  const data = 'data: ' + lastPayload + '\n\n';
  hits = [];
  for (const res of clients) res.write(data);
}

function saveCsv() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
  // 엑셀이 수식으로 오해하지 않도록 =,+,-,@ 로 시작하는 닉네임 앞에 ' 를 붙인다
  const q = (s) => '"' + String(s).replace(/^([=+\-@])/, "'$1").replace(/"/g, '""') + '"';
  const rows = ['순위,닉네임,데미지,막타,결과'];
  ranking.forEach((p, i) => {
    if (p.score === 0) return;
    const last = G.lastHit && G.lastHit.pid === p.pid ? '막타' : '';
    rows.push([i + 1, q(p.name), p.score, last, G.win ? '토벌 성공' : '시간 초과'].join(','));
  });
  lastCsv = String.fromCharCode(0xfeff) + rows.join('\r\n') + '\r\n'; // 맨 앞 BOM: 엑셀 한글 깨짐 방지
  try {
    const dir = path.join(ROOT, 'results');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `레이드_${stamp}.csv`);
    fs.writeFileSync(file, lastCsv, 'utf8');
    console.log('  결과 저장:', file);
  } catch (e) {
    console.error('  결과 파일 저장 실패(진행 화면에서 내려받기는 가능):', e.message);
  }
}

// ---------- HTTP ----------
const STATIC = {
  '/': ['player.html', 'text/html; charset=utf-8'],
  '/screen': ['screen.html', 'text/html; charset=utf-8'],
  '/boss.js': ['boss.js', 'text/javascript; charset=utf-8'],
  '/qrcode.js': ['qrcode.js', 'text/javascript; charset=utf-8'],
};

function lanUrls() {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
  }
  // 공유기 주소(192.168.x)를 맨 앞에. VPN·가상 어댑터 주소는 뒤로
  const score = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return ips.sort((a, b) => score(a) - score(b)).map((ip) => `http://${ip}:${PORT}`);
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, cb) {
  let buf = '';
  let dead = false;
  req.on('data', (c) => {
    if (dead) return;
    buf += c;
    if (buf.length > 2048) {
      dead = true;
      req.destroy();
    }
  });
  req.on('end', () => {
    if (dead) return;
    let o = null;
    try {
      o = JSON.parse(buf || '{}');
    } catch (e) {}
    cb(o && typeof o === 'object' ? o : {});
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'GET' && STATIC[p]) {
    const [file, type] = STATIC[p];
    fs.readFile(path.join(ROOT, 'public', file), (err, data) => {
      if (err) return json(res, 500, { error: 'file' });
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }

  if (req.method === 'GET' && /^\/img\/[a-z0-9_]+\.(webp|png|jpg)$/.test(p)) {
    const type = p.endsWith('.webp') ? 'image/webp' : p.endsWith('.png') ? 'image/png' : 'image/jpeg';
    fs.readFile(path.join(ROOT, 'public', 'img', path.basename(p)), (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' });
      res.end(data);
    });
    return;
  }

  if (req.method === 'GET' && p === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && p === '/results.csv') {
    if (url.searchParams.get('key') !== ADMIN_KEY) return json(res, 403, { error: 'key' });
    if (!lastCsv) return json(res, 404, { error: 'no result yet' });
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="raid_result.csv"', 'Cache-Control': 'no-store' });
    return res.end(lastCsv);
  }

  if (req.method === 'GET' && p === '/info') {
    return json(res, 200, {
      title: cfg.title,
      bossName: cfg.bossName,
      prize: cfg.prize,
      durationSec: cfg.durationSec,
      lan: lanUrls(),
    });
  }

  if (req.method === 'GET' && p === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1000\n\n');
    res.write('data: ' + JSON.stringify(snapshot()) + '\n\n');
    clients.add(res);
    const pl = players.get(url.searchParams.get('id') || '');
    if (pl) pl.conns++;
    req.on('close', () => {
      clients.delete(res);
      if (pl) pl.conns = Math.max(0, pl.conns - 1);
    });
    return;
  }

  // 실시간 연결(SSE)을 막는 프록시·터널 뒤에서는 화면이 이 주소를 주기적으로 조회한다
  if (req.method === 'GET' && p === '/state') {
    const pl = players.get(url.searchParams.get('id') || '');
    if (pl) pl.seenAt = Date.now();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(lastPayload || JSON.stringify(snapshot()));
  }

  if (req.method === 'POST' && p === '/join') {
    return readBody(req, (b) => {
      const id = String(b.id || '').slice(0, 64);
      if (id.length < 8) return json(res, 400, { error: 'id' });
      let pl = players.get(id);
      if (!pl) {
        if (players.size >= MAX_PLAYERS) return json(res, 503, { error: 'full' });
        const pid = nextPid++;
        pl = { id, pid, name: '', score: 0, scoreAt: 0, stunUntil: 0, stuns: 0, conns: 0, budget: 10, budgetAt: Date.now(), bot: false };
        pl.name = cleanName(b.name, pid);
        players.set(id, pl);
      }
      json(res, 200, { pid: pl.pid, name: pl.name, score: pl.score });
    });
  }

  if (req.method === 'POST' && p === '/tap') {
    return readBody(req, (b) => {
      const pl = players.get(String(b.id || ''));
      if (!pl) return json(res, 404, { error: 'rejoin' });
      const now = Date.now();
      let n = Math.floor(Number(b.n) || 0);
      pl.budget = Math.min(MAX_TAPS_PER_SEC * 1.5, pl.budget + ((now - pl.budgetAt) / 1000) * MAX_TAPS_PER_SEC);
      pl.budgetAt = now;
      n = Math.max(0, Math.min(n, Math.floor(pl.budget)));
      pl.budget -= n;
      if (now >= pl.stunUntil) applyDamage(pl, n, now);
      json(res, 200, { score: pl.score, rank: rankOf.get(pl.pid) || 0 });
    });
  }

  if (req.method === 'POST' && p === '/stun') {
    return readBody(req, (b) => {
      const pl = players.get(String(b.id || ''));
      if (pl && G.state === 'fight') {
        pl.stunUntil = Date.now() + STUN_MS;
        pl.stuns++;
      }
      json(res, 200, {});
    });
  }

  if (req.method === 'POST' && p === '/admin') {
    return readBody(req, (b) => {
      if (String(b.key || '') !== ADMIN_KEY) return json(res, 403, { error: 'key' });
      if (b.action === 'start') startRound();
      else if (b.action === 'reset') resetToLobby();
      else if (b.action === 'end' && G.state === 'fight') finish(false, null);
      else if (b.action === 'kick') {
        for (const [id, pl] of players) if (pl.pid === Number(b.pid)) players.delete(id);
        rebuildRanking();
        broadcast();
      } else if (b.action === 'bots' && G.state === 'lobby') {
        const names = ['코딩왕', '버그헌터', '김개발', '야근요정', '커피수혈', '세미콜론', '널포인터', '무한루프', '스택오버', '깃푸시', '디버거', '클로드짱', '퇴근각', '컴파일러', '탭파이터', '손가락신', '연타장인', '월요병', '점심뭐먹', '새벽감성'];
        for (let i = 0; i < 10 && players.size < MAX_PLAYERS; i++) {
          const pid = nextPid++;
          const id = 'bot-' + pid + '-' + crypto.randomBytes(4).toString('hex');
          const pl = { id, pid, name: '', score: 0, scoreAt: 0, stunUntil: 0, stuns: 0, conns: 0, budget: 0, budgetAt: 0, bot: true, skill: rand(2.4, 4.4) };
          pl.name = cleanName(names[Math.floor(Math.random() * names.length)], pid);
          players.set(id, pl);
        }
        broadcast();
      }
      json(res, 200, { ok: true, state: G.state });
    });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`포트 ${PORT} 가 이미 사용 중입니다. config.json 의 port 를 바꾸거나 기존 창을 닫아 주세요.`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, () => {
  setInterval(tick, TICK_MS);
  console.log('');
  console.log('  ⚔  보스 레이드 서버 실행 중');
  console.log('');
  console.log(`  진행자 화면(프로젝터):  http://localhost:${PORT}/screen?key=${ADMIN_KEY}`);
  const lan = lanUrls();
  if (lan[0]) console.log(`  참가자 접속(같은 와이파이): ${lan[0]}`);
  console.log('');
  console.log('  종료: Ctrl + C');
  console.log('');
});
