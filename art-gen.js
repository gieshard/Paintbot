// PaintBot Generative Kunst -- Generator, 1:1 aus GenerativeArt.ino uebertragen.
// Gleiche Reihenfolge der Zufallszahlen, gleiche Formeln -> gleiche Bilder.
const ArtGen = (() => {
  const DEG = Math.PI / 180;
  const NAMES = ["Rosette", "Spirale", "Koch-Schneeflocke", "Hilbert-Kurve", "Drachenkurve",
                 "Sierpinski-Pfeilspitze", "Pflanze", "Zufallsweg",
                 "Evolution (Rechenberg)", "Ameisen (ACO)"];
  const ROSETTE = 0, SPIRAL = 1, KOCH = 2, HILBERT = 3, DRAGON = 4, SIERPINSKI = 5, PLANT = 6, WALK = 7, EVOLUTION = 8, ANTS = 9;
  const PAPERS = [{ name: "A3", w: 420, h: 297 }, { name: "A2", w: 594, h: 420 }, { name: "A1", w: 841, h: 594 }];
  // Konstanten aus global.h
  const CFG = {
    margin: 20, minSeg: 1.0, returnHome: true, trackMm: 142.5,
    wheelMm: 63.0, stepsPerRev: 500, penMoveSec: 0.3,
    profiles: [{ name: "Langsam", acc: 400, max: 150 }, { name: "Mittel", acc: 600, max: 280 }, { name: "Schnell", acc: 850, max: 420 }],
    lineProfile: 0, turnProfile: 2,
  };

  function makeGen(algo, seed) {
    let rng = ((Math.imul(seed >>> 0, 2654435761) >>> 0) ^ 0xA5A5A5A5) >>> 0;
    function next() {
      rng = (rng + 0x6D2B79F5) >>> 0;
      let t = rng;
      t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
      t = (t ^ (t + (Math.imul(t ^ (t >>> 7), t | 61) >>> 0))) >>> 0;
      return (t ^ (t >>> 14)) >>> 0;
    }
    const rand = () => next() / 4294967296;
    const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

    let x = 0, y = 0, head = 0, started = false, pending = false;
    let N = 0, K = 0, angle = 0, jitter = 0, I = 0, J = 0, maxDepth = 0;
    const walkW = 1.41421356, walkH = 1.0;
    let lstack = [], tstack = [];

    const AXIOM = { [KOCH]: "F--F--F", [HILBERT]: "A", [DRAGON]: "FX", [SIERPINSKI]: "A", [PLANT]: "X" };
    const RULES = {
      [KOCH]: { F: "F+F--F+F" },
      [HILBERT]: { A: "+BF-AFA-FB+", B: "-AF+BFB+FA-" },
      [DRAGON]: { X: "X+YF+", Y: "-FX-Y" },
      [SIERPINSKI]: { A: "B-A-B", B: "A+B+A" },
      [PLANT]: { X: "F+[[X]-X]-F[-FX]+X", F: "FF" },
    };
    const isDraw = c => c === "F" || (algo === SIERPINSKI && (c === "A" || c === "B"));
    const turnAngle = () => jitter > 0 ? angle + (rand() * 2 - 1) * jitter : angle;

    switch (algo) {
      case ROSETTE: N = randInt(3, 8); K = randInt(6, 24); break;
      case SPIRAL: {
        const bases = [90, 120, 144, 60, 72];
        const base = bases[randInt(0, 4)];
        let off = randInt(1, 3);
        if (rand() < 0.5) off = -off;
        angle = base + off; N = randInt(80, 160); break;
      }
      case KOCH: angle = 60; maxDepth = randInt(3, 4); break;
      case HILBERT: angle = 90; maxDepth = randInt(4, 5); break;
      case DRAGON: angle = 90; maxDepth = randInt(9, 11); break;
      case SIERPINSKI: angle = 60; maxDepth = randInt(5, 6); break;
      case PLANT: angle = 25; jitter = randInt(0, 10); maxDepth = 4; head = 90; break;
      case WALK: N = randInt(150, 350); x = walkW / 2; y = walkH / 2; head = rand() * 360; break;
    }
    if (algo >= KOCH && algo <= PLANT) lstack.push({ s: AXIOM[algo], pos: 0, depth: 0 });

    // ---- Evolutionsstrategie (1+1) nach Rechenberg, 1/5-Erfolgsregel
    let es = null;
    function esFit(x, y) {
      let f = 0;
      for (let k = 0; k < es.n; k++) { const dx = x - es.hx[k], dy = y - es.hy[k]; f += es.hh[k] / (1 + (dx * dx + dy * dy) / es.hw2[k]); }
      return f;
    }
    const esGauss = () => (rand() + rand() + rand() + rand() - 2.0) * 1.7320508075688772;
    function esStartRun() {
      es.px = rand() * walkW; es.py = rand() * walkH; es.sigma = 0.04 + 0.06 * rand();
      es.pf = esFit(es.px, es.py); es.gen = 0; es.acc = 0; es.win = 0; es.succ = 0; es.done = false;
    }
    function esNext() {
      for (;;) {
        if (es.done) { es.run++; if (es.run >= es.runs) return null; esStartRun(); return [es.px, es.py, false]; }
        es.gen++;
        let cx = es.px + es.sigma * esGauss();
        let cy = es.py + es.sigma * esGauss();
        if (cx < 0) cx = 0; if (cx > walkW) cx = walkW; if (cy < 0) cy = 0; if (cy > walkH) cy = walkH;
        const cf = esFit(cx, cy), better = cf > es.pf;
        if (better) { es.px = cx; es.py = cy; es.pf = cf; es.acc++; es.succ++; }
        es.win++;
        if (es.win === 10) { if (es.succ > 2) es.sigma /= 0.85; else if (es.succ < 2) es.sigma *= 0.85; es.win = 0; es.succ = 0; }
        if (es.sigma < 0.004 || es.gen >= 600 || es.acc >= 150) es.done = true;
        if (better) return [es.px, es.py, true];
      }
    }
    if (algo === EVOLUTION) {
      es = { n: randInt(4, 9), hx: [], hy: [], hh: [], hw2: [] };
      for (let k = 0; k < es.n; k++) {
        es.hx.push(rand() * walkW); es.hy.push(rand() * walkH); es.hh.push(0.5 + rand());
        const w = 0.08 + 0.25 * rand(); es.hw2.push(w * w);
      }
      es.runs = randInt(14, 26); es.run = 0; esStartRun(); x = es.px; y = es.py;
    }

    // ---- Ameisenalgorithmus (Ant System, elitaer) fuer eine Rundreise
    let aco = null;
    if (algo === ANTS) {
      const n = randInt(18, 32), X = [], Y = [];
      for (let i = 0; i < n; i++) { X.push(rand() * walkW); Y.push(rand() * walkH); }
      const D = [], T = [], E = [];
      for (let i = 0; i < n; i++) {
        D.push([]); T.push([]); E.push([]);
        for (let j = 0; j < n; j++) {
          const dx = X[i] - X[j], dy = Y[i] - Y[j]; let d = Math.sqrt(dx * dx + dy * dy); if (d < 1e-6) d = 1e-6;
          D[i].push(d); E[i].push(1.0 / (d * d)); T[i].push(1.0);
        }
      }
      const tourLen = t => { let L = 0; for (let i = 0; i < n; i++) L += D[t[i]][t[(i + 1) % n]]; return L; };
      let bestLen = 1e30, best = null; const snaps = [], snapLen = [];
      const ITERS = 40, RHO = 0.1;
      for (let it = 0; it < ITERS; it++) {
        const tours = [];
        for (let a = 0; a < n; a++) {
          const vis = new Array(n).fill(false), t = [a]; vis[a] = true; let cur = a;
          const w = new Array(n);
          for (let k = 1; k < n; k++) {
            let sum = 0, last = -1;
            for (let j = 0; j < n; j++) { w[j] = vis[j] ? 0.0 : T[cur][j] * E[cur][j]; sum += w[j]; if (!vis[j]) last = j; }
            const r = rand() * sum; let acc = 0, next = last;
            for (let j = 0; j < n; j++) { if (vis[j]) continue; acc += w[j]; if (r < acc) { next = j; break; } }
            t.push(next); vis[next] = true; cur = next;
          }
          tours.push(t);
          const L = tourLen(t); if (L < bestLen) { bestLen = L; best = t.slice(); }
        }
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) T[i][j] *= (1.0 - RHO);
        for (let a = 0; a <= n; a++) {
          const t = a < n ? tours[a] : best, dep = 1.0 / tourLen(t);
          for (let i = 0; i < n; i++) { const u = t[i], v = t[(i + 1) % n]; T[u][v] += dep; T[v][u] += dep; }
        }
        if (it === 0 || it === Math.floor(ITERS / 3) || it === ITERS - 1) {
          if (snaps.length === 0 || bestLen < snapLen[snapLen.length - 1] - 1e-12) { snaps.push(best.slice()); snapLen.push(bestLen); }
        }
      }
      const HX = [0.5, -0.5, -1.0, -0.5, 0.5, 1.0];
      const HY = [0.8660254037844386, 0.8660254037844386, 0.0, -0.8660254037844386, -0.8660254037844386, 0.0];
      const R = 0.016, pts = [[X[0], Y[0], false]];
      snaps.forEach((t, si) => {
        const start = t.indexOf(0), loops = si === snaps.length - 1;
        for (let k = 1; k <= n; k++) {
          const c = t[(start + k) % n]; pts.push([X[c], Y[c], true]);
          if (loops) for (let j = 0; j < 6; j++) pts.push([X[c] - R + R * HX[j], Y[c] + R * HY[j], true]);
        }
      });
      aco = { pts, i: 1, n, bestLen, snaps: snaps.length };
      x = X[0]; y = Y[0];
    }

    function lNext() {
      while (lstack.length) {
        const f = lstack[lstack.length - 1];
        if (f.pos >= f.s.length) { lstack.pop(); continue; }
        const c = f.s[f.pos];
        const rule = f.depth < maxDepth ? RULES[algo][c] : undefined;
        if (rule) { f.pos++; if (lstack.length < 16) lstack.push({ s: rule, pos: 0, depth: f.depth + 1 }); continue; }
        if (isDraw(c)) { x += Math.cos(head * DEG); y += Math.sin(head * DEG); pending = true; f.pos++; continue; }
        if (c === "+" || c === "-" || c === "[" || c === "]") {
          if (pending) { pending = false; return [x, y, true]; }
          f.pos++;
          if (c === "+") head += turnAngle();
          else if (c === "-") head -= turnAngle();
          else if (c === "[") { if (tstack.length < 32) tstack.push([x, y, head]); }
          else if (tstack.length) { [x, y, head] = tstack.pop(); return [x, y, false]; }
          continue;
        }
        f.pos++;
      }
      if (pending) { pending = false; return [x, y, true]; }
      return null;
    }

    return function nextPoint() {
      if (!started) { started = true; return [x, y, false]; }
      switch (algo) {
        case ROSETTE: {
          if (I >= K) return null;
          const h = I * 360 / K + J * 360 / N;
          x += Math.cos(h * DEG); y += Math.sin(h * DEG);
          J++; if (J >= N) { J = 0; I++; }
          return [x, y, true];
        }
        case SPIRAL: {
          if (I >= N) return null;
          I++;
          const h = (I - 1) * angle;
          x += I * Math.cos(h * DEG); y += I * Math.sin(h * DEG);
          return [x, y, true];
        }
        case WALK: {
          if (I >= N) return null;
          I++;
          head += (rand() + rand() + rand() - 1.5) * 50;
          let len = 0.02 * Math.pow(1 - rand(), -0.8);
          if (len > 0.35) len = 0.35;
          let nx = x + len * Math.cos(head * DEG), ny = y + len * Math.sin(head * DEG);
          if (nx < 0) { nx = -nx; head = 180 - head; }
          if (nx > walkW) { nx = 2 * walkW - nx; head = 180 - head; }
          if (ny < 0) { ny = -ny; head = -head; }
          if (ny > walkH) { ny = 2 * walkH - ny; head = -head; }
          x = nx; y = ny;
          return [x, y, true];
        }
        case EVOLUTION: return esNext();
        case ANTS: { if (aco.i >= aco.pts.length) return null; return aco.pts[aco.i++]; }
        default: return lNext();
      }
    };
  }

  const normDeg = d => { while (d > 180) d -= 360; while (d <= -180) d += 360; return d; };

  // Entspricht artPlan(): einpassen, Punkte in Papier-mm, Laengen, Dauer.
  function plan(algo, seed, paperIdx, opts = {}) {
    const cfg = Object.assign({}, CFG, opts);
    const raw = [];
    const gen = makeGen(algo, seed);
    for (let p; (p = gen()); ) raw.push(p);
    let minX = 1e30, maxX = -1e30, minY = 1e30, maxY = -1e30;
    for (const [x, y] of raw) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const bw = maxX - minX, bh = maxY - minY;
    const paper = PAPERS[paperIdx];
    const availW = paper.w - 2 * cfg.margin, availH = paper.h - 2 * cfg.margin;
    const rotate = ((bh > bw) !== (availH > availW)) && Math.abs(bh - bw) > 1e-9;
    const w = rotate ? bh : bw, h = rotate ? bw : bh;
    const cx0 = rotate ? -(minY + maxY) / 2 : (minX + maxX) / 2;
    const cy0 = rotate ? (minX + maxX) / 2 : (minY + maxY) / 2;
    const sx = w > 1e-9 ? availW / w : 1e30, sy = h > 1e-9 ? availH / h : 1e30;
    let scale = Math.min(sx, sy); if (scale > 1e29) scale = 1;
    const pts = raw.map(([x, y, pen]) => {
      if (rotate) { const t = x; x = -y; y = t; }
      return [(x - cx0) * scale, (y - cy0) * scale, pen];
    });

    const cmStep = Math.PI * (cfg.wheelMm / 10) / cfg.stepsPerRev;
    const moveSec = (d, p) => {
      const pr = cfg.profiles[p]; const v = pr.max * cmStep * 10, a = pr.acc * cmStep * 10;
      if (d <= 0) return 0; if (d < v * v / a) return 2 * Math.sqrt(d / a); return d / v + v / a;
    };
    const wheelPerDeg = DEG * cfg.trackMm / 2;
    let drawMm = 0, travelMm = 0, turnDeg = 0, sec = 0, lowerings = 0, lastPen = false;
    let cx = 0, cy = 0, ch = 0;
    const route = [];   // tatsaechlich gefahrene Strecken (kurze uebersprungen)
    const targets = cfg.returnHome ? pts.concat([[0, 0, false]]) : pts;
    for (const [px, py, pen] of targets) {
      const dx = px - cx, dy = py - cy, d = Math.hypot(dx, dy);
      if (d < cfg.minSeg) continue;
      const hd = Math.atan2(dy, dx) / DEG, turn = Math.abs(normDeg(hd - ch));
      turnDeg += turn;
      sec += moveSec(turn * wheelPerDeg, cfg.turnProfile) + moveSec(d, cfg.lineProfile);
      if (pen) drawMm += d; else travelMm += d;
      if (pen && !lastPen) lowerings++;
      lastPen = pen;
      route.push([cx, cy, px, py, pen]);
      cx = px; cy = py; ch = hd;
    }
    if (cfg.returnHome) { const t = Math.abs(normDeg(-ch)); turnDeg += t; sec += moveSec(t * wheelPerDeg, cfg.turnProfile); }
    sec += 2 * lowerings * cfg.penMoveSec;
    return { pts, route, paper, scale, rotate, drawMm, travelMm, turnDeg, sec,
             lifts: Math.max(0, lowerings - 1), pointCount: raw.length };
  }

  return { NAMES, PAPERS, CFG, makeGen, plan };
})();
if (typeof module !== "undefined") module.exports = ArtGen;
