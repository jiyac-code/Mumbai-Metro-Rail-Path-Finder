"use strict";

/* ============================================================
   Front end only. All station data and the shortest-path search
   live in main.cpp; this file asks it (through server.js) for the
   network and for routes, then draws what comes back.
   ============================================================ */

const SVG_NS = "http://www.w3.org/2000/svg";
const $ = id => document.getElementById(id);

const svg = $("map");
const wrap = document.querySelector(".mapwrap");
const tooltip = $("tooltip");
const statusBox = $("status");

const startInput = $("start");
const destInput = $("dest");

let net = null;               // {lines, stations, routes, links}
const stationById = {};
const lineById = {};
const labelToId = new Map(); // lower-case label -> station id
const linkedStations = new Set();

let size = { w: 800, h: 600 };
let view = { k: 1, tx: 0, ty: 0 };
let fitK = 1;
const off = new Set();       // lines switched off by the user

let route = null;            // last successful /api/route answer
let traceStep = 0;
let playTimer = null;
let pickedStart = "";
let pickedDest = "";

// layers (created once, in drawing order)
let gTiles, gLines, gLinks, gTrace, gRoute, gStations, gLabels, gMarkers;
const tileEls = new Map();   // "z/x/y" -> <image>
let showTiles = false;
const routeEls = [];         // {line, ids, casing, stroke}
const linkEls = [];          // {a, b, el}
const stationEls = {};       // id -> {dot, hit}
const labelEls = {};         // id -> text element

/* ---------- small helpers ---------- */

function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
}

function sv(tag, attrs, parent) {
    const e = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
}

function showStatus(text) {
    statusBox.textContent = text || "";
    statusBox.hidden = !text;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const label = id => stationById[id] ? stationById[id].label : id;

/* ---------- projection: lat/lon -> kilometres, then to screen ---------- */

const KM_PER_DEG_LAT = 110.57;
let KM_PER_DEG_LON = 105; // set from the data
let minLat = 0, maxLat = 0, minLon = 0;

function prepareProjection() {
    minLat = Infinity; maxLat = -Infinity; minLon = Infinity;
    net.stations.forEach(s => {
        minLat = Math.min(minLat, s.lat);
        maxLat = Math.max(maxLat, s.lat);
        minLon = Math.min(minLon, s.lon);
    });
    KM_PER_DEG_LON = 111.32 * Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
    net.stations.forEach(s => {
        s.X = (s.lon - minLon) * KM_PER_DEG_LON;
        s.Y = (maxLat - s.lat) * KM_PER_DEG_LAT;
    });
}

const sx = s => view.tx + s.X * view.k;
const sy = s => view.ty + s.Y * view.k;

function fitTo(ids, pad = 60) {
    const pts = ids.map(id => stationById[id]).filter(Boolean);
    if (!pts.length) return;
    const xs = pts.map(p => p.X), ys = pts.map(p => p.Y);
    const bw = Math.max(0.5, Math.max(...xs) - Math.min(...xs));
    const bh = Math.max(0.5, Math.max(...ys) - Math.min(...ys));
    const k = clamp(Math.min((size.w - 2 * pad) / bw, (size.h - 2 * pad) / bh), fitK * 0.5, 450);
    view.k = k;
    view.tx = size.w / 2 - ((Math.min(...xs) + Math.max(...xs)) / 2) * k;
    view.ty = size.h / 2 - ((Math.min(...ys) + Math.max(...ys)) / 2) * k;
    render();
}

function fitAll() {
    const ids = net.stations.map(s => s.id);
    const xs = net.stations.map(s => s.X), ys = net.stations.map(s => s.Y);
    const bw = Math.max(...xs) - Math.min(...xs);
    const bh = Math.max(...ys) - Math.min(...ys);
    fitK = Math.min((size.w - 80) / bw, (size.h - 80) / bh);
    fitTo(ids, 40);
}

function zoomAt(factor, cx, cy) {
    const k = clamp(view.k * factor, fitK * 0.6, 450);
    const real = k / view.k;
    view.tx = cx - (cx - view.tx) * real;
    view.ty = cy - (cy - view.ty) * real;
    view.k = k;
    render();
}

/* ---------- building the static SVG ---------- */

function buildMap() {
    svg.replaceChildren();
    sv("rect", { width: "100%", height: "100%", fill: "transparent", "data-bg": "1" }, svg);

    gTiles = sv("g", { style: "opacity:0.7" }, svg);
    tileEls.clear();
    gLines = sv("g", {}, svg);
    gLinks = sv("g", {}, svg);
    gTrace = sv("g", {}, svg);
    gRoute = sv("g", {}, svg);
    gStations = sv("g", {}, svg);
    gLabels = sv("g", {}, svg);
    gMarkers = sv("g", {}, svg);

    // Rail underneath, metro on top.
    const ordered = [...net.routes].sort((a, b) =>
        (lineById[a.line].type === "metro") - (lineById[b.line].type === "metro"));

    ordered.forEach(r => {
        const line = lineById[r.line];
        const casing = sv("polyline", { fill: "none", stroke: "var(--casing)", "stroke-linecap": "round", "stroke-linejoin": "round" }, gLines);
        const stroke = sv("polyline", { fill: "none", stroke: line.color, "stroke-linecap": "round", "stroke-linejoin": "round" }, gLines);
        routeEls.push({ line, ids: r.stations, casing, stroke });
    });

    net.links.forEach(l => {
        const e = sv("line", { stroke: "#475569", "stroke-dasharray": "3 3", "stroke-width": 1.6 }, gLinks);
        linkEls.push({ a: l.a, b: l.b, el: e });
        linkedStations.add(l.a);
        linkedStations.add(l.b);
    });

    net.stations.forEach(s => {
        const dot = sv("circle", { fill: "#fff", "stroke-width": 2 }, gStations);
        const hit = sv("circle", { fill: "transparent", r: 9, "data-id": s.id, style: "cursor:pointer" }, gStations);
        hit.addEventListener("mouseenter", ev => showTooltip(s, ev));
        hit.addEventListener("mousemove", ev => moveTooltip(ev));
        hit.addEventListener("mouseleave", () => { tooltip.hidden = true; });
        stationEls[s.id] = { dot, hit };

        const t = sv("text", { class: "lbl" }, gLabels);
        t.textContent = s.label;
        t.style.display = "none";
        labelEls[s.id] = t;
    });
}

/* ---------- rendering ---------- */

function isInterchange(s) {
    return s.lines.length > 1 || linkedStations.has(s.id);
}

function isTerminal(s) {
    return net.routes.some(r => r.stations[0] === s.id || r.stations[r.stations.length - 1] === s.id);
}

function routeStationSet() {
    return new Set(route ? route.path.map(p => p.station) : []);
}

/* Optional OpenStreetMap basemap (needs internet in the browser). The equirectangular
   projection used for the transit layer is within a fraction of a percent of Web Mercator
   over this small area, so tiles are simply placed by converting their corners. */
function updateTiles() {
    if (!showTiles) {
        if (tileEls.size) { gTiles.replaceChildren(); tileEls.clear(); }
        return;
    }
    const rad = Math.PI / 180;
    const midLat = (minLat + maxLat) / 2;
    const z = clamp(Math.ceil(Math.log2(40075.017 * Math.cos(midLat * rad) * view.k / 512)), 8, 17);
    const n = 2 ** z;

    const lonAt = px => minLon + ((px - view.tx) / view.k) / KM_PER_DEG_LON;
    const latAt = py => maxLat - ((py - view.ty) / view.k) / KM_PER_DEG_LAT;
    const tileX = lon => (lon + 180) / 360 * n;
    const tileY = lat => (1 - Math.log(Math.tan(lat * rad) + 1 / Math.cos(lat * rad)) / Math.PI) / 2 * n;
    const tileLon = x => x / n * 360 - 180;
    const tileLat = y => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) / rad;
    const px = lon => view.tx + (lon - minLon) * KM_PER_DEG_LON * view.k;
    const py = lat => view.ty + (maxLat - lat) * KM_PER_DEG_LAT * view.k;

    const x0 = Math.floor(tileX(lonAt(0))), x1 = Math.floor(tileX(lonAt(size.w)));
    const y0 = Math.floor(tileY(latAt(0))), y1 = Math.floor(tileY(latAt(size.h)));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 90) return;

    const needed = new Set();
    for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
            const key = `${z}/${x}/${y}`;
            needed.add(key);
            let img = tileEls.get(key);
            if (!img) {
                img = sv("image", { href: `https://tile.openstreetmap.org/${key}.png`, preserveAspectRatio: "none" }, gTiles);
                tileEls.set(key, img);
            }
            const left = px(tileLon(x)), top = py(tileLat(y));
            img.setAttribute("x", left.toFixed(1));
            img.setAttribute("y", top.toFixed(1));
            img.setAttribute("width", (px(tileLon(x + 1)) - left + 0.6).toFixed(1));
            img.setAttribute("height", (py(tileLat(y + 1)) - top + 0.6).toFixed(1));
        }
    }
    for (const [key, img] of tileEls) {
        if (!needed.has(key)) { img.remove(); tileEls.delete(key); }
    }
}

function render() {
    if (!net) return;
    updateTiles();
    const mult = clamp(0.55 + 0.45 * Math.sqrt(view.k / fitK), 0.75, 2);
    const onRoute = routeStationSet();
    const dim = Boolean(route);

    // lines
    routeEls.forEach(r => {
        const pts = r.ids.map(id => `${sx(stationById[id]).toFixed(1)},${sy(stationById[id]).toFixed(1)}`).join(" ");
        const w = (r.line.type === "metro" ? 4.5 : 2.6) * mult;
        const isOff = off.has(r.line.id);
        r.casing.setAttribute("points", pts);
        r.stroke.setAttribute("points", pts);
        r.casing.setAttribute("stroke-width", (w + 2.5).toFixed(1));
        r.stroke.setAttribute("stroke-width", w.toFixed(1));
        r.stroke.setAttribute("stroke-dasharray", isOff ? "2 6" : "");
        const o = isOff ? 0.35 : dim ? 0.22 : 1;
        r.casing.setAttribute("opacity", isOff ? 0.2 : dim ? 0.3 : 1);
        r.stroke.setAttribute("opacity", o);
    });

    // walking links
    linkEls.forEach(l => {
        const a = stationById[l.a], b = stationById[l.b];
        l.el.setAttribute("x1", sx(a)); l.el.setAttribute("y1", sy(a));
        l.el.setAttribute("x2", sx(b)); l.el.setAttribute("y2", sy(b));
        l.el.setAttribute("opacity", dim ? 0.3 : 0.9);
    });

    // stations
    net.stations.forEach(s => {
        const e = stationEls[s.id];
        const x = sx(s), y = sy(s);
        const big = isInterchange(s);
        const r = (big ? 5.2 : s.type === "metro" ? 3.6 : 2.9) * mult;
        const lineCol = lineById[s.lines[0]].color;
        const allOff = s.lines.every(l => off.has(l));
        e.dot.setAttribute("cx", x); e.dot.setAttribute("cy", y); e.dot.setAttribute("r", r.toFixed(1));
        e.dot.setAttribute("stroke", big ? "#111827" : lineCol);
        e.dot.setAttribute("fill", "#fff");
        e.dot.setAttribute("opacity", allOff ? 0.3 : dim && !onRoute.has(s.id) ? 0.3 : 1);
        e.hit.setAttribute("cx", x); e.hit.setAttribute("cy", y);
    });

    placeLabels(onRoute);
    drawTrace(mult);
    drawRoute(mult);
    drawMarkers();
}

function placeLabels(onRoute) {
    const placed = [];
    const score = s => {
        let v = 0;
        if (s.id === pickedStart || s.id === pickedDest) v += 100;
        if (onRoute.has(s.id)) v += 80;
        if (isInterchange(s)) v += 40;
        if (isTerminal(s)) v += 30;
        if (s.type === "metro") v += 5;
        return v;
    };
    const order = [...net.stations].sort((a, b) => score(b) - score(a));
    const overlaps = (r) => placed.some(p => r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y);

    order.forEach(s => {
        const t = labelEls[s.id];
        const x = sx(s), y = sy(s);
        const w = s.label.length * 5.9 + 6, h = 14;
        t.style.display = "none";
        if (x < -20 || y < -20 || x > size.w + 20 || y > size.h + 20) return;
        // When a route is shown, only label the route (plus the picked ends).
        if (route && !onRoute.has(s.id)) return;

        const candidates = [
            { x: x + 8, y: y - 7, anchor: "start" },
            { x: x - 8 - w, y: y - 7, anchor: "start" },
            { x: x + 8, y: y + 8, anchor: "start" },
            { x: x - 8 - w, y: y + 8, anchor: "start" }
        ];
        for (const c of candidates) {
            const rect = { x: c.x, y: c.y, w, h };
            if (!overlaps(rect)) {
                placed.push(rect);
                t.setAttribute("x", c.x);
                t.setAttribute("y", c.y + 11);
                t.style.display = "";
                break;
            }
        }
    });
}

function pointsFor(ids) {
    return ids.map(id => `${sx(stationById[id]).toFixed(1)},${sy(stationById[id]).toFixed(1)}`).join(" ");
}

function drawRoute(mult) {
    gRoute.replaceChildren();
    if (!route) return;

    route.legs.forEach(leg => {
        if (leg.type === "ride") {
            const col = lineById[leg.line].color;
            sv("polyline", { points: pointsFor(leg.stations), fill: "none", stroke: "var(--casing)", "stroke-width": 11 * mult, "stroke-linecap": "round", "stroke-linejoin": "round" }, gRoute);
            sv("polyline", { points: pointsFor(leg.stations), fill: "none", stroke: col, "stroke-width": 7 * mult, "stroke-linecap": "round", "stroke-linejoin": "round" }, gRoute);
        } else if (leg.from !== leg.to) {
            sv("polyline", { points: pointsFor([leg.from, leg.to]), fill: "none", stroke: "#111827", "stroke-width": 3.2, "stroke-dasharray": "5 4" }, gRoute);
        }
    });

    // route station dots on top
    new Set(route.path.map(p => p.station)).forEach(id => {
        const s = stationById[id];
        sv("circle", { cx: sx(s), cy: sy(s), r: 4.2 * mult, fill: "#fff", stroke: "#111827", "stroke-width": 2 }, gRoute);
    });
}

function drawMarkers() {
    gMarkers.replaceChildren();
    const pin = (id, text, color) => {
        const s = stationById[id];
        if (!s) return;
        sv("circle", { cx: sx(s), cy: sy(s), r: 12, fill: color, stroke: "#fff", "stroke-width": 2.5 }, gMarkers);
        const t = sv("text", { x: sx(s), y: sy(s), class: "pinText" }, gMarkers);
        t.textContent = text;
    };
    pin(pickedStart, "A", "#16a34a");
    pin(pickedDest, "B", "#dc2626");
}

/* Search animation: stations coloured by the cost at which Dijkstra settled them. */
function heat(t) {
    return `hsl(270 70% ${85 - 50 * clamp(t, 0, 1)}%)`;
}

function drawTrace(mult) {
    gTrace.replaceChildren();
    if (!route || traceStep <= 0) return;

    const maxC = route.trace[route.trace.length - 1].c || 1;
    const seen = new Set();
    for (let i = 0; i < traceStep; i++) {
        const t = route.trace[i];
        if (seen.has(t.s)) continue;
        seen.add(t.s);
        const s = stationById[t.s];
        sv("circle", { cx: sx(s), cy: sy(s), r: 9 * mult, fill: heat(t.c / maxC), opacity: 0.9 }, gTrace);
    }
    const cur = route.trace[traceStep - 1];
    const cs = stationById[cur.s];
    sv("circle", { cx: sx(cs), cy: sy(cs), r: 13 * mult, fill: "none", stroke: "#111827", "stroke-width": 2 }, gTrace);
}

/* ---------- tooltip ---------- */

function showTooltip(s, ev) {
    tooltip.replaceChildren();
    tooltip.appendChild(el("strong", "", s.label));
    s.lines.forEach(id => tooltip.appendChild(el("div", "", lineById[id].name)));
    if (linkedStations.has(s.id)) tooltip.appendChild(el("div", "", "Walking interchange nearby"));
    tooltip.hidden = false;
    moveTooltip(ev);
}

function moveTooltip(ev) {
    const box = wrap.getBoundingClientRect();
    tooltip.style.left = clamp(ev.clientX - box.left + 14, 4, box.width - 250) + "px";
    tooltip.style.top = clamp(ev.clientY - box.top + 14, 4, box.height - 100) + "px";
}

/* ---------- pan / zoom ---------- */

const pointers = new Map();
let dragMoved = 0;
let lastPinch = 0;

svg.addEventListener("pointerdown", ev => {
    svg.setPointerCapture(ev.pointerId);
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    dragMoved = 0;
    lastPinch = 0;
    svg.classList.add("dragging");
});

svg.addEventListener("pointermove", ev => {
    const prev = pointers.get(ev.pointerId);
    if (!prev) return;
    const cur = { x: ev.clientX, y: ev.clientY };

    if (pointers.size === 1) {
        view.tx += cur.x - prev.x;
        view.ty += cur.y - prev.y;
        dragMoved += Math.abs(cur.x - prev.x) + Math.abs(cur.y - prev.y);
        pointers.set(ev.pointerId, cur);
        render();
    } else if (pointers.size === 2) {
        pointers.set(ev.pointerId, cur);
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (lastPinch) {
            const box = svg.getBoundingClientRect();
            zoomAt(dist / lastPinch, (a.x + b.x) / 2 - box.left, (a.y + b.y) / 2 - box.top);
        }
        lastPinch = dist;
        dragMoved += 10;
    }
});

function endPointer(ev) {
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) lastPinch = 0;
    if (pointers.size === 0) svg.classList.remove("dragging");
}

svg.addEventListener("pointerup", ev => {
    const wasClick = dragMoved < 5;
    endPointer(ev);
    if (wasClick) {
        const hit = document.elementFromPoint(ev.clientX, ev.clientY);
        const id = hit && hit.getAttribute && hit.getAttribute("data-id");
        if (id) pickFromMap(id);
    }
});
svg.addEventListener("pointercancel", endPointer);

svg.addEventListener("wheel", ev => {
    ev.preventDefault();
    const box = svg.getBoundingClientRect();
    zoomAt(ev.deltaY < 0 ? 1.18 : 1 / 1.18, ev.clientX - box.left, ev.clientY - box.top);
}, { passive: false });

$("zoomIn").addEventListener("click", () => zoomAt(1.4, size.w / 2, size.h / 2));
$("zoomOut").addEventListener("click", () => zoomAt(1 / 1.4, size.w / 2, size.h / 2));
$("fit").addEventListener("click", () => {
    if (route) fitTo(route.path.map(p => p.station));
    else fitAll();
});

new ResizeObserver(() => {
    const box = wrap.getBoundingClientRect();
    size = { w: Math.max(200, box.width), h: Math.max(200, box.height) };
    if (!net) return;
    // Re-centre after a resize (rotating a phone, resizing the window).
    if (route) { fitAll(); fitTo(route.path.map(p => p.station), 90); }
    else fitAll();
}).observe(wrap);

/* ---------- planner ---------- */

function resolveStation(text) {
    const q = text.trim().toLowerCase();
    if (!q) return "";
    if (labelToId.has(q)) return labelToId.get(q);
    const hits = [...labelToId.entries()].filter(([k]) => k.startsWith(q) || k.includes(q));
    return hits.length === 1 ? hits[0][1] : "";
}

function setStart(id) {
    pickedStart = id;
    startInput.value = id ? label(id) : "";
}

function setDest(id) {
    pickedDest = id;
    destInput.value = id ? label(id) : "";
}

function pickFromMap(id) {
    if (!pickedStart || (pickedStart && pickedDest)) {
        setStart(id);
        setDest("");
        clearRoute();
        render();
    } else {
        setDest(id);
        findRoute();
    }
}

function clearRoute() {
    stopPlay();
    route = null;
    traceStep = 0;
    $("resultCard").hidden = true;
    $("traceCard").hidden = true;
}

function linesOffParam() {
    return [...off].join(",");
}

async function findRoute() {
    const s = resolveStation(startInput.value);
    const d = resolveStation(destInput.value);

    if (!s || !d) {
        showStatus("Pick two stations from the list.");
        return;
    }
    setStart(s);
    setDest(d);

    if (s === d) {
        clearRoute();
        render();
        showStatus("You are already there.");
        return;
    }

    const params = new URLSearchParams({ start: s, dest: d });
    if (off.size) params.set("off", linesOffParam());

    showStatus("Searching…");
    try {
        const response = await fetch(`/api/route?${params}`);
        const data = await response.json();
        if (!data.found) {
            clearRoute();
            render();
            showStatus(data.error || "No route found.");
            return;
        }
        showStatus("");
        route = data;
        traceStep = 0; // the search overlay stays hidden until the user presses Play
        renderResult();
        setupTrace();
        fitTo(data.path.map(p => p.station), 90);
    } catch (err) {
        clearRoute();
        render();
        showStatus("Could not reach the C++ program. Is server.js running?");
    }
}

function renderResult() {
    const box = $("result");
    box.replaceChildren();

    const summary = el("div", "summary", `${route.minutes} min `);
    summary.appendChild(el("span", "", `· ${route.stops} stops · ${route.transfers} change${route.transfers === 1 ? "" : "s"}`));
    box.appendChild(summary);

    route.legs.forEach(leg => {
        if (leg.type === "ride") {
            const line = lineById[leg.line];
            const row = el("div", "leg");
            const badge = el("span", "badge", leg.line);
            badge.style.background = line.color;
            row.appendChild(badge);
            const first = leg.stations[0], last = leg.stations[leg.stations.length - 1];
            row.appendChild(el("span", "", `${label(first)} → ${label(last)} (${leg.stations.length - 1} stops)`));
            row.appendChild(el("span", "mins", `${leg.minutes} min`));
            box.appendChild(row);
        } else {
            const same = leg.from === leg.to;
            const text = same
                ? `Change platforms at ${label(leg.from)}`
                : `Walk ${label(leg.from)} → ${label(leg.to)}`;
            const row = el("div", "leg walk");
            row.appendChild(el("span", "", text));
            row.appendChild(el("span", "mins", `${leg.minutes} min`));
            box.appendChild(row);
        }
    });

    $("resultCard").hidden = false;
}

/* ---------- search animation ---------- */

function setupTrace() {
    const scrub = $("scrub");
    scrub.max = route.trace.length;
    scrub.value = traceStep;
    $("traceCard").hidden = false;
    updateTraceInfo();
}

function updateTraceInfo() {
    const info = $("traceInfo");
    info.replaceChildren();
    if (!route) return;
    const total = route.trace.length;
    if (traceStep <= 0) {
        info.textContent = `Step 0 of ${total}`;
    } else {
        const t = route.trace[traceStep - 1];
        const cost = `${Math.round(t.c / 60)} min`;
        info.textContent = `Step ${traceStep} of ${total}: settled ${label(t.s)} at ${cost}`;
    }
    const bar = el("div", "legend-bar");
    const labels = el("div", "legend-labels");
    labels.appendChild(el("span", "", "start"));
    labels.appendChild(el("span", "", "destination"));
    info.appendChild(bar);
    info.appendChild(labels);
}

function stopPlay() {
    if (playTimer) clearInterval(playTimer);
    playTimer = null;
    $("play").textContent = "▶ Play";
}

$("play").addEventListener("click", () => {
    if (!route) return;
    if (playTimer) { stopPlay(); return; }

    if (traceStep >= route.trace.length) traceStep = 0;
    const delay = clamp(6000 / route.trace.length, 20, 120);
    $("play").textContent = "❚❚ Pause";
    playTimer = setInterval(() => {
        traceStep++;
        $("scrub").value = traceStep;
        updateTraceInfo();
        render();
        if (traceStep >= route.trace.length) stopPlay();
    }, delay);
});

$("scrub").addEventListener("input", ev => {
    stopPlay();
    traceStep = Number(ev.target.value);
    updateTraceInfo();
    render();
});

/* ---------- controls ---------- */

$("find").addEventListener("click", findRoute);
$("clear").addEventListener("click", () => {
    setStart(""); setDest("");
    clearRoute();
    showStatus("");
    fitAll();
});
$("swap").addEventListener("click", () => {
    const s = pickedStart, d = pickedDest;
    setStart(resolveStation(destInput.value) || d);
    setDest(resolveStation(startInput.value) || s);
    if (pickedStart && pickedDest) findRoute();
});
[startInput, destInput].forEach(i =>
    i.addEventListener("keydown", ev => { if (ev.key === "Enter") findRoute(); }));

$("tilesToggle").addEventListener("change", ev => {
    showTiles = ev.target.checked;
    $("attrib").hidden = !showTiles;
    render();
});

function buildLineToggles() {
    const box = $("lineToggles");
    box.replaceChildren();
    net.lines.forEach(line => {
        const row = el("label", "toggle");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = true;
        cb.addEventListener("change", () => {
            if (cb.checked) off.delete(line.id); else off.add(line.id);
            if (resolveStation(startInput.value) && resolveStation(destInput.value)) findRoute();
            else render();
        });
        const sw = el("span", "swatch");
        sw.style.background = line.color;
        row.appendChild(cb);
        row.appendChild(sw);
        row.appendChild(el("span", "", line.name));
        box.appendChild(row);
    });
}

/* ---------- start-up ---------- */

async function init() {
    showStatus("Loading network from the C++ program…");
    try {
        const response = await fetch("/api/network");
        net = await response.json();
        if (!net.stations) throw new Error(net.error || "Bad data");
    } catch (err) {
        showStatus("Could not reach the C++ program. Compile main.cpp and run server.js (see README).");
        return;
    }

    net.lines.forEach(l => { lineById[l.id] = l; });
    net.stations.forEach(s => {
        stationById[s.id] = s;
        labelToId.set(s.label.toLowerCase(), s.id);
    });

    const list = $("stationList");
    [...net.stations].sort((a, b) => a.label.localeCompare(b.label)).forEach(s => {
        const opt = document.createElement("option");
        opt.value = s.label;
        list.appendChild(opt);
    });

    prepareProjection();
    buildMap();
    buildLineToggles();
    showStatus("");
    const box = wrap.getBoundingClientRect();
    size = { w: Math.max(200, box.width), h: Math.max(200, box.height) };
    fitAll();
}

init();
