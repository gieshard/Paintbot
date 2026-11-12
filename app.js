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

/* Menues der Firmware (V16). Menue 5 (Distanz-Monitor) gibt es nicht mehr --
   dieselbe Messung steckt im Hardwaretest. Nummern bleiben gleich wie am Roboter. */
const MENUS = {
  0: 'Leerlauf', 1: 'Fernsteuerung', 2: 'Muster', 3: 'Zufallsfahrt', 4: 'Driftkorrektur',
  6: 'Hardwaretest', 7: 'Kunst', 8: 'App-Fahren'
};
const MENU_ORDER = [0, 1, 2, 3, 4, 6, 7, 8];
const KEYMAPS = {
  0: [['T1', 'Stepper-Test anfordern, T2 bestätigt'], ['T1 lang', 'Servo-Test'], ['T2 lang', 'Entfernungsmesser an/aus']],
  1: [['T2', 'Steuerkreuz freigeben / sperren'], ['Pfeile', 'einmal = fahren, nochmal = stopp'], ['T3', 'Tempo Langsam / Mittel / Schnell']],
  2: [['T3', 'nächstes Muster'], ['T2', 'Muster starten / abbrechen'], ['T2 lang', 'Entfernungsmesser an/aus']],
  3: [['T2', 'Zufallsfahrt starten / stoppen']],
  4: [['T2', 'Driftfahrt 100 cm starten / abbrechen'], ['T3', 'Korrektur an/aus'], ['T1', 'Drehkalibrierung anfordern, T2 bestätigt']],
  6: [['T1', 'Fahrtest anfordern, T2 bestätigt'], ['T2', 'Servo-Test'], ['T3', 'Distanzsensor-Test']],
  7: [['T1', 'Seed aus dem Entfernungssensor'], ['T3', 'nächster Algorithmus'], ['Hoch/Runter', 'Papierformat'], ['Links/Rechts', 'Seed −/+'], ['T2', 'zeichnen / abbrechen']],
  8: [['T2', 'Fahren freigeben / sperren'], ['App', 'Fahrbefehle und Zeichnen hier in der App']],
};
/* Muster aus Patterns.ino (cm). Der Roboter faehrt die erste Strecke in seine
   Blickrichtung und dreht dann jeweils auf die naechste. */
const PATTERNS = [
  { name: 'Dreieck', fw: 'Triangle', pts: [[5, 5], [5, 0], [0, 0]] },
  { name: 'Rechteck', fw: 'Rectangle', pts: [[0, 4], [8, 4], [8, 0], [0, 0]] },
  { name: 'Ziege', fw: 'Goat 1', pts: [[2, 3], [0, 7], [3, 5], [8, 5], [10, 7], [7, 10], [15, 6], [13, 3], [13, 5], [11, 5], [10, 4], [10, 0], [8, 2], [4, 2], [0, 0]] },
];
const PAPERS = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594] };
const SPEED_NAMES = ['Langsam', 'Mittel', 'Schnell'];
const DEFAULT_CFG = {
  wheel: 60.0, track: 176.4, spr: 400, spt: 1176, mode: 'INTERLEAVE', menus: 8, pmax: 1500,
  prof: [{ v: 150, a: 250 }, { v: 280, a: 350 }, { v: 420, a: 450 }],
  art: [0, 0], penms: 300, ret: 1, keep: 1, pu: 100, pd: 60, tl: 1000, tr: 1000, tm: 0, wl: 1000, wr: 1000, cf: 1, bl: 2, br: 2
};
const MIN_SEG_MM = 1.0;

/* ------------------------------------------------------------------ Zustand */
const st = {
  link: null, connected: false, demo: false, fw: '',
  menu: null, armed: false, busy: false, f: -1, l: -1, r: -1, pen: 0, sp: 1, sw: 0, run: 0, pts: 0, thr: 15,
  cfg: { ...DEFAULT_CFG, prof: DEFAULT_CFG.prof.map(p => ({ ...p })), art: [...DEFAULT_CFG.art] },
  live: null,      // { i, n, x, y, h } waehrend einer Zeichnung
  sending: false,
  view: 'm0',      // sichtbares Menue in der App (m0..m8, einst, log)
  pat: 0,          // gewaehltes Muster (Menue 2)
  art: { algo: 0, seed: 1, paper: 0 },   // Auswahl Menue 7
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
    this.s = { menu: 0, armed: false, tel: false, pen: 0, sp: 1, path: [], run: null, move: null, cfg: JSON.parse(JSON.stringify(DEFAULT_CFG)), f: 120, pat: 0, art: [0, 1, 0] };
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
    if (!down) {
      if (n !== 2) return;
      if (s.menu === 8) this.arm(!s.armed);
      else if (s.menu === 2 && s.run) { this.stopAll(); }
      else if (s.menu === 2) this.say('Starting pattern: ' + PATTERNS[s.pat].fw + ' (Demo: es wird nichts gefahren)');
      else if (s.menu === 7) this.say('Demo: Zeichnen von ' + ArtGen.NAMES[s.art[0]] + ' wäre jetzt gestartet.');
      else this.say('Demo: Taste 2 in Menü ' + s.menu);
      return;
    }
    if (n === 4) { let m = (s.menu + 1) % 9; if (m === 5) m = 6; this.setMenu(m); return; }
    if (n === 3 && s.menu === 1) { s.sp = (s.sp + 1) % 3; this.say('Geschwindigkeit: ' + SPEED_NAMES[s.sp]); return; }
    if (n === 3 && s.menu === 2) { s.pat = (s.pat + 1) % PATTERNS.length; this.say('Selected pattern: ' + PATTERNS[s.pat].fw); this.say('@PAT ' + s.pat); return; }
    if (n === 3 && s.menu === 7) { s.art[0] = (s.art[0] + 1) % ArtGen.NAMES.length; this.artLine(); return; }
    if (n === 1 && s.menu === 7) { s.art[1] = 1 + Math.floor(Math.random() * 999999); this.say('Seed ' + s.art[1] + ' aus 8 Echos (Demo)'); this.artLine(); return; }
    if (n >= 5 && s.menu === 7) { const a = s.art; if (n === 5) a[2] = (a[2] + 1) % 3; if (n === 6) a[2] = (a[2] + 2) % 3; if (n === 7) a[1] = Math.max(1, a[1] - 1); if (n === 8) a[1]++; this.artLine(); return; }
    if (n !== 2) this.say('Demo: Taste ' + n + ' in Menü ' + s.menu);
  }
  setMenu(m) {
    const s = this.s; this.stopAll(); s.menu = m; s.armed = false;
    this.say('== ' + MENUS[m] + ' (Menue ' + m + ') ==');
    if (m === 8) this.say('Fahren GESPERRT -- in der App freigeben oder Taste 2 kurz.');
    if (m === 7) this.artLine();
  }
  artLine() { const a = this.s.art; this.say(`Bild: ${ArtGen.NAMES[a[0]]} | Seed ${a[1]} | ${ArtGen.PAPERS[a[2]].name}`); this.say(`@ART ${a[0]} ${a[1]} ${a[2]}`); }
  arm(on) { this.s.armed = on; if (!on) this.stopAll(); this.say(on ? 'App: Fahren FREIGEGEBEN' : 'App: Fahren GESPERRT'); this.stat(); }
  stopAll() {
    const s = this.s;
    if (s.move) { s.move = null; this.say('@END abort'); }
    if (s.run) { s.run = null; s.pen = 0; this.say('Zeichnung abgebrochen.'); this.say('@END abort'); }
  }
  busy() { return !!(this.s.move || this.s.run); }
  stat() {
    const s = this.s;
    this.say(`@STAT m=${s.menu} a=${s.armed ? 1 : 0} b=${this.busy() ? 1 : 0} f=${s.menu === 8 ? Math.round(s.f) : -1} l=-1 r=-1 pen=${s.pen} sp=${s.sp} sw=${s.menu === 8 ? 1 : 0} run=${s.run ? 1 : 0} pts=${s.path.length} thr=15 bm=11850 bp=71 fm=3950 fp=70`);
  }
  cfgLine() {
    const c = this.s.cfg;
    this.say(`@CFG wheel=${c.wheel.toFixed(1)} track=${c.track.toFixed(1)} spr=${c.spr} spt=${(c.track * c.spr / c.wheel).toFixed(1)} mode=${c.mode} menus=8 pmax=${c.pmax} prof=${c.prof.map(p => p.v + '/' + p.a).join(',')} art=${c.art.join(',')} penms=${c.penms} ret=${c.ret} keep=${c.keep} pu=${c.pu} pd=${c.pd} tl=${c.tl} tr=${c.tr} tm=${c.tm} wl=${c.wl} wr=${c.wr} cf=${c.cf} blt=${Math.round(c.bl * 10)} brt=${Math.round(c.br * 10)}`);
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
      case 'HELLO': s.tel = true; this.say('@HELLO PaintBot DEMO (V16j)'); this.cfgLine(); this.stat(); break;
      case 'OBST': this.say('@OK OBST'); break;
      case 'CORR': if (!/^[01]$/.test(arg)) { this.say('@ERR arg CORR 0|1'); break; } if (this.busy()) { this.say('@ERR busy erst anhalten'); break; } c.cf = +arg; this.say('@OK CORR'); this.cfgLine(); break;
      case 'SPIN': { const [sd, n] = arg.split(/\s+/); if (!/^[lr]$/i.test(sd || '') || !(+n > 0 && +n <= 10)) { this.say('@ERR arg SPIN L|R umdrehungen (0..10)'); break; } if (!this.canDrive()) break; s.move = { left: 1000 * +n }; this.say('@OK SPIN'); break; }
      case 'TELEM': s.tel = arg !== '0'; this.say('@OK TELEM'); break;
      case 'STAT': this.stat(); break;
      case 'CFG': this.cfgLine(); break;
      case 'STOP': { const wasImg = s.menu === 2 && !!s.run; this.stopAll(); this.say('@OK STOP'); if (s.menu !== 8 && !wasImg) this.setMenu(0); break; }
      case 'MENU': { const m = parseInt(arg, 10); if (!(m >= 0 && m <= 8) || m === 5) { this.say('@ERR arg MENU 0..4, 6..8'); break; } this.say('@OK MENU'); if (m !== s.menu) this.setMenu(m); break; }
      case 'PATTERN': { const n = parseInt(arg, 10); if (!(n >= 0 && n < PATTERNS.length)) { this.say('@ERR arg PATTERN 0..n'); break; } if (s.menu !== 2) { this.say('@ERR menu Muster nur in Menue 2'); break; } s.pat = n; this.say('Selected pattern: ' + PATTERNS[n].fw); this.say('@PAT ' + n); this.say('@OK PATTERN'); break; }
      case 'ART': {
        const [a, sd, p] = arg.split(/\s+/).map(Number);
        if (s.menu !== 7) { this.say('@ERR menu ART nur in Menue 7'); break; }
        if (!(a >= 0 && a < ArtGen.NAMES.length && sd >= 1 && sd <= 999999 && p >= 0 && p < 3)) { this.say('@ERR arg Algorithmus, Seed oder Papier ungueltig'); break; }
        s.art = [a, sd, p]; this.artLine(); this.say('@OK ART'); break;
      }
      case 'ARM': case 'DISARM': if (s.menu !== 8) { this.say('@ERR menu Freigabe nur in Menue 8'); break; } this.arm(w === 'ARM'); this.say('@OK ' + w); break;
      case 'FWD': case 'BACK': case 'TURN': {
        const val = parseFloat(arg);
        if (!val || (w !== 'TURN' && (val <= 0 || val > 300)) || Math.abs(val) > 720) { this.say('@ERR arg Wert ausserhalb'); break; }
        if (!this.canDrive()) break;
        const d = w === 'TURN' ? Math.abs(val) * Math.PI / 180 * c.track / 2 : val * 10;
        s.move = { left: moveSec(d, v, a) * 1000 };
        this.say('@OK ' + w); break;
      }
      case 'PEN': if (s.menu !== 8 && s.menu !== 0) { this.say('@ERR menu Stift nur in Menue 0 und 8'); break; } s.pen = /^d/i.test(arg) ? 1 : 0; this.say('@OK PEN'); break;
      case 'SPEED': { const i = parseInt(arg, 10); if (!(i >= 0 && i <= 2)) { this.say('@ERR arg SPEED 0..2'); break; } s.sp = i; this.say('Geschwindigkeit: ' + SPEED_NAMES[i]); this.say('@OK SPEED'); break; }
      case 'SET': {
        const [k, val] = arg.split(/\s+/), x = parseFloat(val);
        if (/^track$/i.test(k) && x >= 50 && x <= 400) c.track = x;
        else if (/^wheel$/i.test(k) && x >= 20 && x <= 150) c.wheel = x;
        else if (/^penup$/i.test(k) && x >= 0 && x <= 180) c.pu = Math.round(x);
        else if (/^pendown$/i.test(k) && x >= 0 && x <= 180) c.pd = Math.round(x);
        else if (/^turnl$/i.test(k) && x >= 0.8 && x <= 1.25) c.tl = Math.round(x * 1000);
        else if (/^turnr$/i.test(k) && x >= 0.8 && x <= 1.25) c.tr = Math.round(x * 1000);
        else if (/^trim$/i.test(k) && x >= -0.25 && x <= 0.25) c.tm = Math.round(x * 10000);
        else if (/^wsl$/i.test(k) && x >= 0.5 && x <= 1.5) c.wl = Math.round(x * 1000);
        else if (/^wsr$/i.test(k) && x >= 0.5 && x <= 1.5) c.wr = Math.round(x * 1000);
        else if (/^bll$/i.test(k) && x >= 0 && x <= 20) c.bl = Math.round(x * 10) / 10;
        else if (/^blr$/i.test(k) && x >= 0 && x <= 20) c.br = Math.round(x * 10) / 10;
        else { this.say('@ERR arg Zahl fehlt oder ungueltig / SET TRACK|WHEEL|PENUP|PENDOWN|TURNL|TURNR|TRIM|WSL|WSR'); break; }
        this.say('Wert gilt bis zum Neustart -- dauerhaft in global.h eintragen.'); this.say('@OK SET'); this.cfgLine(); break;
      }
      case 'PCLR': s.path = []; this.say('@PATH 0'); break;
      case 'PRUN': {
        if (s.path.length < 2) { this.say('@ERR empty keine Zeichnung'); break; }
        if (s.menu === 2) { if (this.busy()) { this.say('@ERR busy Roboter faehrt noch'); break; } }
        else if (!this.canDrive()) break;
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
    case '@HELLO': st.fw = rest; $('fwver').textContent = rest; renderCfg(); break;
    case '@STAT': {
      const o = parseKV(rest);
      st.menu = +o.m; st.armed = o.a === '1'; st.busy = o.b === '1'; st.f = +o.f; st.l = +o.l; st.r = +o.r;
      st.pen = +o.pen; st.sp = +o.sp; st.sw = +o.sw; st.run = +o.run; st.pts = +o.pts; st.thr = +o.thr || 15;
      followRobotMenu();
      st.bm = o.bm !== undefined ? +o.bm : null; st.bp = +o.bp; st.fm = o.fm !== undefined ? +o.fm : null; st.fp = +o.fp;
      renderStatus(); break;
    }
    case '@CFG': {
      const o = parseKV(rest), c = st.cfg;
      st.cfgHas = new Set(Object.keys(o));
      for (const k of ['wheel', 'track', 'spr', 'spt', 'menus', 'pmax', 'penms', 'ret', 'keep', 'pu', 'pd', 'tl', 'tr', 'tm', 'wl', 'wr', 'cf', 'bl', 'br']) if (o[k] !== undefined) c[k] = +o[k];
      if (o.mode) c.mode = o.mode;
      if (o.blt !== undefined) c.bl = +o.blt / 10;   // V16j: Umkehrspiel in Zehnteln
      if (o.brt !== undefined) c.br = +o.brt / 10;
      if (o.prof) c.prof = o.prof.split(',').map(t => { const [v, a] = t.split('/'); return { v: +v, a: +a }; });
      if (o.art) c.art = o.art.split(',').map(Number);
      renderCfg(); syncArtCfg(); recomputePlan(); break;
    }
    case '@PROG': {
      const [i, n, x, y, h] = rest.split(/\s+/).map(Number);
      st.live = Object.assign(st.live || { target: 'draw' }, { i, n, x, y, h }); renderLive(); break;
    }
    case '@END': if (st.live) { st.live.done = rest; renderLive(); } st.busy = false; renderStatus(); break;
    case '@PAT': { const n = parseInt(rest, 10); if (n >= 0 && n < PATTERNS.length) { st.pat = n; renderPatterns(); } break; }
    case '@ART': {
      const [a, sd, p] = rest.split(/\s+/).map(Number);
      if (a >= 0 && a < ArtGen.NAMES.length && sd >= 1) { st.art = { algo: a, seed: sd, paper: p >= 0 && p < 3 ? p : 0 }; st.artFromRobot = true; renderArt(true); }
      break;
    }
    case '@DONE': st.busy = false; renderStatus(); break;
    case '@OK': if (/^(FWD|BACK|TURN)/.test(rest)) { st.busy = true; renderStatus(); } break;
    case '@EVT': if (/^obst/.test(rest)) logLine('Hindernis -- Fahrt angehalten.', 'err'); break;
  }
}

/* ------------------------------------------------------------------ Verbindung */
function onState(connected, name) {
  st.connected = connected; st.prevRobotMenu = undefined;
  if (!connected) { st.menu = null; st.armed = false; st.busy = false; st.live = null; $('fwver').textContent = 'nicht verbunden'; logLine('Verbindung getrennt.', 'err'); }
  else { logLine('Verbunden mit ' + name + '.'); if (st.demo) $('noBt').hidden = true; setTimeout(() => sendText('HELLO'), 150); }
  $('conndot').className = 'dot' + (connected ? (st.demo ? ' demo' : ' on') : '');
  $('btnConnect').textContent = connected ? 'Trennen' : 'Verbinden';
  $('btnDemo').hidden = connected && !st.demo;
  $('btnDemo').textContent = connected && st.demo ? 'Demo beenden' : 'Demo';
  if (!connected) st.testRunning = false;
  updateCal(); updateTurnFactors(); updateTrim(); updateSpin(); updateCorr();
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
  $('m1Speed').textContent = c ? SPEED_NAMES[st.sp] || '–' : '–';
  $('sArm').innerHTML = !c || m == null ? pill('–') : m === 8 ? (st.armed ? pill('frei', 'good') : pill('gesperrt', 'warn')) : pill('nur Menü 8');
  $('sBusy').innerHTML = !c ? '–' : st.run ? pill('zeichnet', 'good') : st.busy ? pill('fährt', 'good') : pill('steht');
  $('sPen').textContent = c ? (st.pen ? 'unten' : 'oben') : '–';
  $('sSpeed').textContent = c ? SPEED_NAMES[st.sp] || '–' : '–';
  // Akkus (Firmware ab V14): Volt + Prozent, Farbe nach Restladung
  const batt = (mv, pct, cells) => {
    if (!c || mv == null) return '–';
    if (mv < 0) return pill(cells > 1 ? 'nicht gemessen' : '–');
    const v = (mv / 1000).toLocaleString('de-DE', { minimumFractionDigits: cells > 1 ? 1 : 2, maximumFractionDigits: cells > 1 ? 1 : 2 });
    const cls = pct <= 10 ? 'bad' : pct <= 25 ? 'warn' : 'good';
    return pill(`${pct} %`, cls) + ` <small>${v} V</small>`;
  };
  $('sBattM').innerHTML = batt(st.bm, st.bp, 3);
  $('sBattF').innerHTML = batt(st.fm, st.fp, 1);
  for (const [k, v] of [['F', st.f], ['L', st.l], ['R', st.r]]) {
    const ok = c && v >= 0;
    $('d' + k).textContent = ok ? v + ' cm' : '–';
    const bar = $('b' + k);
    bar.style.width = ok ? Math.min(100, v) + '%' : '0';
    bar.style.background = ok && v < st.thr ? 'var(--stop)' : ok && v < st.thr * 2 ? 'var(--warn)' : 'var(--ok)';
  }
  renderMenubar();
  renderRobotInfo();
  renderFahren();
}
function driveReady() { return st.connected && st.menu === 8 && st.armed && !st.busy && !st.run; }
function renderFahren() {
  const b = $('fahrBanner');
  let html, ok = false;
  if (!st.connected) html = 'Nicht verbunden. Oben auf <b>Verbinden</b> tippen (oder <b>Demo</b> zum Ausprobieren).';
  else if (st.menu !== 8) html = `Der Roboter ist noch nicht in diesem Menü. <button class="btn small" data-act="menu8">Roboter auf Menü 8 schalten</button>`;
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
const APP_VERSION = 'V16j-3 (11.11.2026)';
function renderCfg() {
  const c = st.cfg, mm = Math.PI * c.wheel / c.spr;
  $('cfgList').innerHTML = [
    ['App-Version', APP_VERSION], ['Firmware', st.fw || '–'],
    ['Raddurchmesser', c.wheel.toFixed(1) + ' mm'], ['Spurweite', c.track.toFixed(1) + ' mm'],
    ['Schrittmodus', c.mode], ['Schritte / Radumdrehung', c.spr], ['Schritte / 360°', (+c.spt).toFixed(0)],
    ['Weg pro Schritt', mm.toFixed(3) + ' mm'],
    ...c.prof.map((p, i) => [SPEED_NAMES[i], (p.v * mm / 10).toFixed(1) + ' cm/s']),
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  $('cfgLines').textContent = `#define WHEEL_DIAMETER_MM ${c.wheel.toFixed(1)}\n#define TRACK_WIDTH_MM    ${c.track.toFixed(1)}\nint penUpAngle   = ${c.pu};\nint penDownAngle = ${c.pd};\n#define TURN_FACTOR_LEFT  ${(c.tl / 1000).toFixed(3)}\n#define TURN_FACTOR_RIGHT ${(c.tr / 1000).toFixed(3)}\n#define WHEEL_TRIM ${((c.tm || 0) / 10000).toFixed(4)}\n#define WHEEL_SCALE_LEFT  ${((c.wl || 1000) / 1000).toFixed(3)}\n#define WHEEL_SCALE_RIGHT ${((c.wr || 1000) / 1000).toFixed(3)}\n#define BACKLASH_LEFT_STEPS  ${(c.bl ?? 0).toFixed(1)}\n#define BACKLASH_RIGHT_STEPS ${(c.br ?? 0).toFixed(1)}\n#define CORRECTIONS_ENABLED ${c.cf === 0 ? 0 : 1}`;
  if (document.activeElement !== $('penUpIn')) $('penUpIn').value = c.pu;
  if (document.activeElement !== $('penDownIn')) $('penDownIn').value = c.pd;
  $('penLines').textContent = `penUpAngle = ${c.pu}; penDownAngle = ${c.pd};`;
  updateTurnFactors();
  updateTrim();
  updateSpin();
  updateCal();
  updateCorr();
  updateBl();
}
/* Schalter Korrekturen (V16h): CORR 0|1, @CFG cf */
/* Umkehrspiel (V16i): Testkreis aus n kleinen Drehungen. Bei jeder Ecke kehrt das innere
   Rad zweimal um (Drehung + Geradeaus) und verliert je b mm -> Winkel fehlt n·2b/Spur.
   Lücke g am Kreisende bei Radius R: fehlender Winkel ≈ g/R. Links herum = linkes Rad. */
function blEval() {
  const c = st.cfg, R = Math.max(10, +$('blR').value || 50), g = Math.abs(+$('blGap').value || 0) * ($('blEnd').value === 'over' ? -1 : 1);
  const n = Math.max(24, Math.min(240, Math.ceil(2 * Math.PI * R / 3)));
  const mmStep = Math.PI * c.wheel / c.spr, dmm = (g / R) * c.track / (2 * n), dSteps = dmm / mmStep;
  const side = $('blSide').value, old = side === 'l' ? (c.bl ?? 0) : (c.br ?? 0), nw = Math.round((old + dSteps) * 10) / 10;
  return { side, old, nw, dSteps, dmm, n };
}
function updateBl() {
  const c = st.cfg, r = blEval(), ok = r.nw >= 0 && r.nw <= 20, noFw = st.connected && st.cfgHas && !st.cfgHas.has('blt');
  $('blOut').innerHTML = `Jetzt: links ${(c.bl ?? 0).toFixed(1)}, rechts ${(c.br ?? 0).toFixed(1)} Schritte. ` +
    (Math.abs(r.dSteps) > 0.01 ? `Spiel je Umkehr ≈ ${r.dmm.toFixed(2)} mm (${r.dSteps.toFixed(1)} Schritte) bei ${r.n} Ecken → neu <b>${r.side === 'l' ? 'links' : 'rechts'} ${ok ? r.nw.toFixed(1) : '–'}</b>` : 'Lücke eintragen.') +
    `<br>global.h: <code>#define BACKLASH_${r.side === 'l' ? 'LEFT' : 'RIGHT'}_STEPS ${ok ? r.nw.toFixed(1) : '…'}</code>` +
    (noFw ? '<br><b style="color:var(--stop)">Die Firmware kann das Umkehrspiel noch nicht in Bruchteilen – bitte V16j flashen.</b>' : '') + (corrOff() ? CORR_OFF_HINT : '');
  $('blSet').disabled = !st.connected || !ok || noFw || corrOff() || Math.abs(r.dSteps) < 0.01 || r.nw === r.old;
}
// 10.11.2026: Testkreis direkt aus den Einstellungen (Menü 2, ohne Freigabe wie die Formen)
async function drawTestCircle(side) {
  if (!st.connected) { testStatus('blSt', 'Erst verbinden.', 1); return; }
  if (st.sending || st.testRunning) { testStatus('blSt', 'Es läuft schon eine Übertragung oder Testfahrt.', 1); return; }
  const R = Math.max(10, Math.min(250, +$('blR').value || 50));
  $('blSide').value = side; updateBl();
  const pts = shapePoints(side === 'l' ? 'circle' : 'circleR', R), plan = planRobot(pts, st.cfg);
  testStatus('blSt', `Kreis ${side === 'l' ? 'links' : 'rechts'} herum, Radius ${R} mm: Roboter mit dem Stift auf den Kreisrand stellen, Blick nach vorn – der Kreis liegt ${side === 'l' ? 'links' : 'rechts'} vom Roboter.`);
  await sendPath(pts, { menu: 2, paper: 'beliebig', plan, prog: $('blProg'), info: $('blInfo'), target: 'test', onState: () => { $('blCircL').disabled = $('blCircR').disabled = st.sending; } });
}
function updateCorr() {
  const c = st.cfg, on = c.cf !== 0, noFw = st.connected && st.cfgHas && !st.cfgHas.has('cf');
  $('corrState').innerHTML = noFw ? '<b style="color:var(--stop)">Die Firmware kennt den Schalter noch nicht – bitte V16h flashen.</b>'
    : (on ? '<b>AN</b> – Dreh-, Rad- und Geradeaus-Faktoren wirken.' : '<b>AUS</b> – alle Korrekturfaktoren wirken wie 1 (gespeicherte Werte bleiben erhalten).');
  $('corrOn').disabled = !st.connected || noFw || on || st.testRunning;
  $('corrOff').disabled = !st.connected || noFw || !on || st.testRunning;
}
/* ---------- Testfahrten (V16c, 04.11.2026) ----------
   Gemeinsamer Ablauf: Menü 8, Freigabe, Tempo Langsam, dann Befehle nacheinander,
   jeweils bis @DONE. Bei einem Fehler STOP, damit der Roboter nicht "beschäftigt"
   hängen bleibt (sonst lehnt er danach SET … mit "busy" ab). */
async function armedIn8(what, stId) {
  try {
    if (!(await ensureMenu(8))) { testStatus(stId, 'Roboter ließ sich nicht auf Menü 8 schalten.', 1); return false; }
    if (!(await confirmDialog('Testfahrt starten?', (what || 'Der Roboter fährt gleich los.') + ' Platz lassen.', 'Fahren'))) { testStatus(stId, 'Abgebrochen.', 1); return false; }
    // 05.11.2026: Freigabe IMMER senden (ARM ist im Roboter wiederholbar). Vorher wurde
    // st.armed vertraut – war es veraltet, lehnte der Roboter danach FWD ab.
    const p = expect(/^@OK ARM/); sendText('ARM'); await p;
    return true;
  } catch (e) { logLine('Freigabe: ' + e.message, 'err'); testStatus(stId, 'Freigabe fehlgeschlagen: ' + e.message, 1); return false; }
}
function testStatus(id, html, err) { const e = id && $(id); if (e) e.innerHTML = err ? `<b style="color:var(--stop)">${html}</b>` : html; }
async function runTestDrive(name, what, cmds, stId) {
  if (!st.connected) { testStatus(stId, 'Erst verbinden.', 1); logLine('Erst verbinden.', 'err'); return false; }
  if (st.testRunning) { testStatus(stId, 'Es läuft schon eine Testfahrt.', 1); return false; }
  testStatus(stId, 'Schalte auf Menü 8 und gebe frei …');
  if (!(await armedIn8(what, stId))) return false;
  st.testRunning = true; testStatus(stId, name + ' läuft …');
  let ok = false, obstOff = false;
  try {
    let p = expect(/^@OK SPEED/); sendText('SPEED 0'); await p;
    // Hinderniserkennung für die Testfahrt aus (Firmware ab V16d; ältere antworten mit @ERR)
    try { p = expect(/^@OK OBST/, 2000); sendText('OBST 0'); await p; obstOff = true; } catch (e) { /* ältere Firmware */ }
    for (const c of cmds) {
      if (/^PEN /.test(c)) { p = expect(/^@OK PEN/); sendText(c); await p; await sleep(Math.max(1000, st.cfg.penms + 700)); continue; }
      p = expect(/^@DONE|^@END abort/, 90000); sendText(c);
      const m = await p;
      if (/^@END/.test(m[0])) throw new Error('Fahrt abgebrochen' + (obstOff ? '' : ' – vermutlich Hinderniserkennung (Hand, Wand vor dem Sensor). Firmware V16d schaltet sie für Testfahrten ab.'));
      await sleep(400);
    }
    ok = true; logLine(name + ' fertig – jetzt messen und eintragen.');
    testStatus(stId, name + ' fertig – jetzt messen und eintragen.');
  } catch (e) {
    logLine(name + ' abgebrochen: ' + e.message, 'err'); testStatus(stId, name + ' abgebrochen: ' + e.message, 1);
    sendText('STOP'); await sleep(300);
  }
  sendText('PEN U');
  if (obstOff) { await sleep(200); sendText('OBST 1'); }
  st.testRunning = false;
  updateCal(); updateTurnFactors(); updateTrim(); updateSpin(); updateCorr();
  return ok;
}
// Wert setzen und auf Bestätigung warten; "busy" → einmal STOP und nochmal versuchen
async function setValue(cmd, outId) {
  if (!st.connected) { logLine('Erst verbinden.', 'err'); testStatus(outId, 'Erst verbinden.', 1); return false; }
  for (let k = 0; k < 2; k++) {
    try { const p = expect(/^@OK SET/); sendText(cmd); await p; logLine('Übernommen: ' + cmd); testStatus(outId, 'Übernommen: ' + cmd.replace(/^SET /, '')); return true; }
    catch (e) {
      if (k === 0 && /busy/.test(e.message)) { logLine('Roboter war noch beschäftigt – halte an und versuche es nochmal.'); sendText('STOP'); await sleep(800); continue; }
      const msg = 'Nicht übernommen: ' + e.message; logLine(msg, 'err');
      testStatus(outId, msg + (/arg/.test(e.message) && /TRIM|TURN/.test(cmd) ? ' – die Firmware auf dem Roboter ist zu alt, bitte V16d flashen.' : ''), 1);
      return false;
    }
  }
  return false;
}
const sideVal = id => ($(id).value === 'l' ? -1 : 1);   // rechts = +, links = −

/* Drehtest mit Linie. Hinlinie L mm, 360° drehen, Rücklinie L mm.
   Abstände der Rücklinie zur Hinlinie (in Fahrtrichtung, rechts = +):
   gW am Wendepunkt = Versatz des Drehpunkts (Rutschen, Mechanik),
   gS am Startpunkt = gW + L·sin(Fehler). Zu weit gedreht um e:
   rechts → Rücklinie läuft nach links (gS-gW < 0), links → nach rechts.
   V16c: Seite per Auswahl statt Vorzeichen (iPhone-Zahlentastatur hat kein Minus). */
const TF_LEN_MM = 200;
function turnTestEval() {
  const c = st.cfg, dir = $('tfDir').value;
  const gW = Math.abs(+$('tfGapW').value || 0) * sideVal('tfSideW'), gS = Math.abs(+$('tfGapS').value || 0) * sideVal('tfSideS');
  const q = Math.max(-1, Math.min(1, (gS - gW) / TF_LEN_MM));
  const over = (dir === 'r' ? -1 : 1) * Math.asin(q) * 180 / Math.PI;     // + = zu weit gedreht
  const old = (dir === 'r' ? c.tr : c.tl) / 1000, f = old * 360 / (360 + over);
  return { dir, gW, over, old, f };
}
function updateTurnFactors() {
  const c = st.cfg, r = turnTestEval(), ok = isFinite(r.f) && r.f >= 0.8 && r.f <= 1.25;
  const nm = r.dir === 'r' ? 'Rechtsdrehung' : 'Linksdrehung';
  const ow = Math.abs(r.over) < 0.05 ? 'genau 360°' : `${(360 + r.over).toFixed(1)}° (${r.over > 0 ? 'zu weit' : 'zu kurz'})`;
  $('tfOut').innerHTML = `Jetzt: rechts ${(c.tr / 1000).toFixed(3)}, links ${(c.tl / 1000).toFixed(3)}.<br>` +
    `${nm}: gedreht ${ow} → neuer Faktor <b>${ok ? r.f.toFixed(3) : '– (außerhalb 0,8…1,25)'}</b>` +
    (Math.abs(r.gW) >= 1 ? `<br>Drehpunkt um ${Math.abs(r.gW).toFixed(1)} mm verrutscht – das ist kein Winkelfehler, sondern Rutschen (siehe Anleitung: Räder, Stiftdruck, Stützrad).` : '') +
    `<br>global.h: <code>#define TURN_FACTOR_${r.dir === 'r' ? 'RIGHT' : 'LEFT'} ${ok ? r.f.toFixed(3) : '…'}</code>` +
    (st.connected ? '' : '<br>Zum Übernehmen erst verbinden.');
  $('tfSet').disabled = !st.connected || !ok || st.testRunning || corrOff();
  if (corrOff()) $('tfOut').innerHTML += CORR_OFF_HINT;
}
async function runTurnTest(dir) {
  $('tfDir').value = dir; updateTurnFactors();
  await runTestDrive('Drehtest', 'Der Roboter zeichnet 20 cm, dreht sich einmal ganz um sich selbst und fährt mit Stift zurück.',
    ['PEN D', 'FWD ' + TF_LEN_MM / 10, 'TURN ' + (dir === 'r' ? 360 : -360), 'BACK ' + TF_LEN_MM / 10], 'tfSt');
  updateTurnFactors();
}

/* Strecke: 10 cm mit Stift, dann 10 cm mit gehobenem Stift weiter (Roboter aus dem Weg) */
async function runDistTest() {
  const cm = Math.max(5, Math.min(50, +$('calDistCmd').value || 10));
  $('calDistCmd').value = cm; updateCal();
  // 05.11.2026: erst ein Punkt im Stand (Startmarke), dann die Linie. Gemessen wird vom
  // Punkt bis zum Linienende -- so stört es nicht, wenn der Stift beim Anfahren erst
  // verspätet aufs Papier kommt (eine Lücke zwischen Punkt und Linie zeigt genau das).
  await runTestDrive('Streckentest', `Der Roboter setzt einen Punkt, zeichnet ${cm} cm und fährt mit gehobenem Stift ${cm} cm weiter.`, ['PEN D', 'PEN U', 'PEN D', 'FWD ' + cm, 'PEN U', 'FWD ' + cm], 'calDistSt');
  updateCal();
}

/* Geradeauslauf: gerade Linie zeichnen; Lineal an Anfang und Ende anlegen, Abstand der
   Linienmitte zum Lineal (Pfeilhöhe s) messen. Kreisbogen: R = L²/(8s); Unterschied der
   Radwege (rechts−links)/L = Spurweite/R = 8·Spur·s/L². Linkskurve → Trim positiv. */
function trimEval() {
  const c = st.cfg, L = Math.max(100, Math.min(1000, (+$('trLen').value || 40) * 10)), s = Math.abs(+$('trSag').value || 0);
  const d = 8 * c.track * s / (L * L) * ($('trDir').value === 'l' ? 1 : -1), old = (c.tm || 0) / 10000, t = old + d;
  return { L, s, old, t, d };
}
function updateTrim() {
  const r = trimEval(), ok = Math.abs(r.t) <= 0.25;
  $('trOut').innerHTML = `Jetzt: ${(r.old * 100).toFixed(2)} %. ` +
    (ok && Math.abs(r.t) > 0.05 ? '<b>Über 5 % – das ist viel: auf dem Papier rutscht oder verliert ein Rad Schritte (siehe Radtest). Der Ausgleich hilft nur, wenn das Ergebnis bei jeder Fahrt gleich ist.</b><br>' : '') +
    (r.s > 0 ? `Radwege unterscheiden sich um ${(Math.abs(r.d) * 100).toFixed(2)} % → neuer Ausgleich <b>${ok ? (r.t * 100).toFixed(2) + ' %' : '– (über 25 %: Mechanik prüfen)'}</b>` : 'Abweichung eintragen.') +
    `<br>global.h: <code>#define WHEEL_TRIM ${ok ? r.t.toFixed(4) : '…'}</code>` + (st.connected ? '' : '<br>Zum Übernehmen erst verbinden.');
  const noFw = st.connected && st.cfgHas && !st.cfgHas.has('tm');
  if (noFw) $('trOut').innerHTML += '<br><b style="color:var(--stop)">Die Firmware auf dem Roboter kennt den Ausgleich noch nicht – bitte V16d flashen.</b>';
  $('trSet').disabled = !st.connected || !ok || r.s === 0 || st.testRunning || noFw || corrOff();
  if (corrOff()) $('trOut').innerHTML += CORR_OFF_HINT;
}
/* Radtest (V16e): Roboter hochheben, ein Rad dreht genau n Umdrehungen. */
async function runSpin(side) {
  const n = SPIN_TURNS;
  await runTestDrive('Radtest ' + (side === 'L' ? 'links' : 'rechts'),
    `Roboter HOCHHEBEN – das ${side === 'L' ? 'linke' : 'rechte'} Rad dreht genau ${n} Umdrehungen vorwärts.`, ['SPIN ' + side + ' ' + n], 'spinSt');
}
const SPIN_TURNS = 2;
// 06.11.2026: Bei Korrekturen AUS fährt der Roboter mit neutralen Faktoren -- ein daraus
// berechneter Faktor wäre falsch (alter Wert ≠ wirksamer Wert). Übernehmen daher sperren.
const corrOff = () => st.connected && st.cfg.cf === 0;
const CORR_OFF_HINT = '<br><b style="color:var(--stop)">Korrekturen sind AUS – zum Einmessen oben „Korrekturen AN“ wählen und den Test wiederholen.</b>';
function spinEval() {
  const c = st.cfg, ul = +$('spinCntL').value, ur = +$('spinCntR').value;
  const ol = (c.wl || 1000) / 1000, or = (c.wr || 1000) / 1000;
  const fl = ul > 0 ? ol * SPIN_TURNS / ul : NaN, fr = ur > 0 ? or * SPIN_TURNS / ur : NaN;
  return { ol, or, fl, fr };
}
function updateSpin() {
  const r = spinEval(), ok = x => isFinite(x) && x >= 0.5 && x <= 1.5;
  const noFw = st.connected && st.cfgHas && !st.cfgHas.has('wl');
  $('spinOut').innerHTML = `Jetzt: links ${r.ol.toFixed(3)}, rechts ${r.or.toFixed(3)} → neu: links <b>${ok(r.fl) ? r.fl.toFixed(3) : '–'}</b>, rechts <b>${ok(r.fr) ? r.fr.toFixed(3) : '–'}</b>` +
    `<br>global.h: <code>#define WHEEL_SCALE_LEFT ${ok(r.fl) ? r.fl.toFixed(3) : '…'}</code> / <code>#define WHEEL_SCALE_RIGHT ${ok(r.fr) ? r.fr.toFixed(3) : '…'}</code>` +
    (noFw ? '<br><b style="color:var(--stop)">Die Firmware auf dem Roboter kennt die Radfaktoren noch nicht – bitte V16f flashen.</b>' : '');
  $('spinSet').disabled = !st.connected || !ok(r.fl) || !ok(r.fr) || noFw || st.testRunning || corrOff();
  if (corrOff()) $('spinOut').innerHTML += CORR_OFF_HINT;
}
async function runTrimTest() {
  const cm = Math.max(10, Math.min(100, +$('trLen').value || 40)); $('trLen').value = cm;
  await runTestDrive('Geradeaus-Test', `Der Roboter zeichnet eine ${cm} cm lange gerade Linie und fährt mit gehobenem Stift 10 cm weiter.`, ['PEN D', 'FWD ' + cm, 'PEN U', 'FWD 10'], 'trSt');
  updateTrim();
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
  if (!st.connected && isFinite(nw)) $('calDistOut').textContent += ' – zum Übernehmen erst verbinden.';
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
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1], L = Math.hypot(bx - ax, by - ay);
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i];
    // geschlossener Linienzug (Anfang = Ende): Abstand zum Anfangspunkt statt zur Geraden
    const d = L < 1e-9 ? Math.hypot(px - ax, py - ay) : Math.abs((by - ay) * px - (bx - ax) * py + bx * ay - by * ax) / L;
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
  if (name === 'circle') S.push(circlePts(50));
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
  const liveHere = st.live && st.live.target === 'draw';
  const tNow = liveHere && plan ? liveTime() : (draw.playT != null && plan ? draw.playT : null);
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
  if (st.live && st.live.target === 'draw' && st.live.done !== 'ok' && st.live.done !== 'abort') drawRobot(st.live.x, st.live.y, st.live.h, css('--ok'));
  else if (showPlan && tNow != null) { const p = poseAt(plan, tNow); drawRobot(p.x, p.y, p.h, css('--fg')); }
  else drawRobot(0, 0, 0, '#7b8494');
}
function liveTime() {
  const l = st.live, p = l.plan || draw.plan;
  if (l.done === 'ok') return p.total;
  const q = p.progAt[Math.max(0, Math.min(p.progAt.length - 1, l.i - 1))];
  return q ? q.t : 0;
}
function renderLive() {
  const l = st.live; if (!l) return;
  const pr = l.prog || $('sendProg'), info = l.info || $('sendInfo');
  pr.hidden = false; pr.max = l.n; pr.value = l.done === 'ok' ? l.n : Math.max(0, l.i - 1);
  info.textContent = l.done === 'ok' ? 'Fertig gezeichnet.' : l.done === 'abort' ? 'Abgebrochen.' : `Zeichnet: Punkt ${l.i} von ${l.n}`;
  if (l.target === 'img') renderImg(); else if (l.target === 'shape') renderPatterns(); else if (l.target === 'test') { /* Testkreis Einstellungen */ } else render();
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
/* Eine Punktliste uebertragen und zeichnen lassen.
   opts: { menu: 8|2, paper, plan, prog, info, target: 'draw'|'img', onState }
   Menue 8: wie bisher mit Fahrfreigabe (ARM). Menue 2 (Bild): ohne ARM -- die
   Rueckfrage hier in der App ist die Bestaetigung (Firmware ab V16). */
async function sendPath(pts, opts) {
  if (!st.connected) { logLine('Erst verbinden.', 'err'); return; }
  if (pts.length < 2) return;
  const menu = opts.menu || 8, pr = opts.prog, info = opts.info;
  st.sending = true; opts.onState && opts.onState();
  pr.hidden = false; pr.max = pts.length; pr.value = 0; st.live = null;
  try {
    if (st.menu !== menu) {
      info.textContent = `Schalte den Roboter auf Menü ${menu} …`;
      sendText('MENU ' + menu); await expect(/^@OK MENU/); await new Promise(r => setTimeout(r, 300));
    }
    info.textContent = 'Übertrage …';
    logLine('> PCLR', 'tx');
    await sendPathLine('PCLR', 0, 0);
    for (let i = 0; i < pts.length; i += POINTS_PER_LINE) {
      const chunk = pts.slice(i, i + POINTS_PER_LINE);
      const line = 'P ' + chunk.map(p => `${+p.x.toFixed(1)},${+p.y.toFixed(1)},${p.pen}`).join(';');
      await sendPathLine(line, i, i + chunk.length);   // nicht ins Protokoll, sonst wird es unlesbar
      pr.value = i + chunk.length;
    }
    logLine(`Übertragen: ${pts.length} Punkte.`);
    info.textContent = 'Übertragen. Bitte bestätigen.';
    const ok = await confirmRun(opts.paper, pts.length, opts.plan.total);
    if (!ok) { info.textContent = 'Übertragen, nicht gestartet.'; return; }
    if (menu === 8 && !st.armed) { sendText('ARM'); await expect(/^@OK ARM/); }
    sendText('PRUN'); await expect(/^@RUN \d+/);
    st.live = { i: 0, n: pts.length, x: 0, y: 0, h: 0, target: opts.target, plan: opts.plan, prog: pr, info };
    renderLive();
  } catch (e) {
    info.textContent = 'Fehler: ' + e.message; logLine('Übertragung: ' + e.message, 'err');
  } finally { st.sending = false; opts.onState && opts.onState(); }
}
function sendDrawing() {
  return sendPath(draw.points, { menu: 8, paper: draw.paper, plan: draw.plan, prog: $('sendProg'), info: $('sendInfo'), target: 'draw', onState: renderPlanStats });
}
function confirmRun(paper, n, total) {
  return new Promise(res => {
    const d = $('dlgRun');
    $('dlgPaper').textContent = paper;
    $('dlgInfo').textContent = `${n} Punkte, Dauer ca. ${fmtTime(total)}. Abbrechen jederzeit mit Stop.`;
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

/* ------------------------------------------------------------------ Menüleiste und Ansichten (neu 27.10.2026) */
const VIEWS_EXTRA = [['einst', 'Einstellungen', 'App'], ['log', 'Protokoll', 'App']];
function viewMenu(v) { return /^m\d$/.test(v) ? +v.slice(1) : null; }

function renderMenubar() {
  const bar = $('menubar'); if (!bar) return;
  if (!bar.dataset.built) {
    bar.innerHTML = MENU_ORDER.map(m => `<button data-view="m${m}" role="tab"><small>Menü ${m}</small><b>${MENUS[m]}</b></button>`).join('') +
      '<span class="sep"></span>' +
      VIEWS_EXTRA.map(([v, t, k]) => `<button data-view="${v}" role="tab" class="${v === 'log' ? 'log-tab' : ''}"><small>${k}</small><b>${t}</b></button>`).join('');
    bar.dataset.built = '1';
    bar.onclick = ev => { const b = ev.target.closest('button'); if (b) selectView(b.dataset.view, true); };
  }
  bar.querySelectorAll('button').forEach(b => {
    b.setAttribute('aria-selected', b.dataset.view === st.view);
    b.classList.toggle('robot', st.connected && b.dataset.view === 'm' + st.menu);
    b.title = st.connected && b.dataset.view === 'm' + st.menu ? 'Der Roboter ist in diesem Menü' : '';
  });
  renderMenuBanner();
}

/* Ansicht wechseln. fromUser = Klick in der Menüleiste: dann auch den Roboter umschalten. */
function selectView(v, fromUser) {
  if (v === 'log' && matchMedia('(min-width: 1000px)').matches) return;
  st.view = v; store('view', v);
  document.querySelectorAll('section.pane').forEach(p => p.hidden = p.id !== 'pane-' + v);
  const aside = $('logAside'), logPane = $('pane-log'), box = $('logBox');
  if (v === 'log') logPane.appendChild(box); else if (box.parentElement !== aside) aside.appendChild(box);
  aside.hidden = v === 'log';
  // Bluefruit-Tasten in das Menü holen, das einen Platz dafür hat
  const home = $('padHome-' + v), pad = $('padCard');
  if (home) { home.appendChild(pad); pad.hidden = false; } else pad.hidden = true;
  const m = viewMenu(v);
  $('keymap').innerHTML = (KEYMAPS[m] || KEYMAPS[0]).map(([k, t]) => `<dt>${k}</dt><dd>${t}</dd>`).join('') + '<dt>T4</dt><dd>nächstes Menü</dd>';
  if (fromUser && m != null && st.connected && st.menu !== m) {
    st.pendingMenu = { m, until: Date.now() + 2500 };
    sendText('MENU ' + m);
  }
  if (v === 'm8') requestAnimationFrame(resizeCanvas);
  if (v === 'm2') requestAnimationFrame(() => { renderPatterns(); renderImg(); });
  if (v === 'm7') requestAnimationFrame(() => renderArt(false));
  renderMenubar();
}

/* Der Roboter hat das Menü gewechselt (Taste 4 am Roboter, Stop, Akku ...): mitgehen. */
function followRobotMenu() {
  if (st.pendingMenu) {
    if (st.menu === st.pendingMenu.m || Date.now() > st.pendingMenu.until) st.pendingMenu = null;
    else return;
  }
  if (st.menu === st.prevRobotMenu) return;
  st.prevRobotMenu = st.menu;
  if (viewMenu(st.view) != null && MENUS[st.menu] && st.view !== 'm' + st.menu) selectView('m' + st.menu, false);
}

function renderMenuBanner() {
  const b = $('menuBanner'), m = viewMenu(st.view);
  if (!st.connected || m == null || m === 8 || st.menu === m || st.menu == null) { b.hidden = true; return; }
  b.hidden = false;
  b.innerHTML = `Der Roboter ist gerade in Menü ${st.menu} (${MENUS[st.menu] || '?'}). <button class="btn small primary" data-act="goto">Roboter auf Menü ${m} schalten</button>`;
}

function renderRobotInfo() {
  const el = $('robotInfo'); if (!el) return;
  const c = st.cfg, mm = Math.PI * c.wheel / c.spr;
  el.innerHTML = [
    ['Verbindung', st.connected ? (st.demo ? 'Demo' : 'verbunden') : 'nicht verbunden'],
    ['Firmware', st.fw || '–'],
    ['Räder / Spurweite', `${c.wheel.toFixed(1)} / ${c.track.toFixed(1)} mm`],
    ['Tempo jetzt', (SPEED_NAMES[st.sp] || '–') + (st.cfg.prof[st.sp] ? ` (${(st.cfg.prof[st.sp].v * mm / 10).toFixed(1)} cm/s)` : '')],
    ['Hauptakku', st.bm > 0 ? `${(st.bm / 1000).toFixed(1)} V (${st.bp} %)` : st.connected ? 'nicht gemessen' : '–'],
    ['Feather-Akku', st.fm > 0 ? `${(st.fm / 1000).toFixed(2)} V (${st.fp} %)` : '–'],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

/* Tasten aus den Menü-Ansichten: kurz antippen, lang halten, oder anfordern + bestätigen */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function ensureMenu(m) {
  if (!st.connected) { logLine('Erst verbinden.', 'err'); return false; }
  if (st.menu === m) return true;
  st.pendingMenu = { m, until: Date.now() + 2500 };
  sendText('MENU ' + m);
  try { await expect(/^@OK MENU/); await sleep(250); return true; } catch (e) { logLine('Menüwechsel: ' + e.message, 'err'); return false; }
}
async function tapKey(n) { sendKey(n, true); await sleep(90); sendKey(n, false); }
async function holdKey(n) { sendKey(n, true); await sleep(1000); sendKey(n, false); }
function confirmDialog(title, text, yes) {
  return new Promise(res => {
    const d = $('dlgConfirm');
    $('dlgCTitle').textContent = title; $('dlgCText').textContent = text; $('dlgCYes').textContent = yes || 'Bestätigen';
    // 05.11.2026: ältere iPhone-Browser (Bluefy) kennen <dialog> nicht -- dann einfache Rückfrage
    if (!d || typeof d.showModal !== 'function') { res(window.confirm(title + '\n\n' + text)); return; }
    const done = v => { try { d.close(); } catch (e) {} $('dlgCYes').onclick = $('dlgCNo').onclick = null; res(v); };
    $('dlgCYes').onclick = () => done(true); $('dlgCNo').onclick = () => done(false);
    try { d.showModal(); } catch (e) { res(window.confirm(title + '\n\n' + text)); }
  });
}
const CONFIRM_TEXT = {
  4: ['Drehkalibrierung starten?', 'Der Roboter fährt 30 cm vor und zurück und dreht sechsmal 360°. Mindestens 45 cm Platz, dauert ca. 1 Minute.'],
  6: ['Fahrtest starten?', 'Der Roboter fährt 20 cm vor, 20 cm zurück und dreht je 90° rechts und links. Roboter vorher freistellen.'],
};
async function menuAction(btn) {
  const m = viewMenu(st.view); if (m == null) return;
  if (!(await ensureMenu(m))) return;
  if (btn.dataset.tap) await tapKey(+btn.dataset.tap);
  else if (btn.dataset.hold) await holdKey(+btn.dataset.hold);
  else if (btn.dataset.confirm) {
    await tapKey(+btn.dataset.confirm);          // anfordern ...
    const [t, x] = CONFIRM_TEXT[m] || ['Fahrt bestätigen?', 'Der Roboter fährt gleich los.'];
    if (await confirmDialog(t, x, 'Losfahren')) await tapKey(2);   // ... und mit Taste 2 bestätigen
    else logLine('Nicht bestätigt – die Anforderung verfällt nach 10 s von selbst, der Roboter fährt nicht.');
  }
}

/* ------------------------------------------------------------------ Menü 2: Muster */
function patternPath(i) {   // mm, Start (0,0), erste Strecke nach rechts
  const p = PATTERNS[i].pts.map(([x, y]) => [x * 10, y * 10]);
  const a = -Math.atan2(p[0][1], p[0][0]), c = Math.cos(a), s = Math.sin(a);
  return [[0, 0]].concat(p.map(([x, y]) => [x * c - y * s, x * s + y * c]));
}
function drawPathOn(cvs, pts, opts = {}) {
  const r = cvs.getBoundingClientRect(); if (!r.width) return;
  const dpr = window.devicePixelRatio || 1, g = cvs.getContext('2d');
  cvs.width = Math.round(r.width * dpr); cvs.height = Math.round(r.height * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, r.width, r.height);
  g.fillStyle = css('--paper'); g.fillRect(0, 0, r.width, r.height);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const pad = opts.pad || 14, sc = Math.min((r.width - 2 * pad) / Math.max(1, x1 - x0), (r.height - 2 * pad) / Math.max(1, y1 - y0));
  const ox = r.width / 2 - (x0 + x1) / 2 * sc, oy = r.height / 2 + (y0 + y1) / 2 * sc;
  const P = (x, y) => [ox + x * sc, oy - y * sc];
  if (opts.grid) {   // 1-cm-Raster
    g.strokeStyle = css('--grid'); g.lineWidth = 1; g.beginPath();
    for (let gx = Math.ceil(x0 / 10) * 10 - 20; gx <= x1 + 20; gx += 10) { const [a] = P(gx, 0); g.moveTo(a, 0); g.lineTo(a, r.height); }
    for (let gy = Math.ceil(y0 / 10) * 10 - 20; gy <= y1 + 20; gy += 10) { const [, b] = P(0, gy); g.moveTo(0, b); g.lineTo(r.width, b); }
    g.stroke();
  }
  g.strokeStyle = css('--accent'); g.lineWidth = opts.lw || 2; g.lineJoin = 'round'; g.lineCap = 'round';
  g.beginPath(); pts.forEach(([x, y, pen], k) => { const [a, b] = P(x, y); k && pen !== 0 ? g.lineTo(a, b) : g.moveTo(a, b); }); g.stroke();
  if (pts.some((p, k) => k && p[2] === 0)) {   // Leerfahrten (Stift oben) gestrichelt
    g.save(); g.globalAlpha = 0.45; g.setLineDash([3, 4]); g.lineWidth = 1; g.beginPath();
    pts.forEach((p, k) => { if (k && p[2] === 0) { const [a, b] = P(pts[k - 1][0], pts[k - 1][1]), [c, d] = P(p[0], p[1]); g.moveTo(a, b); g.lineTo(c, d); } });
    g.stroke(); g.restore();
  }
  if (opts.robot) {   // Startposition und Blickrichtung
    const [a, b] = P(0, 0); g.fillStyle = css('--ok'); g.strokeStyle = css('--ok'); g.lineWidth = 2;
    g.beginPath(); g.arc(a, b, 4, 0, 7); g.fill();
    g.beginPath(); g.moveTo(a, b); g.lineTo(a + 22, b); g.lineTo(a + 16, b - 4); g.moveTo(a + 22, b); g.lineTo(a + 16, b + 4); g.stroke();
  }
}
/* Formen, die die App selbst erzeugt und als Zeichnung schickt (30.10.2026),
   Füllung (01.11.2026): parallele Linien oder Kontur nach innen als Spirale. */
const APP_SHAPES = [
  { key: 'circle', name: 'Kreis', label: 'Radius (mm)', def: 50, fill: true },
  { key: 'circleR', name: 'Kreis rechts herum', label: 'Radius (mm)', def: 50, fill: false },   // Umkehrspiel-Test rechtes Rad
  { key: 'rect', name: 'Quadrat', label: 'Seitenlänge (mm)', def: 100, fill: true },
  { key: 'tri', name: 'Dreieck', label: 'Seitenlänge (mm)', def: 120, fill: true },
  { key: 'arrow', name: 'Pfeil', label: 'Länge (mm)', def: 120, fill: true, noSpiral: true },   // 11.11.2026
  // 11.11.2026: offene Linienzüge, direkt im Roboter-Koordinatensystem (Start 0,0, Blick +x)
  { key: 'goat', name: 'Ziege', label: 'Größe (%)', def: 100, fill: false, path: true },
  { key: 'raster', name: 'Rechteckraster', label: 'Länge x – hoch/runter (mm)', def: 100, fill: false, path: true,
    p2: { label: 'Abstand y – quer (mm)', def: 20, min: 2, max: 200 }, p3: { label: 'Anzahl Bahnen', def: 6, min: 2, max: 60 } },
  { key: 'zigzag', name: 'Zickzack', label: 'Zackenbreite (mm)', def: 20, fill: false, path: true,
    p2: { label: 'Zackenhöhe (mm)', def: 15, min: 2, max: 200 }, p3: { label: 'Anzahl Zacken', def: 8, min: 1, max: 100 } },
  { key: 'star', name: 'Stern', label: 'Außenradius (mm)', def: 70, fill: true },
  { key: 'square', name: 'Prüfquadrat', label: 'Seitenlänge (mm)', def: 100, fill: false },   // links herum, dann rechts herum
];
const r1 = v => Math.round(v * 10) / 10;
function circlePts(r) {   // Polygon mit ca. 3 mm Kantenlänge, gegen den Uhrzeigersinn, Start rechts
  const n = Math.max(24, Math.min(240, Math.ceil(2 * Math.PI * r / 3))), out = [];
  for (let i = 0; i <= n; i++) { const a = i / n * 2 * Math.PI; out.push([r1(r * Math.cos(a)), r1(r * Math.sin(a))]); }
  return out;
}
// Umriss als geschlossener Linienzug (erster = letzter Punkt), gegen den Uhrzeigersinn,
// Mittelpunkt (= Startpunkt des Roboters) bei 0,0
function shapeOutline(key, size) {
  if (key === 'circle') return circlePts(size);
  if (key === 'circleR') return circlePts(size).map(([x, y]) => [x, -y]);   // im Uhrzeigersinn
  let v;
  if (key === 'rect') { const h = size / 2; v = [[h, -h], [h, h], [-h, h], [-h, -h]]; }
  else if (key === 'tri') { const H = size * Math.sqrt(3) / 2; v = [[-size / 2, -H / 3], [size / 2, -H / 3], [0, 2 * H / 3]]; }
  else if (key === 'arrow') {   // Spitze nach +x, Mittelpunkt im Schaft
    const L = size, sw = 0.1 * L, hw = 0.25 * L, hl = 0.35 * L, xb = L / 2 - hl;
    // Start an der hinteren unteren Schaftecke: erste Kante = Schaft, Pfeil zeigt in Blickrichtung
    v = [[-L / 2, -sw], [xb, -sw], [xb, -hw], [L / 2, 0], [xb, hw], [xb, sw], [-L / 2, sw]];
    const out = v.concat([v[0]]);
    return out.map(([x, y]) => [r1(x), r1(y)]);
  }
  else if (key === 'star') { v = []; for (let k = 0; k < 10; k++) { const a = (90 + 36 * k) * Math.PI / 180, r = k % 2 ? size * 0.382 : size; v.push([r * Math.cos(a), r * Math.sin(a)]); } }
  else { const h = size / 2; return [[-h, -h], [h, -h], [h, h], [-h, h], [-h, -h], [-h, h], [h, h], [h, -h], [-h, -h]]; }  // Prüfquadrat
  // 10.11.2026: Start an einem ECKPUNKT (vorher: Mitte einer Kante). Gewählt wird die Ecke
  // rechts unten bzw. die Ecke, die am nächsten an +x liegt (beim Stern eine Spitze).
  // Nur äußere Ecken kommen in Frage (beim Stern die Spitzen, nicht die Innenecken).
  const rmax = Math.max(...v.map(([x, y]) => Math.hypot(x, y)));
  let bk = 0, ba = Infinity;
  v.forEach(([x, y], k) => {
    if (Math.hypot(x, y) < rmax * 0.99) return;
    const a = Math.atan2(y, x), m = Math.abs(a) + (a > 0 ? 1e-6 : 0); if (m < ba) { ba = m; bk = k; }
  });
  const out = [];
  for (let k = 0; k <= v.length; k++) out.push(v[(bk + k) % v.length]);
  return out.map(([x, y]) => [r1(x), r1(y)]);
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function polyDist(px, py, poly) { let d = Infinity; for (let k = 1; k < poly.length; k++) d = Math.min(d, segDist(px, py, poly[k - 1][0], poly[k - 1][1], poly[k][0], poly[k][1])); return d; }
function polyInside(px, py, poly) {
  let c = false;
  for (let k = 1; k < poly.length; k++) { const [ax, ay] = poly[k - 1], [bx, by] = poly[k]; if ((ay > py) !== (by > py) && px < ax + (py - ay) / (by - ay) * (bx - ax)) c = !c; }
  return c;
}
// a) parallele Linien im Winkel ang (0° = parallel zur Grundlinie/Unterkante), Abstand gap
function hatchFill(poly, gap, ang, from) {
  const a = ang * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const q = poly.map(([x, y]) => [x * ca + y * sa, -x * sa + y * ca]);      // Linien werden waagerecht
  const ys = q.map(p => p[1]), y0 = Math.min(...ys), y1 = Math.max(...ys), n = Math.max(1, Math.floor((y1 - y0) / gap));
  const first = y0 + (y1 - y0 - (n - 1) * gap) / 2, segs = [];
  for (let k = 0; k < n; k++) {
    const y = first + k * gap, xs = [];
    for (let e = 1; e < q.length; e++) { const [ax, ay] = q[e - 1], [bx, by] = q[e]; if ((ay <= y && by > y) || (by <= y && ay > y)) xs.push(ax + (y - ay) / (by - ay) * (bx - ax)); }
    xs.sort((u, v) => u - v);
    for (let m = 0; m + 1 < xs.length; m += 2) if (xs[m + 1] - xs[m] >= 1) segs.push([[xs[m], y], [xs[m + 1], y]]);
  }
  const back = ([x, y]) => [r1(x * ca - y * sa), r1(x * sa + y * ca)];
  // Reihenfolge: immer das nächstgelegene Linienende als Nächstes (kurze Leerfahrten)
  const out = []; let cur = from || [0, 0];
  const left = segs.map(sg => sg.map(back));
  while (left.length) {
    let bi = 0, br = false, bd = Infinity;
    left.forEach((sg, i) => { for (const r of [false, true]) { const p = r ? sg[1] : sg[0], d = Math.hypot(p[0] - cur[0], p[1] - cur[1]); if (d < bd) { bd = d; bi = i; br = r; } } });
    const sg = left.splice(bi, 1)[0]; if (br) sg.reverse(); out.push(sg); cur = sg[1];
  }
  return out;
}
// b) Kontur nach innen: eine Spirale, deren Windungen dem Umriss im Abstand gap folgen.
// Für jeden Strahl vom Mittelpunkt wird der Abstand zum Rand gemessen; Windung k liegt
// dort, wo dieser Abstand k·gap beträgt. Funktioniert für Formen, die vom Mittelpunkt
// aus ganz sichtbar sind (Kreis, Vieleck, Stern).
function spiralFill(poly, gap, startLevel) {
  let per = 0; for (let k = 1; k < poly.length; k++) per += Math.hypot(poly[k][0] - poly[k - 1][0], poly[k][1] - poly[k - 1][1]);
  const N = Math.max(90, Math.min(360, Math.ceil(per / 2))), rmax = Math.max(...poly.map(p => Math.hypot(p[0], p[1]))) + 1;
  const h = Math.max(0.25, rmax / 500), prof = [];
  for (let i = 0; i < N; i++) {
    const th = i / N * 2 * Math.PI, c = Math.cos(th), s = Math.sin(th), d = [];
    for (let r = 0; r <= rmax; r += h) { if (r > 0 && !polyInside(r * c, r * s, poly)) break; d.push(polyDist(r * c, r * s, poly)); }
    prof.push(d);
  }
  const dc = prof[0][0];
  const R = (i, L) => {   // äußerster Radius auf Strahl i mit Randabstand >= L
    const d = prof[((i % N) + N) % N];
    for (let j = d.length - 1; j >= 0; j--) if (d[j] >= L) { if (j === d.length - 1) return j * h; const t = (d[j] - L) / (d[j] - d[j + 1]); return (j + t) * h; }
    return 0;
  };
  const RL = (phi, L) => { const u = phi / (2 * Math.PI) * N, i = Math.floor(u), f = u - i; return R(i, L) * (1 - f) + R(i + 1, L) * f; };
  const Phi = 2 * Math.PI * (dc - startLevel) / gap; if (Phi <= 0) return [];
  const pts = []; let phi = 0;
  while (true) {
    const L = startLevel + phi / (2 * Math.PI) * gap, r = RL(phi, L);
    pts.push([r * Math.cos(phi), r * Math.sin(phi)]);
    if (phi >= Phi) break;
    phi = Math.min(Phi, phi + Math.max(0.002, Math.min(2 * Math.PI / N, 1 / Math.max(r, 1))));   // ca. 1 mm
  }
  return [rdp(pts, 0.2).map(([x, y]) => [r1(x), r1(y)])];
}
function shapeOpts() {
  return { fill: $('shapeFill').value, gap: Math.max(1, Math.min(50, +$('shapeGap').value || 5)), ang: +$('shapeAng').value || 0, outline: $('shapeOutline').checked };
}
// Liste von Linienzügen; zwischen ihnen fährt der Roboter mit Stift oben
// Offene Linienzüge (11.11.2026): Start 0,0, Blick nach +x, rechts = −y.
function shapePath(key, size, p = {}) {
  const app = APP_SHAPES.find(a => a.key === key);
  const P2 = p.p2 ?? (app.p2 && app.p2.def), P3 = Math.round(p.p3 ?? (app.p3 && app.p3.def));
  let pts = [];
  if (key === 'goat') { const f = size / 100; pts = patternPath(PATTERNS.findIndex(q => q.fw === 'Goat 1')).map(([x, y]) => [x * f, y * f]); }
  else if (key === 'raster') {
    // hoch (x) – rechts 90° – quer (y) – rechts 90° – runter (x) – links 90° – quer (y) – links 90° – hoch …
    const L = size, Y = P2; pts = [[0, 0]];
    for (let i = 0; i < P3; i++) {
      const xe = i % 2 === 0 ? L : 0;
      pts.push([xe, -i * Y]);
      if (i < P3 - 1) pts.push([xe, -(i + 1) * Y]);
    }
  }
  else if (key === 'zigzag') {
    const W = size, H = P2; pts = [[0, 0]];
    for (let i = 0; i < P3; i++) { pts.push([(i + 0.5) * W, H]); pts.push([(i + 1) * W, 0]); }
  }
  return [pts.map(([x, y]) => [r1(x), r1(y)])];
}
function shapeStrokes(key, size, o = { fill: 'none', outline: true }, p = {}) {
  const app = APP_SHAPES.find(a => a.key === key);
  if (app.path) return shapePath(key, size, p);
  const poly = shapeOutline(key, size);
  let strokes;
  if (!app.fill || o.fill === 'none') strokes = [poly];
  else {
    strokes = o.outline ? [poly] : [];
    if (o.fill === 'hatch') strokes.push(...hatchFill(poly, o.gap, o.ang, o.outline ? poly[poly.length - 1] : poly[0]));
    else strokes.push(...spiralFill(poly, o.gap, o.outline ? 0 : o.gap / 2));
  }
  // 10.11.2026: Der Roboter steht am Startpunkt des Umrisses (Ecke bzw. Kreisrand) und schaut
  // entlang der ersten Kante -- keine Leerfahrt aus der Mitte mehr. Dazu alles so verschieben
  // und drehen, dass der Startpunkt bei 0,0 liegt und die erste Kante nach +x zeigt.
  const [x0, y0] = poly[0]; let k = 1;
  while (k < poly.length - 1 && Math.hypot(poly[k][0] - x0, poly[k][1] - y0) < 0.5) k++;
  const a = Math.atan2(poly[k][1] - y0, poly[k][0] - x0), ca = Math.cos(-a), sa = Math.sin(-a);
  const T = ([x, y]) => { const dx = x - x0, dy = y - y0; return [r1(dx * ca - dy * sa), r1(dx * sa + dy * ca)]; };
  return strokes.filter(s => s.length >= 2).map(s => s.map(T));
}
function shapeStroke(key, size, o, p) { return shapeStrokes(key, size, o, p).flatMap(s => s.map((q, i) => [q[0], q[1], i ? 1 : 0])); }
function shapePoints(key, size, o, p) { return shapeStroke(key, size, o, p).map(([x, y, pen]) => ({ x, y, pen })); }
// Zusatzwerte p2/p3 der gewählten Form aus den Eingabefeldern (begrenzt)
function shapeParams(app) {
  const g = (d, id) => d ? Math.max(d.min, Math.min(d.max, +$(id).value || d.def)) : undefined;
  return { p2: g(app.p2, 'shapeP2'), p3: g(app.p3, 'shapeP3') };
}
/* Wiederholen (10.11.2026): nach jeder fertigen Form dreht sich der Roboter am Startpunkt
   um x Grad und zeichnet die Form noch einmal. Die Formen beginnen und enden am Startpunkt
   (= Roboterposition 0,0), deshalb ist jede Wiederholung einfach die um k·x gedrehte Form.
   Anzahl 0 = automatisch bis zum vollen Kreis (360/x). */
function repeatOpts() {
  const on = $('shapeRep').checked, ang = Math.max(1, Math.min(180, Math.abs(+$('shapeRepAng').value || 30)));
  const cnt = Math.max(0, Math.min(360, Math.round(+$('shapeRepCnt').value || 0)));
  return { on, ang, dir: $('shapeRepDir').value, n: on ? (cnt || Math.max(1, Math.round(360 / ang))) : 1 };
}
function repeatStroke(stroke, rp) {
  if (!rp.on || rp.n <= 1) return stroke;
  const out = [];
  for (let k = 0; k < rp.n; k++) {
    const a = (rp.dir === 'l' ? 1 : -1) * rp.ang * k * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    stroke.forEach(([x, y, pen]) => out.push([r1(x * c - y * s), r1(x * s + y * c), pen]));
  }
  return out;
}
function patSel() { return typeof st.pat === 'string' ? APP_SHAPES.find(a => a.key === st.pat) : null; }

function renderPatterns() {
  const box = $('patThumbs'); if (!box) return;
  if (!box.dataset.built) {
    box.innerHTML = PATTERNS.map((p, i) => `<button class="thumb" data-pat="${i}"><canvas></canvas><span>${p.name}</span><small>${p.pts.length} Strecken · im Roboter</small></button>`).join('') +
      APP_SHAPES.map(a => `<button class="thumb" data-pat="${a.key}"><canvas></canvas><span>${a.name}</span><small>${a.fill ? 'Größe wählbar · füllbar' : 'Größe wählbar · Drehtest'}</small></button>`).join('');
    box.dataset.built = '1';
    box.onclick = async ev => {
      const b = ev.target.closest('[data-pat]'); if (!b) return;
      const v = b.dataset.pat;
      if (/^\d+$/.test(v)) {
        st.pat = +v; renderPatterns();
        if (st.connected && await ensureMenu(2)) sendText('PATTERN ' + st.pat);
      } else {
        st.pat = v; const a = patSel(); $('shapeSize').value = load('shape.' + v, a.def);
        if (a.p2) $('shapeP2').value = load('shape.' + v + '.p2', a.p2.def);
        if (a.p3) $('shapeP3').value = load('shape.' + v + '.p3', a.p3.def);
        renderPatterns();
      }
    };
  }
  box.querySelectorAll('[data-pat]').forEach(b => {
    const v = b.dataset.pat, fw = /^\d+$/.test(v);
    b.setAttribute('aria-pressed', String(fw ? +v === st.pat : v === st.pat));
    drawPathOn(b.querySelector('canvas'), fw ? patternPath(+v) : shapeStroke(v, APP_SHAPES.find(a => a.key === v).def), { pad: 8, lw: 1.5 });
  });
  const app = patSel();
  $('patFwCtl').hidden = !!app; $('shapeCtl').hidden = !app;
  if (app) {
    const size = Math.max(10, Math.min(400, +$("shapeSize").value || app.def));
    $('shapeLbl').textContent = app.label;
    $('shapeP2F').hidden = !app.p2; $('shapeP3F').hidden = !app.p3;
    if (app.p2) $('shapeP2Lbl').textContent = app.p2.label;
    if (app.p3) $('shapeP3Lbl').textContent = app.p3.label;
    const sp = shapeParams(app);
    $('shapeFillCtl').hidden = !app.fill;
    // Pfeil: Spirale nicht möglich (Form ist vom Mittelpunkt aus nicht ganz sichtbar)
    $('shapeFill').querySelector('option[value="spiral"]').disabled = !!app.noSpiral;
    if (app.noSpiral && $('shapeFill').value === 'spiral') $('shapeFill').value = 'hatch';
    const o = app.fill ? shapeOpts() : { fill: 'none', outline: true };
    $('shapeGapF').hidden = o.fill === 'none'; $('shapeAngF').hidden = o.fill !== 'hatch'; $('shapeOutlineF').hidden = o.fill === 'none';
    const rp = repeatOpts(), stroke = repeatStroke(shapeStroke(app.key, size, o, sp), rp), pts = stroke.map(([x, y, pen]) => ({ x, y, pen })), plan = planRobot(pts, st.cfg);
    $('shapeRepAngF').hidden = $('shapeRepDirF').hidden = $('shapeRepCntF').hidden = !rp.on;
    drawPathOn($('patCv'), stroke, { grid: true, robot: true });
    let L = 0, T = 0;
    for (let k = 1; k < stroke.length; k++) { const d = Math.hypot(stroke[k][0] - stroke[k - 1][0], stroke[k][1] - stroke[k - 1][1]); if (stroke[k][2]) L += d; else T += d; }
    const xs = stroke.map(p => p[0]), ys = stroke.map(p => p[1]);
    $('patTitle').textContent = app.name + (o.fill === 'hatch' ? ' – Linienfüllung' : o.fill === 'spiral' ? ' – Spiralfüllung' : '') + (rp.on ? ` – ${rp.n}× um ${rp.ang}° ${rp.dir === 'l' ? 'links' : 'rechts'} gedreht` : '');
    const tooMany = pts.length > st.cfg.pmax;
    $('patStats').innerHTML = [['Größe', `${Math.round(Math.max(...xs) - Math.min(...xs))} × ${Math.round(Math.max(...ys) - Math.min(...ys))} mm`],
      ['Linie', (L / 10).toFixed(1) + ' cm'], ['Leerfahrt', (T / 10).toFixed(1) + ' cm'], ['Punkte', tooMany ? `<b style="color:var(--stop)">${pts.length} (max. ${st.cfg.pmax})</b>` : pts.length],
      ['Dauer ca.', fmtTime(plan.total)], ['Start', 'Ecke / Rand (grüner Punkt)']]
      .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    st.shapeCur = { pts, plan };
    $('shapeSend').disabled = st.sending || tooMany;
    return;
  }
  const pts = patternPath(st.pat);
  drawPathOn($('patCv'), pts, { grid: true, robot: true });
  let L = 0; for (let k = 1; k < pts.length; k++) L += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
  const xs = PATTERNS[st.pat].pts.map(p => p[0]), ys = PATTERNS[st.pat].pts.map(p => p[1]);
  $('patTitle').textContent = PATTERNS[st.pat].name;
  $('patStats').innerHTML = [['Strecken', PATTERNS[st.pat].pts.length], ['Linie gesamt', (L / 10).toFixed(1) + ' cm'],
    ['Größe ca.', `${Math.max(...xs, 0) - Math.min(...xs, 0)} × ${Math.max(...ys, 0) - Math.min(...ys, 0)} cm`], ['Im Roboter', PATTERNS[st.pat].fw]]
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}
function sendShape() {
  const app = patSel(); if (!app || !st.shapeCur) return;
  return sendPath(st.shapeCur.pts, { menu: 2, paper: 'beliebig', plan: st.shapeCur.plan, prog: $('shapeProg'), info: $('shapeInfo'), target: 'shape', onState: renderPatterns });
}

/* ------------------------------------------------------------------ Menü 7: Kunst */
function syncArtCfg() {
  const c = st.cfg, C = ArtGen.CFG;
  C.wheelMm = c.wheel; C.trackMm = c.track; C.stepsPerRev = c.spr; C.penMoveSec = c.penms / 1000; C.returnHome = !!c.ret;
  C.profiles = c.prof.map((p, i) => ({ name: SPEED_NAMES[i], acc: p.a, max: p.v }));
  C.lineProfile = c.art[0] || 0; C.turnProfile = c.art[1] != null ? c.art[1] : 2;
  if (st.view === 'm7') renderArt(false);
}
function drawArtOn(cvs, plan, opts = {}) {
  const r = cvs.getBoundingClientRect(); if (!r.width) return;
  const dpr = window.devicePixelRatio || 1, g = cvs.getContext('2d');
  cvs.width = Math.round(r.width * dpr); cvs.height = Math.round(r.height * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, r.width, r.height);
  const pw = plan.paper.w, ph = plan.paper.h, pad = opts.pad || 10;
  const sc = Math.min((r.width - 2 * pad) / pw, (r.height - 2 * pad) / ph);
  const ox = r.width / 2, oy = r.height / 2, P = (x, y) => [ox + x * sc, oy - y * sc];
  g.fillStyle = css('--paper'); g.fillRect(ox - pw / 2 * sc, oy - ph / 2 * sc, pw * sc, ph * sc);
  if (opts.travel) {
    g.strokeStyle = css('--travel'); g.lineWidth = 1; g.setLineDash([4, 4]); g.beginPath();
    for (const [x0, y0, x1, y1, pen] of plan.route) if (!pen) { const [a, b] = P(x0, y0), [c, d] = P(x1, y1); g.moveTo(a, b); g.lineTo(c, d); }
    g.stroke(); g.setLineDash([]);
  }
  g.strokeStyle = css('--accent'); g.lineWidth = opts.lw || 1; g.lineJoin = 'round'; g.lineCap = 'round'; g.beginPath();
  let open = false;
  for (const [x0, y0, x1, y1, pen] of plan.route) {
    if (!pen) { open = false; continue; }
    const [a, b] = P(x0, y0), [c, d] = P(x1, y1);
    if (!open) { g.moveTo(a, b); open = true; } g.lineTo(c, d);
  }
  g.stroke();
}
let artTimer = null;
function renderArt(fromRobot) {
  const box = $('artThumbs'); if (!box) return;
  const a = st.art;
  if (!box.dataset.built) {
    box.innerHTML = ArtGen.NAMES.map((n, i) => `<button class="thumb" data-algo="${i}"><canvas></canvas><span>${n}</span></button>`).join('');
    box.dataset.built = '1';
    box.onclick = ev => { const b = ev.target.closest('[data-algo]'); if (b) { st.art.algo = +b.dataset.algo; artChanged(); } };
    $('artPaper').innerHTML = ArtGen.PAPERS.map((p, i) => `<button data-paper="${i}">${p.name}</button>`).join('');
    $('artPaper').onclick = ev => { const b = ev.target.closest('[data-paper]'); if (b) { st.art.paper = +b.dataset.paper; artChanged(); } };
  }
  if (st.view !== 'm7') return;
  box.querySelectorAll('[data-algo]').forEach(b => {
    const i = +b.dataset.algo; b.setAttribute('aria-pressed', i === a.algo);
    drawArtOn(b.querySelector('canvas'), ArtGen.plan(i, a.seed, a.paper), { pad: 4, lw: 0.6 });
  });
  $('artPaper').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', +b.dataset.paper === a.paper));
  $('artSeed').value = a.seed;
  const plan = ArtGen.plan(a.algo, a.seed, a.paper);
  drawArtOn($('artCv'), plan, { travel: true, lw: 1.2, pad: 14 });
  $('artTitle').textContent = ArtGen.NAMES[a.algo];
  const fm = mm => (mm / 1000).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' m';
  $('artStats').innerHTML = [['Dauer ca.', fmtTime(plan.sec)], ['Linie', fm(plan.drawMm)], ['Leerfahrt', fm(plan.travelMm)], ['Absetzen', plan.lifts + '×'], ['Punkte', plan.pointCount]]
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  $('artSync').textContent = !st.connected ? 'Nicht verbunden – nur Vorschau.' :
    fromRobot ? 'Stimmt mit dem Roboter überein.' : st.menu === 7 ? 'Wird an den Roboter übertragen …' : 'Beim Zeichnen schaltet die App den Roboter auf Menü 7.';
}
function artChanged() {
  st.art.seed = Math.max(1, Math.min(999999, Math.floor(st.art.seed) || 1));
  store('art', st.art); renderArt(false);
  clearTimeout(artTimer);
  if (!st.connected) return;
  artTimer = setTimeout(async () => { if (await ensureMenu(7)) sendText(`ART ${st.art.algo} ${st.art.seed} ${st.art.paper}`); }, 350);
}

/* ------------------------------------------------------------------ Menü 2: Bild -> Linien (neu 27.10.2026)
   Vorgehen:
     1. Bild auf höchstens IMG_MAX Pixel verkleinern, in Graustufen umrechnen, leicht
        weichzeichnen, Kontrast strecken (1.–99. Perzentil).
     2. Linien gewinnen – drei Verfahren:
        - Umriss:     Marching Squares auf der Helligkeit bei EINER Schwelle (Startwert
                      nach Otsu) -> geschlossene Konturen der dunklen Flächen.
        - Höhenlinien: dasselbe bei 2–5 Schwellen -> wirkt wie eine Landkarte.
        - Schraffur:  parallele Linien nur dort, wo es dunkel ist; je dunkler, desto
                      mehr Lagen (45°, −45°, 0°, 90°). Wenige, lange Striche.
     3. In mm umrechnen (aufs Blatt einpassen), vereinfachen (Ramer-Douglas-Peucker),
        kurze Schnipsel weglassen, Reihenfolge optimieren (nächster Nachbar).
     4. Wie jede App-Zeichnung übertragen; gezeichnet wird in Menü 2. */
const IMG_MAX = 360, IMG_MARGIN = 15;
const imgSt = { src: null, gray: null, w: 0, h: 0, name: '', strokes: [], points: [], plan: null, scale: 1, thrSet: false };

function imgParam() {
  return {
    mode: $('imgMode').value, thr: +$('imgThr').value / 100, levels: +$('imgLevels').value,
    spacing: +$('imgSpacing').value, eps: +$('imgDetail').value / 10, minLen: +$('imgMin').value,
    invert: $('imgInvert').checked, paper: $('imgPaper').value, size: +$('imgSize').value / 100,
  };
}
function imgLabels() {
  const p = imgParam();
  $('imgThrV').textContent = Math.round(p.thr * 100) + ' %';
  $('imgLevelsV').textContent = p.levels;
  $('imgSpacingV').textContent = p.spacing + ' mm';
  $('imgDetailV').textContent = p.eps.toFixed(1) + ' mm';
  $('imgMinV').textContent = p.minLen + ' mm';
  $('imgSizeV').textContent = Math.round(p.size * 100) + ' %';
  $('imgLevelsF').hidden = p.mode === 'outline';
  $('imgSpacingF').hidden = p.mode !== 'hatch';
}

function loadImageFile(file) {
  if (!file) return;
  const url = URL.createObjectURL(file), im = new Image();
  im.onload = () => {
    const k = Math.min(1, IMG_MAX / Math.max(im.width, im.height));
    const w = Math.max(2, Math.round(im.width * k)), h = Math.max(2, Math.round(im.height * k));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(im, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data, raw = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) raw[i] = (0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2]) / 255;
    const gray = new Float32Array(w * h);           // 3x3-Weichzeichner gegen Pixelrauschen
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; s += raw[yy * w + xx]; n++;
      }
      gray[y * w + x] = s / n;
    }
    const sorted = Float32Array.from(gray).sort(), lo = sorted[Math.floor(sorted.length * 0.01)], hi = sorted[Math.floor(sorted.length * 0.99)];
    for (let i = 0; i < gray.length; i++) gray[i] = Math.max(0, Math.min(1, (gray[i] - lo) / Math.max(1e-3, hi - lo)));
    Object.assign(imgSt, { src: c, gray, w, h, name: file.name });
    $('imgThr').value = Math.round(otsu(gray) * 100);    // Startwert für die Schwelle
    $('imgName').textContent = `${file.name} · ${im.width} × ${im.height} px`;
    URL.revokeObjectURL(url);
    convertImage();
  };
  im.onerror = () => { $('imgName').textContent = 'Das Bild ließ sich nicht öffnen. Bitte JPG oder PNG wählen.'; URL.revokeObjectURL(url); };
  im.src = url;
}

function otsu(gray) {
  const hist = new Array(256).fill(0);
  for (const v of gray) hist[Math.min(255, Math.floor(v * 255))]++;
  const N = gray.length; let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, bestT = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue; const wF = N - wB; if (!wF) break;
    sB += t * hist[t]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; bestT = t; }
  }
  return Math.max(0.05, Math.min(0.95, (bestT + 0.5) / 255));
}

/* Marching Squares: Konturen von f = Helligkeit - t (dunkel = innen). Liefert Linienzüge in Pixeln. */
function contours(gray, w, h, t, invert) {
  const f = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 1 : (invert ? t - gray[y * w + x] : gray[y * w + x] - t);
  const W = w + 3, H = h + 3;
  const key = (type, x, y) => (type * W + (x + 1)) * H + (y + 1);
  const pos = new Map(), adj = new Map(), segs = [];
  const edgePt = (type, x, y) => {
    const k = key(type, x, y);
    if (!pos.has(k)) {
      let p;
      if (type === 0) { const a = f(x, y), b = f(x + 1, y), u = a / (a - b); p = [x + u, y]; }      // waagrechte Kante
      else { const a = f(x, y), b = f(x, y + 1), u = a / (a - b); p = [x, y + u]; }                 // senkrechte Kante
      pos.set(k, p);
    }
    return k;
  };
  const T = (x, y) => edgePt(0, x, y), B = (x, y) => edgePt(0, x, y + 1), L = (x, y) => edgePt(1, x, y), R = (x, y) => edgePt(1, x + 1, y);
  const add = (a, b) => { const i = segs.length; segs.push([a, b]); for (const k of [a, b]) { if (!adj.has(k)) adj.set(k, []); adj.get(k).push(i); } };
  for (let y = -1; y < h; y++) for (let x = -1; x < w; x++) {
    const c = (f(x, y) < 0 ? 8 : 0) | (f(x + 1, y) < 0 ? 4 : 0) | (f(x + 1, y + 1) < 0 ? 2 : 0) | (f(x, y + 1) < 0 ? 1 : 0);
    switch (c) {
      case 1: case 14: add(L(x, y), B(x, y)); break;
      case 2: case 13: add(B(x, y), R(x, y)); break;
      case 3: case 12: add(L(x, y), R(x, y)); break;
      case 4: case 11: add(T(x, y), R(x, y)); break;
      case 6: case 9: add(T(x, y), B(x, y)); break;
      case 7: case 8: add(L(x, y), T(x, y)); break;
      case 5: add(L(x, y), T(x, y)); add(B(x, y), R(x, y)); break;
      case 10: add(T(x, y), R(x, y)); add(L(x, y), B(x, y)); break;
    }
  }
  const used = new Uint8Array(segs.length), out = [];
  const nextFrom = (k) => { for (const i of adj.get(k) || []) if (!used[i]) return i; return -1; };
  for (let s0 = 0; s0 < segs.length; s0++) {
    if (used[s0]) continue;
    used[s0] = 1; const chain = [segs[s0][0], segs[s0][1]];
    for (let end = 0; end < 2; end++) {               // erst vorwärts, dann rückwärts verlängern
      for (;;) {
        const k = end === 0 ? chain[chain.length - 1] : chain[0];
        const i = nextFrom(k); if (i < 0) break;
        used[i] = 1; const o = segs[i][0] === k ? segs[i][1] : segs[i][0];
        if (end === 0) chain.push(o); else chain.unshift(o);
      }
    }
    out.push(chain.map(k => pos.get(k)));
  }
  return out;
}

/* Schraffur: Lagen paralleler Linien, je dunkler desto mehr Lagen. Abstand in Pixeln. */
function hatch(gray, w, h, thr, levels, spacingPx, invert) {
  const angles = [45, -45, 0, 90], out = [];
  const val = (x, y) => { const v = gray[Math.min(h - 1, Math.max(0, Math.round(y))) * w + Math.min(w - 1, Math.max(0, Math.round(x)))]; return invert ? 1 - v : v; };
  for (let k = 0; k < levels; k++) {
    const lim = thr * (levels - k) / levels, a = angles[k % 4] * Math.PI / 180;
    const dx = Math.cos(a), dy = Math.sin(a), nx = -dy, ny = dx;
    const cs = [[0, 0], [w, 0], [0, h], [w, h]];
    const ns = cs.map(([x, y]) => x * nx + y * ny), ds = cs.map(([x, y]) => x * dx + y * dy);
    const n0 = Math.min(...ns), n1 = Math.max(...ns), d0 = Math.min(...ds), d1 = Math.max(...ds);
    let flip = false;
    for (let o = n0 + spacingPx / 2; o < n1; o += spacingPx) {
      const runs = []; let cur = null;
      for (let t = d0; t <= d1; t += 0.5) {
        const x = o * nx + t * dx, y = o * ny + t * dy;
        const inside = x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1 && val(x, y) < lim;
        if (inside) { if (!cur) cur = [[x, y], [x, y]]; else cur[1] = [x, y]; }
        else if (cur) { runs.push(cur); cur = null; }
      }
      if (cur) runs.push(cur);
      if (flip) { runs.reverse(); runs.forEach(r => r.reverse()); }
      flip = !flip;
      out.push(...runs);
    }
  }
  return out;
}

function orderStrokes(strokes) {   // nächster Nachbar ab der Blattmitte, Strich ggf. umgedreht
  strokes = strokes.map(s => s.slice()); const out = []; let cx = 0, cy = 0;
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
  return out;
}

function convertImage() {
  imgLabels();
  if (!imgSt.gray) { imgSt.strokes = []; imgSt.points = []; imgSt.plan = null; renderImgStats(); renderImg(); return; }
  const p = imgParam(), [PW, PH] = PAPERS[p.paper] || PAPERS.A3, { w, h, gray } = imgSt;
  const s = Math.min((PW - 2 * IMG_MARGIN) * p.size / w, (PH - 2 * IMG_MARGIN) * p.size / h);   // mm pro Pixel
  imgSt.scale = s;
  let raw;
  if (p.mode === 'hatch') raw = hatch(gray, w, h, p.thr, p.levels, Math.max(1, p.spacing / s), p.invert);
  else if (p.mode === 'iso') { raw = []; for (let k = 1; k <= p.levels; k++) raw.push(...contours(gray, w, h, k / (p.levels + 1), p.invert)); }
  else raw = contours(gray, w, h, p.thr, p.invert);
  const toMm = ([x, y]) => [Math.round((x - w / 2) * s * 10) / 10, Math.round(-(y - h / 2) * s * 10) / 10];
  let strokes = raw.map(st0 => rdp(st0.map(toMm), p.eps)).filter(q => q.length >= 2 && pathLen(q) >= Math.max(1, p.minLen));
  strokes = orderStrokes(strokes);
  imgSt.strokes = strokes;
  const pts = [];
  for (const q of strokes) q.forEach((pt, i) => pts.push({ x: pt[0], y: pt[1], pen: i ? 1 : 0 }));
  imgSt.points = pts;
  imgSt.plan = pts.length >= 2 ? planRobot(pts, st.cfg) : null;
  renderImgStats(); renderImg();
}

function renderImgStats() {
  const p = imgSt.plan, warn = [];
  if (!imgSt.gray) { $('imgStats').innerHTML = '<dt>Noch kein Bild gewählt</dt><dd></dd>'; $('imgWarn').innerHTML = ''; $('imgSend').disabled = true; return; }
  if (!p) { $('imgStats').innerHTML = '<dt>Keine Linien gefunden</dt><dd></dd>'; $('imgWarn').innerHTML = '<li>Schwelle verschieben oder „Hell und dunkel tauschen“.</li>'; $('imgSend').disabled = true; return; }
  const s = p.stats;
  $('imgStats').innerHTML = [['Linienzüge', imgSt.strokes.length], ['Punkte', imgSt.points.length], ['Linie', (s.draw / 1000).toFixed(1) + ' m'],
    ['Leerfahrt', (s.travel / 1000).toFixed(1) + ' m'], ['Stift aufsetzen', s.lowerings + '×'], ['Dauer ca.', fmtTime(p.total)]]
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  if (imgSt.points.length > st.cfg.pmax) warn.push(`Zu viele Punkte (${imgSt.points.length}, höchstens ${st.cfg.pmax}): „Vereinfachen“ oder „Kürzeste Linie“ erhöhen, oder weniger Stufen.`);
  if (s.lowerings > 300) warn.push('Sehr viele Einzelstriche – das dauert lange. „Kürzeste Linie“ erhöhen hilft.');
  $('imgWarn').innerHTML = warn.map(x => `<li>${x}</li>`).join('');
  $('imgSend').disabled = imgSt.points.length > st.cfg.pmax || st.sending;
}

function renderImg() {
  const cvs = $('imgCv'); if (!cvs) return;
  const r = cvs.getBoundingClientRect(); if (!r.width) return;
  const dpr = window.devicePixelRatio || 1, g = cvs.getContext('2d');
  cvs.width = Math.round(r.width * dpr); cvs.height = Math.round(r.height * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, r.width, r.height);
  const p = imgParam(), [PW, PH] = PAPERS[p.paper] || PAPERS.A3, pad = 12;
  const sc = Math.min((r.width - 2 * pad) / PW, (r.height - 2 * pad) / PH), ox = r.width / 2, oy = r.height / 2;
  const P = (x, y) => [ox + x * sc, oy - y * sc];
  g.fillStyle = css('--paper'); g.fillRect(ox - PW / 2 * sc, oy - PH / 2 * sc, PW * sc, PH * sc);
  g.fillStyle = '#7b8494'; g.font = '11px ' + css('--font-data'); g.fillText(`${p.paper} · ${PW} × ${PH} mm`, ox - PW / 2 * sc + 6, oy - PH / 2 * sc + 14);
  if (!imgSt.gray) {
    g.fillStyle = '#7b8494'; g.font = '14px ' + css('--font-body'); g.textAlign = 'center';
    g.fillText('Noch kein Bild – oben „Bild wählen …“', ox, oy); g.textAlign = 'start'; return;
  }
  if ($('imgShowSrc').checked) {
    const s = imgSt.scale * sc; g.globalAlpha = 0.22;
    g.drawImage(imgSt.src, ox - imgSt.w / 2 * s, oy - imgSt.h / 2 * s, imgSt.w * s, imgSt.h * s); g.globalAlpha = 1;
  }
  g.strokeStyle = css('--accent'); g.lineWidth = 1.2; g.lineJoin = 'round'; g.lineCap = 'round';
  const live = st.live && st.live.target === 'img' ? st.live : null;
  for (const q of imgSt.strokes) { g.beginPath(); q.forEach(([x, y], i) => { const [a, b] = P(x, y); i ? g.lineTo(a, b) : g.moveTo(a, b); }); g.stroke(); }
  const [rx, ry] = live ? P(live.x, live.y) : P(0, 0);
  g.strokeStyle = css('--ok'); g.lineWidth = 2; g.beginPath(); g.arc(rx, ry, 6, 0, 7); g.stroke();
}

function sendImage() {
  return sendPath(imgSt.points, { menu: 2, paper: $('imgPaper').value, plan: imgSt.plan, prog: $('imgProg'), info: $('imgInfo'), target: 'img', onState: renderImgStats });
}

/* ------------------------------------------------------------------ Aufbau */
function setTheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; store('theme', t); render(); renderImg(); renderPatterns(); renderArt(false); }

function init() {
  if (!navigator.bluetooth) $('noBt').hidden = false;
  setTheme(load('theme', ''));
  $('btnConnect').onclick = () => { if (!navigator.bluetooth && !st.connected) { $('noBt').hidden = false; return; } connect(false); };
  $('btnDemo').onclick = () => connect(true);
  $('btnStop').onclick = () => { sendText('STOP'); draw.playing = false; };

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
    if ($('padCard').hidden) return;
    ev.preventDefault(); const el = document.querySelector(`.key[data-key="${n}"]`); el && el.classList.add('down'); sendKey(n, true);
  });
  window.addEventListener('keyup', ev => {
    const n = keyFor[ev.key]; if (!n || typing() || $('padCard').hidden) return;
    const el = document.querySelector(`.key[data-key="${n}"]`); if (el && el.classList.contains('down')) { el.classList.remove('down'); sendKey(n, false); }
  });
  // Menü-Ansichten: Tasten-Knöpfe (data-tap / data-hold / data-confirm)
  document.querySelectorAll('section.pane [data-tap], section.pane [data-hold], section.pane [data-confirm]').forEach(b => b.addEventListener('click', () => menuAction(b)));
  $('menuBanner').onclick = ev => { if (ev.target.dataset.act === 'goto') { const m = viewMenu(st.view); if (m != null) ensureMenu(m); } };
  for (const id of ['m2tabs', 'm8tabs']) {
    $(id).onclick = ev => {
      const b = ev.target.closest('[data-sub]'); if (!b) return;
      const pre = id.slice(0, 2);
      $(id).querySelectorAll('[data-sub]').forEach(x => x.setAttribute('aria-selected', x === b));
      $(id).querySelectorAll('[data-sub]').forEach(x => $(pre + '-' + x.dataset.sub).hidden = x !== b);
      store(id, b.dataset.sub);
      requestAnimationFrame(() => { resizeCanvas(); renderImg(); renderPatterns(); });
    };
    const saved = load(id, null); if (saved) { const b = $(id).querySelector(`[data-sub="${saved}"]`); if (b) b.click(); }
  }
  // Menü 2: Bild
  $('imgPaper').innerHTML = Object.keys(PAPERS).map(k => `<option ${k === 'A3' ? 'selected' : ''}>${k}</option>`).join('');
  $('imgFile').onchange = ev => loadImageFile(ev.target.files[0]);
  ['imgMode', 'imgThr', 'imgLevels', 'imgSpacing', 'imgDetail', 'imgMin', 'imgInvert', 'imgPaper', 'imgSize'].forEach(id => $(id).addEventListener('input', () => { imgLabels(); clearTimeout(imgSt.t); imgSt.t = setTimeout(convertImage, 120); }));
  $('imgShowSrc').onchange = renderImg;
  $('shapeSize').oninput = () => { const a = patSel(); if (a) store('shape.' + a.key, +$('shapeSize').value); renderPatterns(); };
  ['shapeP2', 'shapeP3'].forEach((id, i) => $(id).oninput = () => { const a = patSel(); if (a) store('shape.' + a.key + (i ? '.p3' : '.p2'), +$(id).value); renderPatterns(); });
  // Füllung (01.11.2026): Einstellungen gelten für alle Formen und bleiben gespeichert
  $('shapeFill').value = load('shape.fill', 'none'); $('shapeGap').value = load('shape.gap', 5);
  $('shapeAng').value = load('shape.ang', 0); $('shapeOutline').checked = load('shape.outline', true);
  $('shapeRep').checked = load('shape.rep', false); $('shapeRepAng').value = load('shape.repAng', 30);
  $('shapeRepDir').value = load('shape.repDir', 'l'); $('shapeRepCnt').value = load('shape.repCnt', 0);
  ['shapeRep', 'shapeRepAng', 'shapeRepDir', 'shapeRepCnt'].forEach(id => $(id).oninput = $(id).onchange = () => {
    store('shape.rep', $('shapeRep').checked); store('shape.repAng', +$('shapeRepAng').value);
    store('shape.repDir', $('shapeRepDir').value); store('shape.repCnt', +$('shapeRepCnt').value); renderPatterns();
  });
  ['shapeFill', 'shapeGap', 'shapeAng', 'shapeOutline'].forEach(id => $(id).oninput = $(id).onchange = () => {
    store('shape.fill', $('shapeFill').value); store('shape.gap', +$('shapeGap').value);
    store('shape.ang', +$('shapeAng').value); store('shape.outline', $('shapeOutline').checked); renderPatterns();
  });
  $('shapeSend').onclick = sendShape;
  // Einstellungen: Stift
  const penAng = id => Math.max(0, Math.min(180, Math.round(+$(id).value || 0)));
  const penMenu = async () => { if (st.menu === 0 || st.menu === 8) return true; return ensureMenu(0); };
  $('penSet').onclick = async () => { if (!st.connected || !(await penMenu())) return; sendText('SET PENUP ' + penAng('penUpIn')); await sleep(150); sendText('SET PENDOWN ' + penAng('penDownIn')); };
  $('penTestUp').onclick = async () => { if (st.connected && await penMenu()) sendText('PEN U'); };
  ['tfGapW', 'tfGapS', 'tfDir', 'tfSideW', 'tfSideS'].forEach(id => $(id).oninput = $(id).onchange = updateTurnFactors);
  $('tfTestR').onclick = () => runTurnTest('r');
  $('tfTestL').onclick = () => runTurnTest('l');
  $('tfSet').onclick = async () => {
    const r = turnTestEval();
    if (await setValue((r.dir === 'r' ? 'SET TURNR ' : 'SET TURNL ') + r.f.toFixed(3), 'tfSt')) { $('tfGapW').value = 0; $('tfGapS').value = 0; }
    updateTurnFactors();
  };
  $('penTestDown').onclick = async () => { if (st.connected && await penMenu()) sendText('PEN D'); };
  $('imgSend').onclick = sendImage;
  new ResizeObserver(() => renderImg()).observe($('imgBox'));
  new ResizeObserver(() => renderPatterns()).observe($('patBox'));
  imgLabels(); renderImgStats();
  // Menü 7: Kunst
  st.art = Object.assign(st.art, load('art', {}));
  $('artSeed').onchange = () => { st.art.seed = +$('artSeed').value; artChanged(); };
  $('artSeedDown').onclick = () => { st.art.seed = Math.max(1, st.art.seed - 1); artChanged(); };
  $('artSeedUp').onclick = () => { st.art.seed += 1; artChanged(); };
  $('artRand').onclick = () => { st.art.seed = 1 + Math.floor(Math.random() * 999999); artChanged(); };
  new ResizeObserver(() => { if (st.view === 'm7') renderArt(false); }).observe($('artBox'));

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
  $('btnCalTurn').onclick = () => setValue('SET TRACK ' + $('btnCalTurn').dataset.v, 'calTurnSt');
  $('btnCalDist').onclick = async () => { if (await setValue('SET WHEEL ' + $('btnCalDist').dataset.v, 'calDistSt')) $('calDistAct').value = $('calDistCmd').value; };
  $('calDistTest').onclick = runDistTest;
  ['trLen', 'trSag', 'trDir'].forEach(id => $(id).oninput = $(id).onchange = updateTrim);
  $('trTest').onclick = runTrimTest;
  $('spinL').onclick = () => runSpin('L');
  const corrSet = async v => {
    if (!st.connected) return;
    for (let k = 0; k < 2; k++) {
      try { const p = expect(/^@OK CORR/); sendText('CORR ' + v); await p; logLine(v ? 'Korrekturen AN' : 'Korrekturen AUS'); return; }
      catch (e) {
        if (k === 0 && /busy/.test(e.message)) { logLine('Roboter war beschäftigt – halte an und versuche es nochmal.'); sendText('STOP'); await sleep(800); continue; }
        logLine('Korrekturen: ' + e.message, 'err'); $('corrState').innerHTML += `<br><b style="color:var(--stop)">Nicht umgeschaltet: ${e.message}</b>`; return;
      }
    }
  };
  $('corrOn').onclick = () => corrSet(1);
  ['blR', 'blGap', 'blEnd', 'blSide'].forEach(id => $(id).oninput = $(id).onchange = updateBl);
  $('blCircL').onclick = () => drawTestCircle('l');
  $('blCircR').onclick = () => drawTestCircle('r');
  $('blSet').onclick = async () => { const r = blEval(); if (await setValue((r.side === 'l' ? 'SET BLL ' : 'SET BLR ') + r.nw.toFixed(1), 'blSt')) $('blGap').value = 0; updateBl(); };
  $('corrOff').onclick = () => corrSet(0);
  ['spinCntL', 'spinCntR'].forEach(id => $(id).oninput = updateSpin);
  $('spinSet').onclick = async () => {
    const r = spinEval();
    // Felder sofort nach jedem erfolgreichen Wert zurücksetzen (sonst doppelte Korrektur bei erneutem Druck)
    if (await setValue('SET WSL ' + r.fl.toFixed(3), 'spinSt')) $('spinCntL').value = SPIN_TURNS;
    if (await setValue('SET WSR ' + r.fr.toFixed(3), 'spinSt')) $('spinCntR').value = SPIN_TURNS;
    updateSpin();
  };
  $('spinR').onclick = () => runSpin('R');
  $('trSet').onclick = async () => { const r = trimEval(); if (await setValue('SET TRIM ' + r.t.toFixed(4), 'trSt')) $('trSag').value = 0; updateTrim(); };
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

  logLine('PaintBot-App ' + APP_VERSION);
  renderCfg(); renderStatus(); recomputePlan();
  renderArt(false); syncArtCfg();
  selectView(load('view', 'm0'), false);
  logLine('Bereit. „Verbinden“ wählt den Roboter aus der Bluetooth-Liste.');
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
