#!/usr/bin/env node
// Renders the documentation diagrams to docs/assets/diagrams/*.svg.
//
// The diagrams are plain SVG (shapes and text, no foreignObject, no scripts) so they show
// on GitHub web and mobile, in dark and light mode, and anywhere else a README renders.
// Edit a layout below, then run: node scripts/render-diagrams.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "assets", "diagrams");

const C = {
  bg0: "#0b0f17", bg1: "#171d29", panel: "#121823", edge: "#2a313c",
  node: "#1c2330", nodeStroke: "#2f3846", text: "#e6edf3", muted: "#8b949e", faint: "#6e7681",
  line: "#56606d", accent: "#f5b041", accentText: "#1a1205",
};
const FONT = "Inter, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function doc(w, h, title, desc, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="t d">
  <title id="t">${esc(title)}</title>
  <desc id="d">${esc(desc)}</desc>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.bg0}"/><stop offset="1" stop-color="${C.bg1}"/></linearGradient>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="${C.line}"/></marker>
    <marker id="arrowA" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="${C.accent}"/></marker>
  </defs>
  <rect width="${w}" height="${h}" rx="20" fill="url(#bg)"/>
  <g font-family="${FONT}">
${body}
  </g>
</svg>
`;
}

/** Multi-line centred text; lines split on "\n". */
function text(x, y, label, { size = 15, weight = 400, fill = C.text, anchor = "middle", lh = 1.3 } = {}) {
  const lines = String(label).split("\n");
  const top = y - ((lines.length - 1) * size * lh) / 2;
  return lines
    .map((l, i) => `    <text x="${x}" y="${(top + i * size * lh + size * 0.36).toFixed(1)}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(l)}</text>`)
    .join("\n");
}

/** Node kinds: box (process), decision (amber left rule), pill (outcome), accent (amber outcome). */
function node(n) {
  const { x, y, w, h, kind = "box", label } = n;
  const left = x - w / 2, top = y - h / 2;
  if (kind === "pill" || kind === "accent") {
    const fill = kind === "accent" ? C.accent : C.node;
    const stroke = kind === "accent" ? C.accent : C.nodeStroke;
    return `    <rect x="${left}" y="${top}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}" stroke="${stroke}"/>\n` +
      text(x, y, label, { size: 15, weight: 600, fill: kind === "accent" ? C.accentText : C.text });
  }
  const out = [`    <rect x="${left}" y="${top}" width="${w}" height="${h}" rx="12" fill="${C.node}" stroke="${C.nodeStroke}"/>`];
  if (kind === "decision") out.push(`    <rect x="${left}" y="${top + 10}" width="4" height="${h - 20}" rx="2" fill="${C.accent}"/>`);
  out.push(text(x, y, label, { size: 15 }));
  return out.join("\n");
}

/** Edge from point to point through optional waypoints, with an optional label at a point. */
function edge(points, { label, at, accent = false, dashed = false, labelAnchor = "middle" } = {}) {
  const d = points.map(([px, py], i) => `${i ? "L" : "M"}${px} ${py}`).join(" ");
  const stroke = accent ? C.accent : C.line;
  let s = `    <path d="${d}" fill="none" stroke="${stroke}" stroke-width="2" ${dashed ? 'stroke-dasharray="6 5" ' : ""}stroke-linejoin="round" marker-end="url(#${accent ? "arrowA" : "arrow"})"/>`;
  if (label) {
    const [lx, ly] = at ?? points[0];
    s += `\n    <text x="${lx}" y="${ly}" font-size="13" font-weight="600" fill="${C.muted}" text-anchor="${labelAnchor}">${esc(label)}</text>`;
  }
  return s;
}

const heading = (x, y, s) => `    <text x="${x}" y="${y}" font-size="13" font-weight="600" fill="${C.muted}" letter-spacing="1.6">${esc(s.toUpperCase())}</text>`;

// Edge endpoints on a node's sides.
const side = (n, s) => ({ l: [n.x - n.w / 2, n.y], r: [n.x + n.w / 2, n.y], t: [n.x, n.y - n.h / 2], b: [n.x, n.y + n.h / 2] })[s];

// ---------------------------------------------------------------------------
// 1. README: how a message is routed (snake layout: checks left→right, routing right→left).

function routing() {
  const W = 1280, H = 640;
  const R1 = 210, R2 = 450, bw = 230, bh = 74;
  const n = {
    send: { x: 150, y: R1, w: bw, h: bh, kind: "pill", label: "You send a message" },
    on: { x: 450, y: R1, w: bw, h: bh, kind: "decision", label: "Gearshift on\nfor this thread?" },
    steer: { x: 750, y: R1, w: bw, h: bh, kind: "decision", label: "A steer, retry or\nsystem message?" },
    named: { x: 1050, y: R1, w: bw, h: bh, kind: "decision", label: "Names a model, or\npicked by hand?" },
    score: { x: 1050, y: R2, w: bw, h: bh, label: "Score 0–14 from local\nrules → tier" },
    gear: { x: 750, y: R2, w: bw, h: bh, label: "The tier's gear for this\nprovider: model · effort" },
    hold: { x: 450, y: R2, w: bw, h: bh, kind: "decision", label: "A downshift on a\nlong thread?" },
    same: { x: 150, y: R2, w: bw, h: bh, kind: "decision", label: "Already on\nthat gear?" },
    asIs1: { x: 450, y: 92, w: 150, h: 40, kind: "pill", label: "Sent as is" },
    asIs2: { x: 750, y: 92, w: 150, h: 40, kind: "pill", label: "Sent as is" },
    model: { x: 1050, y: 92, w: 210, h: 40, kind: "pill", label: "Runs on that model" },
    held: { x: 450, y: 572, w: 230, h: 40, kind: "pill", label: "Holds the current gear" },
    sent3: { x: 150, y: 330, w: 150, h: 40, kind: "pill", label: "Sent as is" },
    shift: { x: 150, y: 572, w: 230, h: 44, kind: "accent", label: "Shifts, then sends" },
  };
  const e = [
    edge([side(n.send, "r"), side(n.on, "l")]),
    edge([side(n.on, "r"), side(n.steer, "l")], { label: "yes", at: [600, R1 - 10] }),
    edge([side(n.steer, "r"), side(n.named, "l")], { label: "no", at: [900, R1 - 10] }),
    edge([side(n.on, "t"), side(n.asIs1, "b")], { label: "no", at: [462, 150], labelAnchor: "start" }),
    edge([side(n.steer, "t"), side(n.asIs2, "b")], { label: "yes", at: [762, 150], labelAnchor: "start" }),
    edge([side(n.named, "t"), side(n.model, "b")], { label: "yes", at: [1062, 150], labelAnchor: "start" }),
    edge([side(n.named, "b"), side(n.score, "t")], { label: "no", at: [1062, 335], labelAnchor: "start" }),
    edge([side(n.score, "l"), side(n.gear, "r")]),
    edge([side(n.gear, "l"), side(n.hold, "r")]),
    edge([side(n.hold, "l"), side(n.same, "r")], { label: "no", at: [300, R2 - 10] }),
    edge([side(n.hold, "b"), side(n.held, "t")], { label: "yes", at: [462, 518], labelAnchor: "start" }),
    edge([side(n.same, "t"), side(n.sent3, "b")], { label: "yes", at: [162, 388], labelAnchor: "start" }),
    edge([side(n.same, "b"), side(n.shift, "t")], { label: "no", at: [162, 518], labelAnchor: "start", accent: true }),
  ];
  const body = [heading(48, 44, "How Gearshift routes a message"), ...e, ...Object.values(n).map(node),
    `    <text x="1232" y="612" font-size="12" fill="${C.faint}" text-anchor="end">A shift takes about a tenth of a second. Errors and timeouts send the message as is.</text>`].join("\n");
  return doc(W, H, "How Gearshift routes a message",
    "You send a message. If Gearshift is off for the thread, it is sent as is. A steer, retry or system message is sent as is. A message that names a model, or whose model was picked by hand, runs on that model. Otherwise Gearshift scores the text from 0 to 14 with local rules, picks the tier's gear for the provider, holds the current gear if this would be a downshift on a long thread, sends as is if already on that gear, and otherwise shifts, then sends.",
    body);
}

// 2. Routing policy: message → model pipeline.

function pipeline() {
  const W = 1280, H = 250, y = 140, w = 178, h = 84, gap = 32;
  const labels = ["Message text", "Signals\nchange · research ·\nlarge build · risk …", "Score\n0–14", "Tier\ntrivial … xlarge", "Gear for the\nthread's provider", "Model · effort ·\nservice tier"];
  const x0 = (W - (labels.length * w + (labels.length - 1) * gap)) / 2 + w / 2;
  const nodes = labels.map((label, i) => ({ x: x0 + i * (w + gap), y, w, h, label, kind: i === labels.length - 1 ? "accent" : i === 0 ? "pill" : "box" }));
  const e = nodes.slice(1).map((nd, i) => edge([side(nodes[i], "r"), side(nd, "l")]));
  const body = [heading(48, 52, "From message to model"), ...e, ...nodes.map((nd) => nd.kind === "accent"
    ? `    <rect x="${nd.x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="14" fill="${C.accent}"/>\n` + text(nd.x, y, nd.label, { weight: 600, fill: C.accentText })
    : node(nd.kind === "pill" ? { ...nd, kind: "box" } : nd))].join("\n");
  return doc(W, H, "From message to model", "Message text is turned into signals, the signals into a score from 0 to 14, the score into a tier, and the tier into a gear for the thread's provider: a model, an effort and a service tier.", body);
}

// 3. How it works: architecture.

function architecture() {
  const W = 1280, H = 640;
  const group = (x, y, w, h, title) => `    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="${C.panel}" stroke="${C.edge}"/>\n${heading(x + 20, y + 30, title)}`;
  const box = (x, y, w, h, label) => node({ x: x + w / 2, y: y + h / 2, w, h, label });
  const foot = (x, y, s) => `    <text x="${x}" y="${y}" font-size="13" fill="${C.faint}" text-anchor="middle">${esc(s)}</text>`;
  const lbl = (x, y, s) => `    <text x="${x}" y="${y}" font-size="13" font-weight="600" fill="${C.muted}" text-anchor="middle">${esc(s)}</text>`;
  const parts = [
    group(40, 60, 320, 520, "App · in the bb UI"),
    box(60, 110, 280, 64, "Composer pill + popup"),
    box(60, 190, 280, 64, "New-thread banner"),
    box(60, 270, 280, 64, "Routing policy editor\n(Settings)"),
    box(60, 350, 280, 64, "Analytics page\n(sidebar)"),
    foot(200, 556, "app.tsx · components/ · hooks/"),
    group(480, 60, 320, 520, "Server · in the bb server"),
    box(500, 110, 280, 64, "message.dispatch hook"),
    box(500, 190, 280, 64, "Events: message.queued,\nthread.idle, thread.deleted"),
    box(500, 270, 280, 64, "RPC handlers"),
    box(500, 350, 280, 64, "bb gearshift CLI\n+ agent skill"),
    `    <rect x="500" y="452" width="280" height="64" rx="12" fill="${C.node}" stroke="${C.nodeStroke}" stroke-dasharray="5 4"/>`,
    text(640, 484, "Plugin SQLite (store.ts)\ndecisions · prefs · links", { size: 14 }),
    foot(640, 556, "server.ts"),
    group(920, 60, 320, 330, "Pure logic · lib/"),
    box(940, 106, 280, 46, "classify.ts · score, tier"),
    box(940, 160, 280, 46, "policy.ts · defaults, merge"),
    box(940, 214, 280, 46, "gears.ts · model, effort"),
    box(940, 268, 280, 46, "router.ts · decision rules"),
    box(940, 322, 280, 46, "analytics.ts · pricing.ts"),
    `    <rect x="920" y="430" width="320" height="150" rx="16" fill="${C.node}" stroke="${C.accent}"/>`,
    text(1080, 488, "bb server", { weight: 600, size: 16 }),
    text(1080, 522, "threads · queue · providers", { size: 13, fill: C.muted }),
    edge([[362, 290], [478, 290]]),
    edge([[478, 318], [362, 318]]),
    lbl(420, 276, "RPC"),
    lbl(420, 344, "realtime"),
    edge([[802, 225], [918, 225]]),
    lbl(860, 211, "calls"),
    edge([[802, 490], [918, 490]], { accent: true }),
    edge([[918, 518], [802, 518]], { accent: true }),
    lbl(860, 474, "hold · amend"),
    lbl(860, 544, "events"),
  ];
  return doc(W, H, "Gearshift architecture", "The app (composer pill and popup, new-thread banner, routing policy editor, analytics page) talks to the server over RPC and a realtime channel. The server (dispatch hook, event listeners, RPC handlers, CLI and skill) calls pure modules in lib/ (classify, policy, gears, router, analytics, pricing), keeps decisions in its own SQLite database, and holds and amends messages on the bb server, which sends it events back.", parts.join("\n"));
}

// 4. How it works: shifting a message (sequence).

function sequence() {
  const actors = [["You", 120], ["bb server", 420], ["Gearshift", 760], ["Provider", 1120]];
  const steps = [
    [0, 1, "send “port the billing service into a plugin”"],
    [1, 2, "message.dispatch (requested: Sonnet · high)"],
    [2, 2, "score 9 → large → Opus · high"],
    [2, 1, "wait (“Shifting to Opus 5.5 · high”)", "ret"],
    [1, 1, "store the message as a queued row"],
    [1, 2, "message.queued (row id)", "async"],
    [2, 1, "queuedMessages.update(row, Opus · high)"],
    [2, 1, "recheck(\"message.dispatch\")"],
    [1, 2, "message.dispatch (re-attempt of the row)"],
    [2, 1, "proceed (already decided)", "ret"],
    [1, 3, "start the turn on Opus 5.5 · high", "accent"],
  ];
  const top = 92, step = 46, W = 1280, H = top + 40 + steps.length * step + 40;
  const parts = [heading(48, 44, "Shifting a message")];
  for (const [name, x] of actors) {
    parts.push(`    <line x1="${x}" y1="${top + 22}" x2="${x}" y2="${H - 30}" stroke="${C.edge}" stroke-width="2" stroke-dasharray="4 6"/>`);
    parts.push(`    <rect x="${x - 80}" y="${top - 22}" width="160" height="44" rx="12" fill="${x === 760 ? C.accent : C.node}" stroke="${x === 760 ? C.accent : C.nodeStroke}"/>`);
    parts.push(text(x, top, name, { weight: 600, fill: x === 760 ? C.accentText : C.text }));
  }
  steps.forEach(([from, to, label, kind], i) => {
    const y = top + 62 + i * step;
    const fx = actors[from][1], tx = actors[to][1];
    parts.push(`    <text x="${(fx + tx) / 2 + (from === to ? 24 : 0)}" y="${y - 8}" font-size="13.5" fill="${C.text}" text-anchor="${from === to ? "start" : "middle"}"><tspan fill="${C.faint}">${i + 1}  </tspan>${esc(label)}</text>`);
    if (from === to) {
      parts.push(`    <path d="M${fx} ${y} h18 v14 h-14" fill="none" stroke="${C.line}" stroke-width="2" marker-end="url(#arrow)"/>`);
    } else {
      const dir = tx > fx ? 1 : -1;
      parts.push(edge([[fx + dir * 4, y], [tx - dir * 6, y]], { dashed: kind === "ret" || kind === "async", accent: kind === "accent" }));
    }
  });
  return doc(W, H, "Shifting a message",
    "You send a message. bb asks Gearshift's dispatch hook, which scores it as large and picks Opus at high effort, so it answers wait. bb stores the message as a queued row and announces it. Gearshift links the row to its decision, sets the row's model and effort, and asks bb to recheck. bb re-asks the hook, Gearshift answers proceed, and bb starts the turn on Opus.",
    parts.join("\n"));
}

// 5. How it works: analytics.

function analytics() {
  const W = 1280, H = 300, bw = 210, bh = 80;
  const n = {
    d: { x: 150, y: 150, w: bw, h: bh, label: "Decision recorded\n(dispatch hook)" },
    i: { x: 410, y: 150, w: bw, h: bh, label: "Thread goes idle" },
    u: { x: 680, y: 150, w: 230, h: bh, label: "Finished turn's\ntoken usage" },
    c: { x: 955, y: 95, w: 210, h: 70, label: "Cost at list prices\n(routed model)" },
    t: { x: 955, y: 205, w: 210, h: 70, label: "Same usage on\nthe top gear" },
    o: { x: 1160, y: 150, w: 150, h: bh, label: "Analytics\npage" },
  };
  const e = [
    edge([side(n.d, "r"), side(n.i, "l")]),
    edge([side(n.i, "r"), side(n.u, "l")]),
    edge([side(n.u, "r"), [822, 150], [822, 95], side(n.c, "l")]),
    edge([side(n.u, "r"), [822, 150], [822, 205], side(n.t, "l")]),
    edge([side(n.c, "r"), [1072, 95], [1072, 150], side(n.o, "l")]),
    edge([side(n.t, "r"), [1072, 205], [1072, 150], side(n.o, "l")]),
  ];
  const body = [heading(48, 44, "Analytics"), ...e, ...Object.values(n).map((nd) => node(nd === n.o ? { ...nd } : nd))].join("\n");
  return doc(W, H, "Analytics pipeline", "Each routing decision is recorded by the dispatch hook. When the thread goes idle, Gearshift reads the finished turn's token usage, prices it at list prices for the routed model and for the provider's top gear, and shows both on the analytics page.", body);
}

mkdirSync(OUT, { recursive: true });
const files = { "routing.svg": routing(), "pipeline.svg": pipeline(), "architecture.svg": architecture(), "sequence.svg": sequence(), "analytics.svg": analytics() };
for (const [name, svg] of Object.entries(files)) {
  writeFileSync(join(OUT, name), svg);
  console.log(`wrote docs/assets/diagrams/${name}`);
}
