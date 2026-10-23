/* PaintBot Steuerpult -- Web-App fuer den PaintBot (Feather nRF52840 + Bluefruit-UART).
 *
 * Spricht zwei "Sprachen" ueber dieselbe Bluetooth-UART:
 *   - Bluefruit-Tastenpakete "!B<n><0|1><pruefsumme>" -- wie die Bluefruit-App
 *   - Textbefehle (eine Zeile pro Befehl), Antworten mit "@" -- siehe AppControl.ino
 *
 * Die Pfadplanung (planRobot) bildet die Ausfuehrung der Firmware nach
 * (GenerativeArt.ino: drehen, Stift setzen, fahren; Strecken < 1 mm werden
 * uebersprungen; am Ende zurueck zur Blattmitte und nach rechts ausrichten).
 */
'use strict';

/* ------------------------------------------------------------------ Konstanten */
const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX      = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';  // App -> Roboter
const NUS_TX      = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';  // Roboter -> App
const BLE_CHUNK   = 20;
const POINTS_PER_LINE = 7;

const MENUS = [
  'Leerlauf', 'Bluetooth-Steuerung', 'Muster', 'Zufallsfahrt', 'Driftkorrektur',
  'Distanz-Monitor', 'Hardwaretests', 'Generative Kunst', 'App-Steuerung'
];
const KEYMAPS = {
  0: [['T1', 'Stepper-Test anfordern, T2 bestätigt'], ['T1 lang', 'Servo-Test'], ['T2 lang', 'Entfernungsmesser an/aus']],
  1: [['T2', 'Steuerkreuz freigeben / sperren'], ['Pfeile', 'einmal = fahren, nochmal = stopp'], ['T3', 'Tempo Langsam / Mittel / Schnell']],
  2: [['T3', 'nächstes Muster'], ['T2', 'Muster starten / abbrechen'], ['T2 lang', 'Entfernungsmesser an/aus']],
  3: [['T2', 'Zufallsfahrt starten / stoppen']],
  4: [['T2', 'Driftfahrt 100 cm starten / abbrechen'], ['T3', 'Korrektur an/aus'], ['T1', 'Drehkalibrierung anfordern, T2 bestätigt']],
  5: [['T2', 'Stepper-Benchmark (Räder drehen)'], ['T3', 'Front-Fokus ↔ Schwenken']],
  6: [['T1', 'Fahrtest anfordern, T2 bestätigt'], ['T2', 'Servo-Test'], ['T3', 'Distanzsensor-Test']],
  7: [['T1', 'neuer Zufalls-Seed'], ['T3', 'nächster Algorithmus'], ['Hoch/Runter', 'Papierformat'], ['Links/Rechts', 'Seed −/+'], ['T2', 'zeichnen / abbrechen']],
  8: [['T2', 'Fahren freigeben / sperren'], ['App', 'Register „Fahren“ und „Zeichnen“']],
};
const PAPERS = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594] };
const SPEED_NAMES = ['Langsam', 'Mittel', 'Schnell'];
const DEFAULT_CFG = {
  wheel: 53.0, track: 141.4, spr: 500, spt: 1334, mode: 'INTERLEAVE', menus: 8, pmax: 1500,
  prof: [{ v: 150, a: 400 }, { v: 280, a: 600 }, { v: 420, a: 850 }],
  art: [0, 2], penms: 300, ret: 1, keep: 1
};
const MIN_SEG_MM = 1.0;

/* ------------------------------------------------------------------ Zustand */
const st = {
  link: null, connected: false, demo: false, fw: '',
  menu: null, armed: false, busy: false, f: -1, l: -1, r: -1, pen: 0, sp: 1, sw: 0, run: 0, pts: 0, thr: 15,
  cfg: { ...DEFAULT_CFG, prof: DEFAULT_CFG.prof.map(p => ({ ...p })), art: [...DEFAULT_CFG.art] },
  live: null,      // { i, n, x, y, h } waehrend einer Zeichnung
  sending: false,
};
const $ = id => document.getElementById(id);
const waiters = [];

function store(k, v) { try { localStorage.setItem('paintbot.' + k, JSON.stringify(v)); } catch (e) {} }
function load(k, d) { try { const v = localStorage.getItem('paintbot.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }

/* ------------------------------------------------------------------ Bluetooth */
class BleLink {
  constructor(onLine, onState) { this.onLine = onLine; this.onState = onState; this.buf = ''; this.q = Promise.resolve(); this.dec = new TextDecoder(); }
  async connect() {
    this.device = await navigator.bluetooth.requestDevice({ filters: [{ services: [NUS_SERVICE] }], optionalServices: [NUS_SERVICE] });
    this.device.addEventListener('gattserverdisconnected', () => this.onState(false));
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(NUS_SERVICE);
    this.rx = await svc.getCharacteristic(NUS_RX);
    this.tx = await svc.getCharacteristic(NUS_TX);
    this.tx.addEventListener('characteristicvaluechanged', ev => this.feed(new Uint8Array(ev.target.value.buffer)));
    await this.tx.startNotifications();
    this.onState(true, this.device.name || 'PaintBot');
  }
  feed(bytes) {
    this.buf += this.dec.decode(bytes, { stream: true });
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      if (line.length) this.onLine(line);
    }
  }
  write(bytes) {
    // GATT erlaubt nur eine Operation gleichzeitig -> Warteschlange, 20-Byte-Stuecke
    this.q = this.q.then(async () => {
      for (let o = 0; o < bytes.length; o += BLE_CHUNK) {
        const part = bytes.slice(o, o + BLE_CHUNK);
        if (this.rx.writeValueWithResponse) await this.rx.writeValueWithResponse(part);
        else await this.rx.writeValue(part);
      }
    }).catch(e => logLine('Senden fehlgeschlagen: ' + e.message, 'err'));
    return this.q;
  }
  disconnect() { try { this.device && this.device.gatt.connected && this.device.gatt.disconnect(); } catch (e) {} }
}

/* Demo: simulierter Roboter mit demselben Protokoll (ohne Hardware ausprobieren). */
class DemoLink {
  constructor(onLine, onState) {
    this.onLine = onLine; this.onState = onState; this.txt = ''; this.pkt = [];
    this.s = { menu: 0, armed: false, tel: false, pen: 0, sp: 1, path: [], run: null, move: null, cfg: JSON.parse(JSON.stringify(DEFAULT_CFG)), f: 120 };
  }
  async connect() {
    this.timer = setInterval(() => this.tick(), 50);
    this.onState(true, 'PaintBot (Demo)');
    this.say('PaintBot Demo -- kein echter Roboter, alle Bewegungen sind simuliert.');
  }
  disconnect() { clearInterval(this.timer); this.onState(false); }
  say(l) { setTimeout(() => this.onLine(l), 15); }
  write(bytes) {
    for (const b of bytes) {
      if (this.pkt.length || b === 0x21) {               // '!'-Paket
        this.pkt.push(b);
        if (this.pkt.length === 5) { this.key(this.pkt); this.pkt = []; }
        continue;
      }
      if (b === 10 || b === 13) { if (this.txt) this.cmd(this.txt); this.txt = ''; }
      else this.txt += String.fromCharCode(b);
    }
    return Promise.resolve();
  }
  key(p) {
    const n = p[2] - 48, down = p[3] === 49, s = this.s;
    if (!down) { if (n === 2 && s.menu === 8) this.arm(!s.armed); return; }
    if (n === 4) { this.setMenu((s.menu + 1) % 9); return; }
    if (n === 3 && s.menu === 1) { s.sp = (s.sp + 1) % 3; this.say('Geschwindigkeit: ' + SPEED_NAMES[s.sp]); return; }
    if (n !== 2) this.say('Demo: Taste ' + n + ' in Menü ' + s.menu);
  }
  setMenu(m) {
    const s = this.s; this.stopAll(); s.menu = m; s.armed = false;
    this.say('== ' + MENUS[m] + ' (Menue ' + m + ') ==');
    if (m === 8) this.say('Fahren GESPERRT -- in der App freigeben oder Taste 2 kurz.');
  }
  arm(on) { this.s.armed = on; if (!on) this.stopAll(); this.say(on ? 'App: Fahren FREIGEGEBEN' : 'App: Fahren GESPERRT'); this.stat(); }
  stopAll() {
    const s = this.s;
    if (s.move) { s.move = null; this.say('@END abort'); }
    if (s.run) { s.run = null; s.pen = 0; this.say('Zeichnung abgebrochen.'); this.say('@END abort'); }
  }
  busy() { return !!(this.s.move || this.s.run); }
  stat() {
    const s = this.s;
    this.say(`@STAT m=${s.menu} a=${s.armed ? 1 : 0} b=${this.busy() ? 1 : 0} f=${s.menu === 8 ? Math.round(s.f) : -1} l=-1 r=-1 pen=${s.pen} sp=${s.sp} sw=${s.menu === 8 ? 1 : 0} run=${s.run ? 1 : 0} pts=${s.path.length} thr=15`);
  }
  cfgLine() {
    const c = this.s.cfg;
    this.say(`@CFG wheel=${c.wheel.toFixed(1)} track=${c.track.toFixed(1)} spr=${c.spr} spt=${(c.track * c.spr / c.wheel).toFixed(1)} mode=${c.mode} menus=8 pmax=${c.pmax} prof=${c.prof.map(p => p.v + '/' + p.a).join(',')} art=${c.art.join(',')} penms=${c.penms} ret=${c.ret} keep=${c.keep}`);
  }
  canDrive() {
    const s = this.s;
    if (s.menu !== 8) { this.say('@ERR menu Fahrbefehle nur in Menue 8 (App-Steuerung)'); return false; }
    if (!s.armed) { this.say('@ERR arm erst Fahrfreigabe (ARM oder Taste 2)'); return false; }
    if (this.busy()) { this.say('@ERR busy Roboter faehrt noch'); return false; }
    return true;
  }
  cmd(line) {
    const s = this.s, [w0, ...rest] = line.trim().split(/\s+/), w = (w0 || '').toUpperCase(), arg = rest.join(' ');
    const c = s.cfg, mmPerStep = Math.PI * c.wheel / c.spr;
    const v = c.prof[s.sp].v * mmPerStep, a = c.prof[s.sp].a * mmPerStep;
    if (w === 'P') {
      const pts = [];
      for (const t of arg.split(';')) {
        if (!t.trim()) continue;
        const m = t.trim().split(',');
        if (m.length !== 3 || m.some(x => isNaN(parseFloat(x)))) { this.say('@ERR parse Punktzeile fehlerhaft'); return; }
        pts.push({ x: +m[0], y: +m[1], pen: +m[2] ? 1 : 0 });
      }
      s.path.push(...pts); this.say('@PATH ' + s.path.length); return;
    }
    switch (w) {
      case 'HELLO': s.tel = true; this.say('@HELLO PaintBot DEMO'); this.cfgLine(); this.stat(); break;
      case 'TELEM': s.tel = arg !== '0'; this.say('@OK TELEM'); break;
      case 'STAT': this.stat(); break;
      case 'CFG': this.cfgLine(); break;
      case 'STOP': this.stopAll(); this.say('@OK STOP'); if (s.menu !== 8) this.setMenu(0); break;
      case 'MENU': { const m = parseInt(arg, 10); if (!(m >= 0 && m <= 8)) { this.say('@ERR arg MENU 0..n'); break; } if (m !== s.menu) this.setMenu(m); this.say('@OK MENU'); break; }
      case 'ARM': case 'DISARM': if (s.menu !== 8) { this.say('@ERR menu Freigabe nur in Menue 8'); break; } this.arm(w === 'ARM'); this.say('@OK ' + w); break;
      case 'FWD': case 'BACK': case 'TURN': {
        const val = parseFloat(arg);
        if (!val || (w !== 'TURN' && (val <= 0 || val > 300)) || Math.abs(val) > 720) { this.say('@ERR arg Wert ausserhalb'); break; }
        if (!this.canDrive()) break;
        const d = w === 'TURN' ? Math.abs(val) * Math.PI / 180 * c.track / 2 : val * 10;
        s.move = { left: moveSec(d, v, a) * 1000 };
        this.say('@OK ' + w); break;
      }
      case 'PEN': if (s.menu !== 8) { this.say('@ERR menu Stift nur in Menue 8'); break; } s.pen = /^d/i.test(arg) ? 1 : 0; this.say('@OK PEN'); break;
      case 'SPEED': { const i = parseInt(arg, 10); if (!(i >= 0 && i <= 2)) { this.say('@ERR arg SPEED 0..2'); break; } s.sp = i; this.say('Geschwindigkeit: ' + SPEED_NAMES[i]); this.say('@OK SPEED'); break; }
      case 'SET': {
        const [k, val] = arg.split(/\s+/), x = parseFloat(val);
        if (/^track$/i.test(k) && x >= 50 && x <= 400) c.track = x;
        else if (/^wheel$/i.test(k) && x >= 20 && x <= 150) c.wheel = x;
        else { this.say('@ERR arg SET TRACK mm | SET WHEEL mm'); break; }
        this.say('Wert gilt bis zum Neustart -- dauerhaft in global.h eintragen.'); this.say('@OK SET'); this.cfgLine(); break;
      }
      case 'PCLR': s.path = []; this.say('@PATH 0'); break;
      case 'PRUN': {
        if (s.path.length < 2) { this.say('@ERR empty keine Zeichnung'); break; }
        if (!this.canDrive()) break;
        const plan = planRobot(s.path, c);
        s.run = { plan, t: 0, nextProg: 0 };
        this.say('App-Zeichnung startet.'); this.say('@RUN ' + s.path.length); break;
      }
      default: this.say('@ERR cmd unbekannter Befehl');
    }
  }
  tick() {
    const s = this.s, dt = 50;
    s.f += (Math.random() - 0.5) * 6; s.f = Math.max(25, Math.min(220, s.f));
    if (s.move) { s.move.left -= dt; if (s.move.left <= 0) { s.move = null; this.say('@DONE'); } }
    if (s.run) {
      const r = s.run, p = r.plan, speedup = 4;     // Demo laeuft 4x schneller als echt
      r.t += dt / 1000 * speedup;
      while (r.nextProg < p.progAt.length && p.progAt[r.nextProg].t <= r.t) {
        const q = p.progAt[r.nextProg];
        this.say(`@PROG ${r.nextProg + 1} ${s.path.length} ${Math.round(q.x)} ${Math.round(q.y)} ${Math.round(q.h)}`);
        r.nextProg++;
      }
      const pose = poseAt(p, r.t); s.pen = pose.pen;
      if (r.t >= p.total) { s.run = null; s.pen = 0; this.say('App-Zeichnung fertig.'); this.say('@END ok'); }
    }
    if (s.tel && (this.lastStat === undefined || Date.now() - this.lastStat > 300)) { this.lastStat = Date.now(); this.stat(); }
  }
}

/* ------------------------------------------------------------------ Senden */
const enc = new TextEncoder();
function sendText(t) {
  if (!st.connected) { logLine('Nicht verbunden -- „' + t + '“ nicht gesendet.', 'err'); return false; }
  logLine('> ' + t, 'tx');
  st.link.write(enc.encode(t + '\n'));
  return true;
}
function keyPacket(n, pressed) {
  const b = [0x21, 0x42, 48 + n, pressed ? 49 : 48];
  const sum = b.reduce((x, y) => x + y, 0);
  b.push((~sum) & 0xff);
  return new Uint8Array(b);
}
function sendKey(n, pressed) {
  if (!st.connected) return;
  st.link.write(keyPacket(n, pressed));
  if (pressed) logLine('> Taste ' + (n > 4 ? ['▲', '▼', '◀', '▶'][n - 5] : n), 'tx');
}
/* Auf eine Antwortzeile warten (z. B. /^@PATH (\d+)/). @ERR beendet mit Fehler. */
function expect(re, ms = 4000, failOnErr = true) {
  return new Promise((res, rej) => {
    const w = { re, res, rej, failOnErr };
    w.timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('keine Antwort vom Roboter')); }, ms);
    waiters.push(w);
  });
}

/* ------------------------------------------------------------------ Empfangen */
function parseKV(s) {
  const o = {};
  for (const t of s.split(/\s+/)) { const i = t.indexOf('='); if (i > 0) o[t.slice(0, i)] = t.slice(i + 1); }
  return o;
}
function handleLine(line) {
  const machine = line.startsWith('@');
  logLine(line, machine ? 'm' : '');
  for (const w of [...waiters]) {
    const m = line.match(w.re);
    if (m) { clearTimeout(w.timer); waiters.splice(waiters.indexOf(w), 1); w.res(m); }
    else if (w.failOnErr && line.startsWith('@ERR')) { clearTimeout(w.timer); waiters.splice(waiters.indexOf(w), 1); w.rej(new Error(line.slice(5))); }
  }
  if (!machine) return;
  const sp = line.indexOf(' '), tag = sp < 0 ? line : line.slice(0, sp), rest = sp < 0 ? '' : line.slice(sp + 1);
  switch (tag) {
    case '@HELLO': st.fw = rest; $('fwver').textContent = rest; break;
    case '@STAT': {
      const o = parseKV(rest);
      st.menu = +o.m; st.armed = o.a === '1'; st.busy = o.b === '1'; st.f = +o.f; st.l = +o.l; st.r = +o.r;
      st.pen = +o.pen; st.sp = +o.sp; st.sw = +o.sw; st.run = +o.run; st.pts = +o.pts; st.thr = +o.thr || 15;
      renderStatus(); break;
    }
    case '@CFG': {
      const o = parseKV(rest), c = st.cfg;
      for (const k of ['wheel', 'track', 'spr', 'spt', 'menus', 'pmax', 'penms', 'ret', 'keep']) if (o[k] !== undefined) c[k] = +o[k];
      if (o.mode) c.mode = o.mode;
      if (o.prof) c.prof = o.prof.split(',').map(t => { const [v, a] = t.split('/'); return { v: +v, a: +a }; });
      if (o.art) c.art = o.art.split(',').map(Number);
      renderCfg(); recomputePlan(); break;
    }
    case '@PROG': {
      const [i, n, x, y, h] = rest.split(/\s+/).map(Number);
      st.live = { i, n, x, y, h }; renderLive(); break;
    }
    case '@END': if (st.live) { st.live.done = rest; renderLive(); } st.busy = false; renderStatus(); break;
    case '@DONE': st.busy = false; renderStatus(); break;
    case '@OK': if (/^(FWD|BACK|TURN)/.test(rest)) { st.busy = true; renderStatus(); } break;
    case '@EVT': if (/^obst/.test(rest)) logLine('Hindernis -- Fahrt angehalten.', 'err'); break;
  }
}

/* ------------------------------------------------------------------ Verbindung */
function onState(connected, name) {
  st.connected = connected;
  if (!connected) { st.menu = null; st.armed = false; st.busy = false; st.live = null; $('fwver').textContent = 'nicht verbunden'; logLine('Verbindung getrennt.', 'err'); }
  else { logLine('Verbunden mit ' + name + '.'); if (st.demo) $('noBt').hidden = true; setTimeout(() => sendText('HELLO'), 150); }
  $('conndot').className = 'dot' + (connected ? (st.demo ? ' demo' : ' on') : '');
  $('btnConnect').textContent = connected ? 'Trennen' : 'Verbinden';
  $('btnDemo').hidden = connected && !st.demo;
  $('btnDemo').textContent = connected && st.demo ? 'Demo beenden' : 'Demo';
  renderStatus();
}
async function connect(demo) {
  if (st.connected) { st.link.disconnect(); return; }
  st.demo = demo;
  st.link = demo ? new DemoLink(handleLine, onState) : new BleLink(handleLine, onState);
  try { await st.link.connect(); }
  catch (e) {
    if (e.name !== 'NotFoundError') logLine('Verbinden fehlgeschlagen: ' + e.message, 'err');
    st.link = null;
  }
}

/* ------------------------------------------------------------------ Protokoll */
function logLine(text, cls = '') {
  const box = $('loglines'); if (!box) return;
  const d = document.createElement('div');
  if (cls) d.className = cls;
  const t = new Date();
  d.textContent = t.toTimeString().slice(0, 8) + '  ' + text;
  if (cls === 'm' && !$('chkRaw').checked) d.hidden = true;
  box.appendChild(d);
  while (box.childElementCount > 600) box.firstElementChild.remove();
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 80 || cls === 'tx') box.scrollTop = box.scrollHeight;
}

/* ------------------------------------------------------------------ Statusanzeige */
function pill(text, kind) { return `<span class="pill ${kind || ''}">${text}</span>`; }
function renderStatus() {
  const c = st.connected, m = st.menu;
  $('sMenu').textContent = c && m != null ? m + ' · ' + (MENUS[m] || '?') : '–';
  $('sArm').innerHTML = !c || m == null ? pill('–') : m === 8 ? (st.armed ? pill('frei', 'good') : pill('gesperrt', 'warn')) : pill('nur Menü 8');
  $('sBusy').innerHTML = !c ? '–' : st.run ? pill('zeichnet', 'good') : st.busy ? pill('fährt', 'good') : pill('steht');
  $('sPen').textContent = c ? (st.pen ? 'unten' : 'oben') : '–';
  $('sSpeed').textContent = c ? SPEED_NAMES[st.sp] || '–' : '–';
  for (const [k, v] of [['F', st.f], ['L', st.l], ['R', st.r]]) {
    const ok = c && v >= 0;
    $('d' + k).textContent = ok ? v + ' cm' : '–';
    const bar = $('b' + k);
    bar.style.width = ok ? Math.min(100, v) + '%' : '0';
    bar.style.background = ok && v < st.thr ? 'var(--stop)' : ok && v < st.thr * 2 ? 'var(--warn)' : 'var(--ok)';
  }
  // Tastenbelegung + Menueliste
  const km = KEYMAPS[m] || KEYMAPS[0];
  $('kmTitle').textContent = m == null ? 'Tastenbelegung' : 'Tasten in Menü ' + m + ' · ' + MENUS[m];
  $('keymap').innerHTML = km.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') + '<dt>T4</dt><dd>nächstes Menü</dd>';
  document.querySelectorAll('#menus button').forEach(b => b.classList.toggle('cur', +b.dataset.m === m));
  renderFahren();
}
function driveReady() { return st.connected && st.menu === 8 && st.armed && !st.busy && !st.run; }
function renderFahren() {
  const b = $('fahrBanner');
  let html, ok = false;
  if (!st.connected) html = 'Nicht verbunden. Oben auf <b>Verbinden</b> tippen (oder <b>Demo</b> zum Ausprobieren).';
  else if (st.menu !== 8) html = `Fahrbefehle der App gehen nur im Menü 8 (App-Steuerung). <button class="btn small" data-act="menu8">Menü 8 öffnen</button>`;
  else if (!st.armed) html = `Fahren ist gesperrt. <button class="btn small primary" data-act="arm">Fahren freigeben</button>`;
  else { ok = true; html = `Fahren freigegeben. <button class="btn small" data-act="disarm">Sperren</button>`; }
  b.innerHTML = html; b.classList.toggle('ok', ok);
  const r = driveReady();
  ['btnFwd', 'btnBack', 'btnLeft', 'btnRight'].forEach(id => $(id).disabled = !r);
  document.querySelectorAll('#quickDist button, #quickTurn button').forEach(x => x.disabled = !r);
  const penOk = st.connected && st.menu === 8 && !st.run;
  $('btnPenUp').disabled = !penOk; $('btnPenDown').disabled = !penOk;
  document.querySelectorAll('#speedBtns button').forEach(x => { x.disabled = !st.connected; x.classList.toggle('on', +x.dataset.sp === st.sp); });
}
function renderCfg() {
  const c = st.cfg, mm = Math.PI * c.wheel / c.spr;
  $('cfgList').innerHTML = [
    ['Raddurchmesser', c.wheel.toFixed(1) + ' mm'], ['Spurweite', c.track.toFixed(1) + ' mm'],
    ['Schrittmodus', c.mode], ['Schritte / Radumdrehung', c.spr], ['Schritte / 360°', (+c.spt).toFixed(0)],
    ['Weg pro Schritt', mm.toFixed(3) + ' mm'],
    ...c.prof.map((p, i) => [SPEED_NAMES[i], (p.v * mm / 10).toFixed(1) + ' cm/s']),
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  $('cfgLines').textContent = `#define WHEEL_DIAMETER_MM ${c.wheel.toFixed(1)}\n#define TRACK_WIDTH_MM    ${c.track.toFixed(1)}`;
  updateCal();
}
function updateCal() {
  const c = st.cfg;
  const tc = +$('calTurnCmd').value, ta = +$('calTurnAct').value;
  const nt = tc > 0 && ta > 0 ? c.track * tc / ta : NaN;
  $('calTurnOut').textContent = isFinite(nt) ? `Neue Spurweite: ${c.track.toFixed(1)} × ${tc} / ${ta} = ${nt.toFixed(1)} mm` : '';
  $('btnCalTurn').disabled = !st.connected || !isFinite(nt) || nt < 50 || nt > 400;
  $('btnCalTurn').dataset.v = nt.toFixed(1);
  const dc = +$('calDistCmd').value, da = +$('calDistAct').value;
  const nw = dc > 0 && da > 0 ? c.wheel * da / dc : NaN;
  $('calDistOut').textContent = isFinite(nw) ? `Neuer Raddurchmesser: ${c.wheel.toFixed(1)} × ${da} / ${dc} = ${nw.toFixed(1)} mm (Spurweite bleibt)` : '';
  $('btnCalDist').disabled = !st.connected || !isFinite(nw) || nw < 20 || nw > 150;
  $('btnCalDist').dataset.v = nw.toFixed(1);
}

/* ------------------------------------------------------------------ Pfadplanung */
/* Dauer einer Bewegung ueber d mm bei Endtempo v (mm/s) und Beschleunigung a (mm/s^2)
   -- wie artMoveSec() in GenerativeArt.ino (Trapez bzw. Dreieck). */
function moveSec(d, v, a) {
  if (d <= 0 || v <= 0 || a <= 0) return 0;
  if (d < v * v / a) return 2 * Math.sqrt(d / a);
  return d / v + v / a;
}
function normDeg(d) { while (d > 180) d -= 360; while (d <= -180) d += 360; return d; }

/* points: [{x,y,pen}] in mm (Blattmitte = 0,0). Liefert eine Zeitleiste von Aktionen. */
function planRobot(points, c) {
  const mm = Math.PI * c.wheel / c.spr;
  const lp = c.prof[c.art[0]] || c.prof[0], tp = c.prof[c.art[1]] || c.prof[2];
  const vL = lp.v * mm, aL = lp.a * mm, vT = tp.v * mm, aT = tp.a * mm;
  const wheelPerDeg = Math.PI / 180 * c.track / 2, penS = c.penms / 1000;
  const acts = [], progAt = [];
  let x = 0, y = 0, h = 0, pen = 0, t = 0;
  const st = { draw: 0, travel: 0, turnDeg: 0, lowerings: 0, skipped: 0 };
  const setPen = (p, pi) => { if (p !== pen) { acts.push({ type: 'pen', t0: t, t1: t + penS, x, y, h, pen: p, pi }); t += penS; if (p) st.lowerings++; pen = p; } };
  const go = (tx, ty, tpen, pi) => {
    const dx = tx - x, dy = ty - y, d = Math.hypot(dx, dy);
    if (d < MIN_SEG_MM) { st.skipped++; return; }
    const head = Math.atan2(dy, dx) * 180 / Math.PI, turn = normDeg(head - h);
    setPen(c.keep && tpen && pen ? 1 : 0, pi);
    if (Math.abs(turn) > 1e-6) {
      const dur = moveSec(Math.abs(turn) * wheelPerDeg, vT, aT);
      acts.push({ type: 'turn', t0: t, t1: t + dur, x, y, h0: h, h1: h + turn, pen, pi }); t += dur;
      st.turnDeg += Math.abs(turn);
    }
    h = normDeg(head);
    setPen(tpen ? 1 : 0, pi);
    const dur = moveSec(d, vL, aL);
    acts.push({ type: 'drive', t0: t, t1: t + dur, x0: x, y0: y, x1: tx, y1: ty, h, pen, pi }); t += dur;
    if (tpen) st.draw += d; else st.travel += d;
    x = tx; y = ty;
  };
  points.forEach((p, i) => { progAt.push({ t, x, y, h }); go(p.x, p.y, p.pen ? 1 : 0, i); });
  if (c.ret) go(0, 0, 0, points.length);
  setPen(0, points.length);
  if (c.ret && Math.abs(normDeg(-h)) > 1e-6) {
    const turn = normDeg(-h), dur = moveSec(Math.abs(turn) * wheelPerDeg, vT, aT);
    acts.push({ type: 'turn', t0: t, t1: t + dur, x, y, h0: h, h1: h + turn, pen: 0, pi: points.length }); t += dur;
    st.turnDeg += Math.abs(turn); h = 0;
  }
  return { acts, progAt, total: t, stats: st };
}
function poseAt(plan, t) {
  let pose = { x: 0, y: 0, h: 0, pen: 0 };
  for (const a of plan.acts) {
    if (t < a.t0) break;
    const f = a.t1 > a.t0 ? Math.min(1, (t - a.t0) / (a.t1 - a.t0)) : 1;
    if (a.type === 'drive') pose = { x: a.x0 + (a.x1 - a.x0) * f, y: a.y0 + (a.y1 - a.y0) * f, h: a.h, pen: a.pen };
    else if (a.type === 'turn') pose = { x: a.x, y: a.y, h: a.h0 + (a.h1 - a.h0) * f, pen: a.pen };
    else pose = { x: a.x, y: a.y, h: a.h, pen: f >= 1 ? a.pen : pose.pen };
  }
  return pose;
}

/* ------------------------------------------------------------------ Zeichnung */
const draw = {
  strokes: load('strokes', []),      // [[ [x,y], ... ], ...] in mm
  paper: load('paper', 'A3'),
  tool: 'free', snap: +load('snap', 0),
  cur: null,                          // Stroke, der gerade entsteht
  plan: null, points: [],
  playT: null, playing: false,
  history: [],                        // Rueckgaengig-Stapel (JSON-Kopien)
};
function paperSize() { return PAPERS[draw.paper] || PAPERS.A3; }

function rdp(pts, eps) {   // Ramer-Douglas-Peucker
  if (pts.length < 3) return pts.slice();
  let idx = 0, dmax = 0;
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1], L = Math.hypot(bx - ax, by - ay) || 1e-9;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i];
    const d = Math.abs((by - ay) * px - (bx - ax) * py + bx * ay - by * ax) / L;
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax <= eps) return [pts[0], pts[pts.length - 1]];
  return rdp(pts.slice(0, idx + 1), eps).slice(0, -1).concat(rdp(pts.slice(idx), eps));
}
function buildPoints() {
  let strokes = draw.strokes.filter(s => s.length >= 2).map(s => s.slice());
  if ($('chkOpt').checked) {           // naechster Nachbar, Strich ggf. umgedreht
    const out = []; let cx = 0, cy = 0;
    while (strokes.length) {
      let best = 0, bestD = Infinity, rev = false;
      strokes.forEach((s, i) => {
        const d0 = Math.hypot(s[0][0] - cx, s[0][1] - cy), d1 = Math.hypot(s[s.length - 1][0] - cx, s[s.length - 1][1] - cy);
        if (d0 < bestD) { bestD = d0; best = i; rev = false; }
        if (d1 < bestD) { bestD = d1; best = i; rev = true; }
      });
      const s = strokes.splice(best, 1)[0]; if (rev) s.reverse();
      out.push(s); [cx, cy] = s[s.length - 1];
    }
    strokes = out;
  }
  const pts = [];
  for (const s of strokes) {
    s.forEach((p, i) => pts.push({ x: Math.round(p[0] * 10) / 10, y: Math.round(p[1] * 10) / 10, pen: i ? 1 : 0 }));
  }
  return pts;
}
function recomputePlan() {
  draw.points = buildPoints();
  draw.plan = draw.points.length ? planRobot(draw.points, st.cfg) : null;
  renderPlanStats();
  render();
}
function fmtTime(s) { s = Math.round(s); return Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0') + ' s'; }
function renderPlanStats() {
  const p = draw.plan, [W, H] = paperSize(), warn = [];
  if (!p) { $('planStats').innerHTML = '<dt>Noch nichts gezeichnet</dt><dd></dd>'; $('planWarn').innerHTML = ''; $('btnSend').disabled = true; return; }
  const s = p.stats;
  $('planStats').innerHTML = [
    ['Punkte', draw.points.length], ['Linien', (s.draw / 10).toFixed(1) + ' cm'], ['Leerfahrt', (s.travel / 10).toFixed(1) + ' cm'],
    ['Stift aufsetzen', s.lowerings + '×'], ['Drehungen gesamt', Math.round(s.turnDeg) + '°'], ['Dauer ca.', fmtTime(p.total)],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  const out = draw.points.filter(q => Math.abs(q.x) > W / 2 || Math.abs(q.y) > H / 2).length;
  const edge = draw.points.filter(q => Math.abs(q.x) > W / 2 - 10 || Math.abs(q.y) > H / 2 - 10).length;
  if (out) warn.push(out + ' Punkte liegen außerhalb des Blatts.');
  else if (edge) warn.push(edge + ' Punkte liegen näher als 1 cm am Rand.');
  if (draw.points.length > st.cfg.pmax) warn.push(`Zu viele Punkte (${draw.points.length}, höchstens ${st.cfg.pmax}).`);
  $('planWarn').innerHTML = warn.map(w => `<li>${w}</li>`).join('');
  $('btnSend').disabled = !!out || draw.points.length > st.cfg.pmax || draw.points.length < 2 || st.sending;
}

/* Vorlagen in mm */
function template(name) {
  const S = [];
  if (name === 'square') S.push([[-50, -50], [50, -50], [50, 50], [-50, 50], [-50, -50]]);
  if (name === 'nikolaus') S.push([[-40, -50], [40, -50], [-40, 20], [40, 20], [0, 70], [-40, 20], [-40, -50], [40, 20], [40, -50]]);
  if (name === 'star') { const s = []; for (let i = 0; i <= 5; i++) { const a = Math.PI / 2 + i * 4 * Math.PI / 5; s.push([80 * Math.cos(a), 80 * Math.sin(a)]); } S.push(s); }
  if (name === 'spiral') { const s = []; for (let a = 0; a <= 8 * Math.PI; a += 0.15) s.push([a * 3.6 * Math.cos(a), a * 3.6 * Math.sin(a)]); S.push(s); }
  if (name === 'heart') { const s = []; for (let a = 0; a <= 2 * Math.PI + 0.01; a += 0.08) s.push([5 * 16 * Math.sin(a) ** 3, 5 * (13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a))]); S.push(s); }
  return S.map(s => s.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]));
}

/* ------------------------------------------------------------------ Leinwand */
const cv = $('cv'), ctx = cv.getContext('2d');
let view = { s: 1, cx: 0, cy: 0 };
function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function resizeCanvas() {
  const r = $('cbox').getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(r.width * dpr)); cv.height = Math.max(1, Math.round(r.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const [W, H] = paperSize(), pad = 14;
  view.s = Math.min((r.width - 2 * pad) / W, (r.height - 2 * pad) / H);
  view.cx = r.width / 2; view.cy = r.height / 2;
  render();
}
const toPx = (x, y) => [view.cx + x * view.s, view.cy - y * view.s];
function toMm(ev) {
  const r = cv.getBoundingClientRect();
  let x = (ev.clientX - r.left - view.cx) / view.s, y = -(ev.clientY - r.top - view.cy) / view.s;
  if (draw.snap && draw.tool !== 'free') { x = Math.round(x / draw.snap) * draw.snap; y = Math.round(y / draw.snap) * draw.snap; }
  return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
}
function pathLine(pts) { ctx.beginPath(); pts.forEach((p, i) => { const [a, b] = toPx(p[0], p[1]); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); }); }
function drawRobot(x, y, h, color) {
  const [px, py] = toPx(x, y), r = Math.max(6, (st.cfg.track / 2 + 12) * view.s), a = -h * Math.PI / 180;
  ctx.save();
  ctx.globalAlpha = 0.08; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(px, py, r, 0, 7); ctx.fill();
  ctx.globalAlpha = 1; ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(px, py, r, 0, 7); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + Math.cos(a) * r * 1.25, py + Math.sin(a) * r * 1.25); ctx.stroke();
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(px, py, 3, 0, 7); ctx.fill();
  ctx.restore();
}
function render() {
  const r = cv.getBoundingClientRect(); if (!r.width) return;
  const [W, H] = paperSize();
  ctx.clearRect(0, 0, r.width, r.height);
  // Blatt + Raster
  const [x0, y0] = toPx(-W / 2, H / 2);
  ctx.fillStyle = css('--paper'); ctx.fillRect(x0, y0, W * view.s, H * view.s);
  ctx.strokeStyle = css('--grid'); ctx.lineWidth = 1;
  const step = view.s * 10 < 6 ? 50 : 10;
  ctx.beginPath();
  for (let gx = -Math.floor(W / 2 / step) * step; gx <= W / 2; gx += step) { const [a] = toPx(gx, 0); ctx.moveTo(a, y0); ctx.lineTo(a, y0 + H * view.s); }
  for (let gy = -Math.floor(H / 2 / step) * step; gy <= H / 2; gy += step) { const [, b] = toPx(0, gy); ctx.moveTo(x0, b); ctx.lineTo(x0 + W * view.s, b); }
  ctx.stroke();
  ctx.strokeStyle = '#9aa3b2'; ctx.setLineDash([4, 4]);
  const [mx, my] = toPx(-W / 2 + 10, H / 2 - 10); ctx.strokeRect(mx, my, (W - 20) * view.s, (H - 20) * view.s);
  ctx.setLineDash([]);
  ctx.fillStyle = '#7b8494'; ctx.font = '11px ' + css('--font-data');
  ctx.fillText(`${draw.paper} · ${W} × ${H} mm`, x0 + 6, y0 + 14);

  const plan = draw.plan, showPlan = $('chkPlan').checked && plan;
  const tNow = st.live && plan ? liveTime() : (draw.playT != null && plan ? draw.playT : null);
  const ink = css('--accent'), travel = css('--travel');

  if (!showPlan || tNow == null) {
    // Entwurf: alle Striche
    ctx.strokeStyle = ink; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const s of draw.strokes) { if (s.length > 1) { pathLine(s); ctx.stroke(); } }
  }
  if (showPlan) {
    const tEnd = tNow == null ? Infinity : tNow;
    ctx.lineCap = 'round';
    for (const a of plan.acts) {
      if (a.type !== 'drive') continue;
      const f = a.t0 >= tEnd ? 0 : Math.min(1, (tEnd - a.t0) / Math.max(1e-9, a.t1 - a.t0));
      const [p0x, p0y] = toPx(a.x0, a.y0), [p1x, p1y] = toPx(a.x1, a.y1);
      if (tNow != null && f < 1) {   // noch nicht gefahren: blass
        ctx.globalAlpha = 0.22; ctx.strokeStyle = a.pen ? ink : travel; ctx.lineWidth = a.pen ? 1.6 : 1.2;
        ctx.setLineDash(a.pen ? [] : [5, 4]); ctx.beginPath(); ctx.moveTo(p0x, p0y); ctx.lineTo(p1x, p1y); ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (f > 0) {
        ctx.strokeStyle = a.pen ? ink : travel; ctx.lineWidth = a.pen ? 2 : 1.2; ctx.setLineDash(a.pen ? [] : [5, 4]);
        ctx.beginPath(); ctx.moveTo(p0x, p0y); ctx.lineTo(p0x + (p1x - p0x) * f, p0y + (p1y - p0y) * f); ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    // Drehpunkte und Pfeile auf Leerfahrten
    ctx.fillStyle = travel;
    for (const a of plan.acts) {
      if (a.type === 'turn') { const [px, py] = toPx(a.x, a.y); ctx.beginPath(); ctx.arc(px, py, 2.2, 0, 7); ctx.fill(); }
      if (a.type === 'drive' && !a.pen) {
        const [p0x, p0y] = toPx(a.x0, a.y0), [p1x, p1y] = toPx(a.x1, a.y1), L = Math.hypot(p1x - p0x, p1y - p0y);
        if (L > 30) { const ang = Math.atan2(p1y - p0y, p1x - p0x), mxp = (p0x + p1x) / 2, myp = (p0y + p1y) / 2;
          ctx.beginPath(); ctx.moveTo(mxp + Math.cos(ang) * 6, myp + Math.sin(ang) * 6);
          ctx.lineTo(mxp + Math.cos(ang + 2.5) * 6, myp + Math.sin(ang + 2.5) * 6); ctx.lineTo(mxp + Math.cos(ang - 2.5) * 6, myp + Math.sin(ang - 2.5) * 6); ctx.fill(); }
      }
    }
  }
  // Strich in Arbeit
  if (draw.cur && draw.cur.length) {
    ctx.strokeStyle = ink; ctx.lineWidth = 1.6; pathLine(draw.cur.concat(draw.hover ? [draw.hover] : [])); ctx.stroke();
  }
  // Roboter
  if (st.live && st.live.done !== 'ok' && st.live.done !== 'abort') drawRobot(st.live.x, st.live.y, st.live.h, css('--ok'));
  else if (showPlan && tNow != null) { const p = poseAt(plan, tNow); drawRobot(p.x, p.y, p.h, css('--fg')); }
  else drawRobot(0, 0, 0, '#7b8494');
}
function liveTime() {
  const l = st.live, p = draw.plan;
  if (l.done === 'ok') return p.total;
  const q = p.progAt[Math.max(0, Math.min(p.progAt.length - 1, l.i - 1))];
  return q ? q.t : 0;
}
function renderLive() {
  const l = st.live; if (!l) return;
  const pr = $('sendProg'); pr.hidden = false; pr.max = l.n; pr.value = l.done === 'ok' ? l.n : Math.max(0, l.i - 1);
  $('sendInfo').textContent = l.done === 'ok' ? 'Fertig gezeichnet.' : l.done === 'abort' ? 'Abgebrochen.' : `Zeichnet: Punkt ${l.i} von ${l.n}`;
  render();
}

/* Zeichenwerkzeuge */
function pointerDown(ev) {
  if (st.live && !st.live.done) return;
  cv.setPointerCapture(ev.pointerId);
  const p = toMm(ev);
  if (draw.tool === 'line') { draw.cur = draw.cur || []; draw.cur.push(p); $('btnFinish').hidden = false; render(); return; }
  draw.start = p; draw.cur = [p]; draw.down = true;
}
function pointerMove(ev) {
  const p = toMm(ev);
  if (draw.tool === 'line' && draw.cur) { draw.hover = p; render(); return; }
  if (!draw.down) return;
  if (draw.tool === 'free') { const q = draw.cur[draw.cur.length - 1]; if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= 0.6) draw.cur.push(p); }
  else if (draw.tool === 'rect') { const [a, b] = draw.start; draw.cur = [[a, b], [p[0], b], p, [a, p[1]], [a, b]]; }
  else if (draw.tool === 'circle') {
    const [a, b] = draw.start, rr = Math.hypot(p[0] - a, p[1] - b), n = Math.max(24, Math.min(120, Math.ceil(2 * Math.PI * rr / 4)));
    draw.cur = []; for (let i = 0; i <= n; i++) { const t = i / n * 2 * Math.PI; draw.cur.push([Math.round((a + rr * Math.cos(t)) * 10) / 10, Math.round((b + rr * Math.sin(t)) * 10) / 10]); }
  }
  render();
}
function pointerUp() {
  if (!draw.down) return;
  draw.down = false;
  let s = draw.cur; draw.cur = null;
  if (draw.tool === 'free') s = rdp(s, 0.5);
  if (s && s.length >= 2 && pathLen(s) >= 1) addStroke(s);
  render();
}
function finishLine() {
  if (draw.cur && draw.cur.length >= 2) addStroke(draw.cur);
  draw.cur = null; draw.hover = null; $('btnFinish').hidden = true; render();
}
function pathLen(s) { let L = 0; for (let i = 1; i < s.length; i++) L += Math.hypot(s[i][0] - s[i - 1][0], s[i][1] - s[i - 1][1]); return L; }
function snapshot() { draw.history.push(JSON.stringify(draw.strokes)); if (draw.history.length > 100) draw.history.shift(); }
function addStroke(s) { snapshot(); draw.strokes.push(s); saveDrawing(); }
function saveDrawing() {
  store('strokes', draw.strokes); draw.playT = null;
  if (st.live && st.live.done) st.live = null;
  recomputePlan();
}

/* Vorschau abspielen */
function play() {
  if (!draw.plan) return;
  if (draw.playing) { draw.playing = false; $('btnPlay').textContent = '▶ Abspielen'; return; }
  draw.playing = true; $('btnPlay').textContent = '❚❚ Anhalten';
  if (draw.playT == null || draw.playT >= draw.plan.total) draw.playT = 0;
  let last = performance.now();
  const stepFn = now => {
    if (!draw.playing) return;
    draw.playT += (now - last) / 1000 * +$('selPlaySpeed').value; last = now;
    if (draw.playT >= draw.plan.total) { draw.playT = draw.plan.total; draw.playing = false; $('btnPlay').textContent = '▶ Abspielen'; }
    $('rngScrub').value = Math.round(draw.playT / draw.plan.total * 1000);
    render();
    if (draw.playing) requestAnimationFrame(stepFn);
  };
  requestAnimationFrame(stepFn);
}

/* Eine Zeile der Zeichnung senden (PCLR oder P ...) und auf "@PATH want" warten.
   Fix 23.10.2026: Geht die Bestaetigung unterwegs verloren, wird nicht sofort
   abgebrochen. Stattdessen fragt die App mit STAT nach, wie viele Punkte der Roboter
   hat ("pts="): stimmt die Zahl schon, war nur die Antwort weg; steht sie noch auf
   dem alten Wert, kam die Zeile nicht an und wird wiederholt. So entstehen keine
   doppelten Punkte. */
async function sendPathLine(line, prev, want, tries = 4) {
  let send = true;
  for (let t = 1; t <= tries; t++) {
    if (send) {
      st.link.write(enc.encode(line + '\n'));
      try {
        const m = await expect(/^@PATH (\d+)$/, 5000);
        if (+m[1] === want) return;
        throw new Error(`Roboter meldet ${m[1]} statt ${want} Punkte`);
      } catch (e) {
        if (!/keine Antwort/.test(e.message)) throw e;
      }
    }
    logLine(`Keine Bestätigung für ${line.startsWith('P ') ? 'Punkte ab ' + prev : line} – frage beim Roboter nach (Versuch ${t}/${tries}) …`, 'err');
    let pts = null;
    for (let k = 0; k < 2 && pts === null; k++) {
      sendText('STAT');
      try { pts = +(await expect(/^@STAT .*\bpts=(\d+)/, 4000, false))[1]; } catch (e) { /* nochmal */ }
    }
    if (pts === null) { send = false; continue; }   // Stand unbekannt: nicht blind wiederholen (doppelte Punkte)
    if (pts === want) return;                       // angekommen, nur die Antwort fehlte
    if (pts !== prev) throw new Error(`Roboter hat ${pts} Punkte, erwartet ${prev} – bitte neu senden`);
    send = true;                                    // Zeile kam nicht an -> wiederholen
  }
  throw new Error('keine Antwort vom Roboter (mehrere Versuche). Firmware V13a aufgespielt? Siehe Protokoll.');
}

/* Zeichnung senden */
async function sendDrawing() {
  if (!st.connected) { logLine('Erst verbinden.', 'err'); return; }
  const pts = draw.points; if (pts.length < 2) return;
  st.sending = true; renderPlanStats();
  const pr = $('sendProg'), info = $('sendInfo');
  pr.hidden = false; pr.max = pts.length; pr.value = 0; st.live = null;
  try {
    if (st.menu !== 8) { info.textContent = 'Wechsle in Menü 8 …'; sendText('MENU 8'); await expect(/^@OK MENU/); await new Promise(r => setTimeout(r, 300)); }
    info.textContent = 'Übertrage Zeichnung …';
    logLine('> PCLR', 'tx');
    await sendPathLine('PCLR', 0, 0);
    for (let i = 0; i < pts.length; i += POINTS_PER_LINE) {
      const chunk = pts.slice(i, i + POINTS_PER_LINE);
      const line = 'P ' + chunk.map(p => `${+p.x.toFixed(1)},${+p.y.toFixed(1)},${p.pen}`).join(';');
      await sendPathLine(line, i, i + chunk.length);   // nicht ins Protokoll, sonst wird es unlesbar
      pr.value = i + chunk.length;
    }
    logLine(`Zeichnung übertragen: ${pts.length} Punkte.`);
    info.textContent = 'Übertragen. Bitte bestätigen.';
    const ok = await confirmRun();
    if (!ok) { info.textContent = 'Übertragen, nicht gestartet. „An Roboter senden“ startet neu.'; return; }
    if (!st.armed) { sendText('ARM'); await expect(/^@OK ARM/); }
    sendText('PRUN'); await expect(/^@RUN \d+/);
    st.live = { i: 0, n: pts.length, x: 0, y: 0, h: 0 }; renderLive();
  } catch (e) {
    info.textContent = 'Fehler: ' + e.message; logLine('Zeichnung: ' + e.message, 'err');
  } finally { st.sending = false; renderPlanStats(); }
}
function confirmRun() {
  return new Promise(res => {
    const d = $('dlgRun');
    $('dlgPaper').textContent = draw.paper;
    $('dlgInfo').textContent = `${draw.points.length} Punkte, Dauer ca. ${fmtTime(draw.plan.total)}. Abbrechen jederzeit mit Stop.`;
    const done = v => { d.close(); $('dlgGo').onclick = $('dlgCancel').onclick = null; res(v); };
    $('dlgGo').onclick = () => done(true); $('dlgCancel').onclick = () => done(false);
    d.showModal();
  });
}
function confirmArm() {
  const d = $('dlgArm');
  $('dlgArmYes').onclick = () => { d.close(); sendText('ARM'); };
  $('dlgArmNo').onclick = () => d.close();
  d.showModal();
}

/* ------------------------------------------------------------------ Aufbau */
function setTab(name) {
  if (name === 'log' && matchMedia('(min-width: 1000px)').matches) name = 'steuer';
  document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === name));
  document.querySelectorAll('section.pane').forEach(p => p.hidden = p.id !== 'pane-' + name);
  const aside = $('logAside'), logPane = $('pane-log'), box = $('logBox');
  if (name === 'log') { logPane.appendChild(box); } else if (box.parentElement !== aside) aside.appendChild(box);
  aside.hidden = name === 'log';
  store('tab', name);
  if (name === 'zeichnen') requestAnimationFrame(resizeCanvas);
}
function setTheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; store('theme', t); render(); }

function init() {
  if (!navigator.bluetooth) $('noBt').hidden = false;
  setTheme(load('theme', ''));
  $('btnConnect').onclick = () => { if (!navigator.bluetooth && !st.connected) { $('noBt').hidden = false; return; } connect(false); };
  $('btnDemo').onclick = () => connect(true);
  $('btnStop').onclick = () => { sendText('STOP'); draw.playing = false; };
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => setTab(b.dataset.tab));

  // Tasten
  document.querySelectorAll('.key').forEach(k => {
    const n = +k.dataset.key;
    const down = ev => { ev.preventDefault(); if (k.classList.contains('down')) return; k.classList.add('down'); try { k.setPointerCapture(ev.pointerId); } catch (e) {} sendKey(n, true); };
    const up = () => { if (!k.classList.contains('down')) return; k.classList.remove('down'); sendKey(n, false); };
    k.addEventListener('pointerdown', down);
    k.addEventListener('pointerup', up); k.addEventListener('pointercancel', up); k.addEventListener('lostpointercapture', up);
  });
  const keyFor = { ArrowUp: 5, ArrowDown: 6, ArrowLeft: 7, ArrowRight: 8, '1': 1, '2': 2, '3': 3, '4': 4 };
  const typing = () => /INPUT|SELECT|TEXTAREA/.test(document.activeElement && document.activeElement.tagName);
  window.addEventListener('keydown', ev => {
    if (typing()) return;
    if (ev.key === ' ' || ev.key === 'Escape') { ev.preventDefault(); if (draw.tool === 'line' && draw.cur && ev.key === 'Escape') { draw.cur = null; $('btnFinish').hidden = true; render(); return; } sendText('STOP'); return; }
    if (ev.key === 'Enter' && draw.cur) { finishLine(); return; }
    const n = keyFor[ev.key]; if (!n || ev.repeat || ev.ctrlKey || ev.metaKey) return;
    if ($('pane-steuer').hidden) return;
    ev.preventDefault(); const el = document.querySelector(`.key[data-key="${n}"]`); el && el.classList.add('down'); sendKey(n, true);
  });
  window.addEventListener('keyup', ev => {
    const n = keyFor[ev.key]; if (!n || typing() || $('pane-steuer').hidden) return;
    const el = document.querySelector(`.key[data-key="${n}"]`); if (el && el.classList.contains('down')) { el.classList.remove('down'); sendKey(n, false); }
  });
  $('menus').innerHTML = MENUS.map((m, i) => `<button data-m="${i}"><span>${i}</span>${m}</button>`).join('');
  $('menus').onclick = ev => { const b = ev.target.closest('button'); if (b) sendText('MENU ' + b.dataset.m); };

  // Fahren
  $('fahrBanner').onclick = ev => {
    const a = ev.target.dataset.act;
    if (a === 'menu8') sendText('MENU 8'); else if (a === 'arm') confirmArm(); else if (a === 'disarm') sendText('DISARM');
  };
  const dist = () => Math.max(0.5, Math.min(300, +$('inDist').value || 0)), ang = () => Math.max(1, Math.min(720, +$('inTurn').value || 0));
  $('btnFwd').onclick = () => sendText('FWD ' + dist()); $('btnBack').onclick = () => sendText('BACK ' + dist());
  $('btnRight').onclick = () => sendText('TURN ' + ang()); $('btnLeft').onclick = () => sendText('TURN -' + ang());
  $('quickDist').innerHTML = [5, 10, 20, 50].map(d => `<button class="btn small" data-d="${d}">${d} cm vor</button>`).join('');
  $('quickDist').onclick = ev => { const d = ev.target.dataset.d; if (d) sendText('FWD ' + d); };
  $('quickTurn').innerHTML = [[-90, '90° links'], [-45, '45° links'], [45, '45° rechts'], [90, '90° rechts'], [180, '180°'], [360, '360°']]
    .map(([d, t]) => `<button class="btn small" data-t="${d}">${t}</button>`).join('');
  $('quickTurn').onclick = ev => { const d = ev.target.dataset.t; if (d) sendText('TURN ' + d); };
  $('btnPenUp').onclick = () => sendText('PEN U'); $('btnPenDown').onclick = () => sendText('PEN D');
  $('speedBtns').innerHTML = SPEED_NAMES.map((n, i) => `<button class="btn small" data-sp="${i}">${n}</button>`).join('');
  $('speedBtns').onclick = ev => { const i = ev.target.dataset.sp; if (i != null) sendText('SPEED ' + i); };

  // Zeichnen
  $('selPaper').innerHTML = Object.keys(PAPERS).map(k => `<option ${k === draw.paper ? 'selected' : ''}>${k}</option>`).join('');
  $('selPaper').onchange = () => { draw.paper = $('selPaper').value; store('paper', draw.paper); resizeCanvas(); renderPlanStats(); };
  $('selSnap').value = String(draw.snap);
  $('selSnap').onchange = () => { draw.snap = +$('selSnap').value; store('snap', draw.snap); };
  $('tools').onclick = ev => {
    const t = ev.target.dataset.tool; if (!t) return;
    if (draw.cur) finishLine();
    draw.tool = t; document.querySelectorAll('#tools [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  };
  $('btnFinish').onclick = finishLine;
  $('btnUndo').onclick = () => { if (!draw.history.length) return; draw.strokes = JSON.parse(draw.history.pop()); saveDrawing(); };
  $('btnClear').onclick = () => { if (!draw.strokes.length) return; snapshot(); draw.strokes = []; saveDrawing(); };
  $('selTpl').onchange = () => { const v = $('selTpl').value; if (v) { snapshot(); draw.strokes.push(...template(v)); saveDrawing(); } $('selTpl').value = ''; };
  $('chkOpt').onchange = recomputePlan; $('chkPlan').onchange = render;
  $('btnPlay').onclick = play;
  $('rngScrub').oninput = () => { if (!draw.plan) return; draw.playing = false; $('btnPlay').textContent = '▶ Abspielen'; draw.playT = +$('rngScrub').value / 1000 * draw.plan.total; if (draw.playT >= draw.plan.total) draw.playT = null; render(); };
  $('btnSend').onclick = sendDrawing;
  cv.addEventListener('pointerdown', pointerDown); cv.addEventListener('pointermove', pointerMove);
  cv.addEventListener('pointerup', pointerUp); cv.addEventListener('pointercancel', pointerUp);
  cv.addEventListener('dblclick', () => { if (draw.tool === 'line') finishLine(); });
  new ResizeObserver(resizeCanvas).observe($('cbox'));

  // Kalibrieren
  ['calTurnCmd', 'calTurnAct', 'calDistCmd', 'calDistAct'].forEach(id => $(id).oninput = updateCal);
  $('btnCalTurn').onclick = () => sendText('SET TRACK ' + $('btnCalTurn').dataset.v);
  $('btnCalDist').onclick = () => sendText('SET WHEEL ' + $('btnCalDist').dataset.v);
  $('btnCopyCfg').onclick = () => {
    const t = $('cfgLines').textContent;
    navigator.clipboard.writeText(t).then(() => logLine('Zeilen kopiert.')).catch(() => { const r = document.createRange(); r.selectNodeContents($('cfgLines')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  };
  document.querySelectorAll('[data-theme-set]').forEach(b => b.onclick = () => setTheme(b.dataset.themeSet));

  // Protokoll
  $('chkRaw').checked = load('raw', false);
  $('chkRaw').onchange = () => { store('raw', $('chkRaw').checked); document.querySelectorAll('#loglines .m').forEach(d => d.hidden = !$('chkRaw').checked); };
  $('btnLogClear').onclick = () => { $('loglines').innerHTML = ''; };
  $('cmdForm').onsubmit = ev => { ev.preventDefault(); const t = $('cmdIn').value.trim(); if (t) { sendText(t); $('cmdIn').value = ''; } };

  renderCfg(); renderStatus(); recomputePlan();
  setTab(load('tab', 'steuer'));
  logLine('Bereit. „Verbinden“ wählt den Roboter aus der Bluetooth-Liste.');
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
