/* Live Doodle — deterministic drawing and motion engine. Original implementation. */
(function (global) {
  'use strict';
  const LD = global.LiveDoodle = global.LiveDoodle || {};
  const TAU = Math.PI * 2;
  const LOOP = 3;
  const cache = new WeakMap();
  const textureCache = new WeakMap();
  const textureLRU = new Map();
  const TEXTURE_PIXEL_BUDGET = 8 * 1024 * 1024;
  let texturePixels = 0;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const finite = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;
  const mod = (a, b) => ((a % b) + b) % b;
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const lerp = (a, b, t) => a + (b - a) * t;
  function random(seed, index) {
    let n = (seed | 0) ^ Math.imul(index + 1, 0x9e3779b1);
    n = Math.imul(n ^ (n >>> 16), 0x21f0aaad);
    n = Math.imul(n ^ (n >>> 15), 0x735a2d97);
    return ((n ^ (n >>> 15)) >>> 0) / 4294967296;
  }
  function blendPoint(a, b, t) {
    return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), p: lerp(a.p, b.p, t) };
  }
  function noise(seed, u, frame) {
    const i = Math.floor(u), f = u - i, k = f * f * (3 - 2 * f);
    return lerp(random(seed + frame * 613, i), random(seed + frame * 613, i + 1), k) * 2 - 1;
  }
  function settings(stroke) {
    const width = clamp(finite(stroke.width, 8), 1, 160);
    return {
      width,
      color: typeof stroke.color === 'string' ? stroke.color : '#4268d2',
      opacity: clamp(finite(stroke.opacity, 1), 0, 1),
      intensity: clamp(finite(stroke.intensity, 0.5), 0, 1),
      speed: clamp(Math.round(finite(stroke.speed, 1)), 1, 3),
      phase: mod(finite(stroke.phase, 0), 1),
      seed: finite(stroke.seed, 1) | 0,
      material: ['crayon', 'pencil', 'marker'].includes(stroke.material) ? stroke.material : 'crayon',
      texture: clamp(finite(stroke.texture, 0.65), 0, 1),
      offset: { x: finite(stroke.offset && stroke.offset.x, 0), y: finite(stroke.offset && stroke.offset.y, 0) },
      brush: ['ink', 'boil', 'wiggle', 'flow', 'star', 'bubble'].includes(stroke.brush) ? stroke.brush : 'ink'
    };
  }
  function prepareStroke(stroke) {
    if (!stroke || typeof stroke !== 'object') return { points: [], length: 0, closed: false };
    const raw = Array.isArray(stroke.points) ? stroke.points : [];
    const last = raw[raw.length - 1] || {};
    const key = [raw.length, last.x, last.y, last.p, last.t].join('|');
    const known = cache.get(stroke);
    if (known && known.raw === raw && known.key === key) return known.geometry;
    const clean = [];
    for (const point of raw) {
      if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) continue;
      const p = { x: Number(point.x), y: Number(point.y), p: clamp(finite(point.p, 0.5), 0, 1) };
      if (!clean.length || distance(clean[clean.length - 1], p) > 0.3) clean.push(p);
      else clean[clean.length - 1].p = p.p;
    }
    let smooth = clean;
    if (clean.length > 2) {
      smooth = [clean[0]];
      for (let i = 0; i < clean.length - 1; i++) {
        smooth.push(blendPoint(clean[i], clean[i + 1], 0.25));
        smooth.push(blendPoint(clean[i], clean[i + 1], 0.75));
      }
      smooth.push(clean[clean.length - 1]);
    }
    const points = [];
    if (smooth.length) points.push({ ...smooth[0], s: 0 });
    let total = 0, next = 3.2;
    for (let i = 1; i < smooth.length; i++) {
      const a = smooth[i - 1], b = smooth[i], span = distance(a, b);
      if (span < 0.0001) continue;
      while (next < total + span && points.length < 18000) {
        points.push({ ...blendPoint(a, b, (next - total) / span), s: next });
        next += 3.2;
      }
      total += span;
    }
    if (smooth.length > 1 && (points.length === 1 || distance(points[points.length - 1], smooth[smooth.length - 1]) > 0.01)) {
      points.push({ ...smooth[smooth.length - 1], s: total });
    }
    const closed = points.length > 8 && total > 40 && distance(points[0], points[points.length - 1]) < 9;
    for (let i = 0; i < points.length; i++) {
      const before = points[Math.max(0, i - 1)], after = points[Math.min(points.length - 1, i + 1)];
      let dx = after.x - before.x, dy = after.y - before.y;
      if (closed && (i === 0 || i === points.length - 1)) {
        dx = points[1].x - points[points.length - 2].x;
        dy = points[1].y - points[points.length - 2].y;
      }
      const length = Math.hypot(dx, dy) || 1;
      points[i].nx = -dy / length;
      points[i].ny = dx / length;
    }
    const geometry = { points, length: total, closed };
    cache.set(stroke, { raw, key, geometry });
    return geometry;
  }
  function atLength(geometry, s) {
    const points = geometry.points;
    if (!points.length) return { x: 0, y: 0, p: 0.5, nx: 0, ny: 1, s: 0 };
    if (points.length === 1 || s <= 0) return points[0];
    if (s >= geometry.length) return points[points.length - 1];
    let lo = 0, hi = points.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (points[mid].s < s) lo = mid; else hi = mid;
    }
    const a = points[lo], b = points[hi], t = (s - a.s) / (b.s - a.s || 1);
    return { ...blendPoint(a, b, t), nx: lerp(a.nx, b.nx, t), ny: lerp(a.ny, b.ny, t), s };
  }
  function trace(ctx, points, close) {
    if (!points.length) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 1; i++) {
      const midX = (points[i].x + points[i + 1].x) / 2;
      const midY = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
    }
    if (points.length > 1) ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    if (close) ctx.closePath();
  }
  function disk(ctx, x, y, r) {
    ctx.beginPath(); ctx.arc(x, y, Math.max(0.1, r), 0, TAU); ctx.fill();
  }
  function ribbon(ctx, points, width) {
    if (!points.length) return;
    if (points.length < 2) { disk(ctx, points[0].x, points[0].y, width * (0.34 + 0.32 * points[0].p)); return; }
    const left = [], right = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)], p = points[i];
      const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
      const r = width * (0.34 + 0.32 * p.p);
      left.push({ x: p.x - dy / l * r, y: p.y + dx / l * r });
      right.push({ x: p.x + dy / l * r, y: p.y - dx / l * r });
    }
    trace(ctx, left.concat(right.reverse()), true); ctx.fill();
    const start = points[0], end = points[points.length - 1];
    disk(ctx, start.x, start.y, width * (0.34 + 0.32 * start.p));
    disk(ctx, end.x, end.y, width * (0.34 + 0.32 * end.p));
  }
  function motionPoints(geometry, cfg, time) {
    const phase = mod(time, LOOP) / LOOP * cfg.speed + cfg.phase;
    if (cfg.brush === 'ink' || cfg.intensity === 0) return geometry.points;
    const frame = Math.floor(mod(time, LOOP) * 12 * cfg.speed + cfg.phase * 3 + 0.00000001) % 3;
    const phase1 = random(cfg.seed, 1) * TAU, phase2 = random(cfg.seed, 2) * TAU;
    return geometry.points.map(p => {
      const u = geometry.length ? p.s / geometry.length : 0;
      let amount = 0, tx = 0, ty = 0;
      if (cfg.brush === 'boil') {
        const n = geometry.closed
          ? 0.65 * Math.sin(TAU * u * 3 + random(cfg.seed + frame * 613, 21) * TAU) + 0.35 * Math.sin(TAU * u * 7 + random(cfg.seed + frame * 613, 22) * TAU)
          : noise(cfg.seed, p.s / 24, frame);
        const m = geometry.closed
          ? 0.65 * Math.sin(TAU * u * 4 + random(cfg.seed + frame * 613, 23) * TAU) + 0.35 * Math.sin(TAU * u * 6 + random(cfg.seed + frame * 613, 24) * TAU)
          : noise(cfg.seed + 991, p.s / 31, frame);
        tx = n * cfg.intensity * (1.5 + Math.min(cfg.width, 30) * 0.22);
        ty = m * cfg.intensity * (1.5 + Math.min(cfg.width, 30) * 0.22);
      } else if (cfg.brush === 'wiggle') {
        const envelope = geometry.closed ? 1 : 0.2 + 0.8 * Math.sin(Math.PI * u) ** 2;
        amount = cfg.intensity * (3 + Math.min(cfg.width, 45) * 0.45) * envelope *
          (0.72 * Math.sin(TAU * (phase + u * 2) + phase1) + 0.28 * Math.sin(TAU * (2 * phase - u * 3) + phase2));
      }
      return { ...p, x: p.x + p.nx * amount + tx, y: p.y + p.ny * amount + ty };
    });
  }
  function glowLine(ctx, geometry, cfg, time) {
    const points = geometry.points;
    ctx.fillStyle = cfg.color;
    ctx.globalAlpha = cfg.opacity * (0.43 + cfg.texture * 0.24);
    ctx.shadowColor = cfg.color;
    ctx.shadowBlur = cfg.width * (0.5 + cfg.intensity * 1.1) * (1 - cfg.texture * 0.78);
    ribbon(ctx, points, cfg.width);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = cfg.opacity * 0.32;
    ribbon(ctx, points, Math.max(1, cfg.width * 0.28));
    if (points.length < 2) {
      const breath = 0.7 + cfg.intensity * 0.3 * Math.sin(TAU * (mod(time, LOOP) / LOOP * cfg.speed + cfg.phase));
      ctx.globalAlpha = cfg.opacity * breath;
      ctx.shadowBlur = cfg.width * 1.8;
      disk(ctx, points[0].x, points[0].y, cfg.width * 0.62);
      return;
    }
    const head = mod(mod(time, LOOP) / LOOP * cfg.speed + cfg.phase, 1);
    const edge = geometry.closed ? 1 : Math.sin(Math.PI * head) ** 2;
    const spread = 0.06 + cfg.intensity * 0.09;
    ctx.strokeStyle = cfg.color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const stride = Math.max(1, Math.floor(points.length / 110));
    for (let i = 0; i < points.length - 1; i += stride) {
      const a = points[i], b = points[Math.min(points.length - 1, i + stride)];
      const u = (a.s + b.s) / (2 * geometry.length);
      let delta = Math.abs(u - head);
      if (geometry.closed) delta = Math.min(delta, 1 - delta);
      const brightness = Math.exp(-((delta / spread) ** 2)) * edge * cfg.intensity;
      if (brightness < 0.015) continue;
      ctx.globalAlpha = cfg.opacity * brightness;
      ctx.shadowBlur = cfg.width * (1.3 + cfg.intensity * 1.8) * (1 - cfg.texture * 0.76);
      ctx.lineWidth = cfg.width * (0.8 + 0.2 * a.p);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.shadowBlur = 0;
  }
  function starShape(ctx, x, y, radius, rotation, texture, seed) {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const angle = rotation + i * Math.PI / 4;
      const r = (i % 2 === 0 ? radius : radius * 0.22) * (1 + (texture || 0) * (random(seed || 1, i + 72) - 0.5) * 0.22);
      const px = x + Math.cos(angle) * r, py = y + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath(); ctx.fill();
  }
  function stampPositions(geometry, spacing) {
    if (geometry.length < spacing * 0.7) return [atLength(geometry, geometry.length / 2)];
    const count = Math.min(300, Math.max(2, Math.floor(geometry.length / spacing) + 1));
    return Array.from({ length: count }, (_, i) => atLength(geometry, geometry.length * i / (geometry.closed ? count : count - 1)));
  }
  function stamps(ctx, geometry, cfg, time) {
    const phase = mod(time, LOOP) / LOOP * cfg.speed + cfg.phase;
    const isStar = cfg.brush === 'star';
    const positions = stampPositions(geometry, Math.max(18, cfg.width * (isStar ? 2.6 : 3.1)));
    positions.forEach((p, index) => {
      const seedPhase = random(cfg.seed, index * 5 + 13), theta = TAU * (phase + seedPhase);
      const size = cfg.width * (0.65 + random(cfg.seed, index * 5 + 3) * 0.65);
      if (isStar) {
        const pulse = 0.5 + 0.5 * Math.sin(theta);
        ctx.globalAlpha = cfg.opacity * (1 - cfg.intensity * 0.63 + cfg.intensity * pulse * 0.63);
        ctx.fillStyle = cfg.color; ctx.shadowColor = cfg.color;
        ctx.shadowBlur = size * cfg.intensity * (0.25 + pulse * 0.6);
        starShape(ctx, p.x, p.y, size * (0.8 + cfg.intensity * pulse * 0.3), random(cfg.seed, index + 451) * 0.35, cfg.texture, cfg.seed + index * 211);
      } else {
        const sway = cfg.intensity * Math.min(18, cfg.width * 0.65);
        const x = p.x + Math.sin(theta) * sway;
        const y = p.y + Math.cos(theta + 0.7) * sway;
        const radius = size * (0.82 + cfg.intensity * 0.12 * Math.sin(theta + 1));
        ctx.shadowColor = cfg.color; ctx.shadowBlur = radius * 0.35;
        ctx.fillStyle = cfg.color; ctx.globalAlpha = cfg.opacity * 0.07;
        disk(ctx, x, y, radius);
        ctx.shadowBlur = 0;
        ctx.globalAlpha = cfg.opacity * (0.76 + cfg.intensity * 0.14 * Math.sin(theta));
        ctx.strokeStyle = cfg.color; ctx.lineWidth = Math.max(1.25, cfg.width * (0.105 + cfg.texture * 0.035));
        if (cfg.texture > 0) roughRing(ctx, x, y, radius, cfg.seed + index * 127, cfg.texture);
        else { ctx.beginPath(); ctx.arc(x, y, radius, 0, TAU); }
        ctx.stroke();
        ctx.globalAlpha = cfg.opacity * 0.85;
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(1.4, cfg.width * 0.10);
        ctx.beginPath(); ctx.arc(x - radius * 0.03, y - radius * 0.03, radius * 0.79, Math.PI * 1.08, Math.PI * 1.50); ctx.stroke();
        ctx.fillStyle = '#ffffff';
        disk(ctx, x - radius * 0.27, y - radius * 0.42, Math.max(1, radius * 0.10));
      }
    });
    ctx.shadowBlur = 0;
  }
  function roughRing(ctx, x, y, radius, seed, strength) {
    const points = [];
    const phase = random(seed, 32) * TAU;
    for (let i = 0; i <= 48; i++) {
      const a = TAU * i / 48;
      const r = radius * (1 + strength * (0.025 * Math.sin(a * 3 + phase) + 0.018 * Math.sin(a * 7 - phase)));
      points.push({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r });
    }
    trace(ctx, points, true);
  }
  function createTextureSurface(width, height) {
    if (typeof global.OffscreenCanvas === 'function') return new global.OffscreenCanvas(width, height);
    if (global.document && typeof global.document.createElement === 'function') {
      const surface = global.document.createElement('canvas');
      surface.width = width; surface.height = height;
      return surface;
    }
    return null;
  }
  function discardSurface(cell) {
    if (!textureLRU.has(cell)) return;
    texturePixels -= cell.pixels;
    textureLRU.delete(cell);
    cell.owner.frames.delete(cell.frame);
    if (!cell.owner.frames.size) cell.owner.grains = null;
    // Clear the backing store so deleted strokes cannot retain unbounded raster memory.
    cell.surface.width = 1; cell.surface.height = 1;
  }
  function touchSurface(cell) {
    textureLRU.delete(cell); textureLRU.set(cell, true);
  }
  function limitTextureMemory() {
    while (texturePixels > TEXTURE_PIXEL_BUDGET && textureLRU.size > 1) discardSurface(textureLRU.keys().next().value);
  }
  // V03: solid pigment, independent ragged outlines. No interior grain or hatching.
  function edgeNoise(seed, s, wavelength, loopLength) {
    if (!loopLength) return noise(seed, s / wavelength, 0);
    const cells = Math.max(3, Math.round(loopLength / wavelength));
    const u = s / loopLength * cells, i = Math.floor(u), f = u - i;
    const blend = f * f * (3 - 2 * f);
    return lerp(random(seed, mod(i, cells)), random(seed, mod(i + 1, cells)), blend) * 2 - 1;
  }
  function edgeFactor(cfg, geometry, s, side) {
    const seed = cfg.seed + side * 1879;
    const length = geometry.closed ? geometry.length : 0;
    const coarse = edgeNoise(seed, s, Math.max(2.8, cfg.width * 0.28), length);
    const fine = edgeNoise(seed + 819, s, Math.max(1.1, cfg.width * 0.075), length);
    const delta = cfg.material === 'pencil' ? 0.11 * coarse + 0.065 * fine
      : cfg.material === 'marker' ? 0.16 * coarse + 0.035 * fine : 0.21 * coarse + 0.035 * fine;
    return 1 + cfg.texture * clamp(delta, -0.16, 0.25);
  }
  function roughGeometry(geometry, cfg, time) {
    return { ...geometry, points: cfg.brush === 'boil' || cfg.brush === 'wiggle'
      ? motionPoints(geometry, cfg, time) : geometry.points };
  }
  function polygonFill(ctx, vertices) {
    if (!vertices.length) return;
    ctx.beginPath(); ctx.moveTo(vertices[0].x, vertices[0].y);
    for (let i = 1; i < vertices.length; i++) ctx.lineTo(vertices[i].x, vertices[i].y);
    ctx.closePath(); ctx.fill();
  }
  function edgeRibbon(ctx, geometry, cfg) {
    const points = geometry.points;
    if (!points.length) return;
    if (points.length === 1) {
      const point = points[0], r = cfg.width * (0.34 + 0.32 * point.p), perimeter = TAU * r;
      const dotGeometry = { closed: true, length: perimeter };
      const vertices = [], count = Math.max(18, Math.ceil(perimeter / 1.3));
      for (let i = 0; i < count; i++) {
        const a = TAU * i / count, rr = r * edgeFactor(cfg, dotGeometry, perimeter * i / count, 3);
        vertices.push({ x: point.x + Math.cos(a) * rr, y: point.y + Math.sin(a) * rr });
      }
      polygonFill(ctx, vertices); return;
    }
    const step = cfg.material === 'pencil' ? 1.0 : 1.6;
    const count = Math.min(9000, Math.max(2, Math.ceil(geometry.length / step)));
    const left = [], right = [];
    for (let i = 0; i <= count; i++) {
      const p = atLength(geometry, geometry.length * i / count), r = cfg.width * (0.34 + 0.32 * p.p);
      const l = r * edgeFactor(cfg, geometry, p.s, 1), rr = r * edgeFactor(cfg, geometry, p.s, 2);
      left.push({ x: p.x + p.nx * l, y: p.y + p.ny * l });
      right.push({ x: p.x - p.nx * rr, y: p.y - p.ny * rr });
    }
    if (geometry.closed) { polygonFill(ctx, left.concat(right.reverse())); return; }
    const vertices = left.slice();
    function cap(point, start, fromFactor, toFactor) {
      const r = cfg.width * (0.34 + 0.32 * point.p), n = Math.max(8, Math.ceil(Math.PI * r / 1.4));
      const normalAngle = Math.atan2(point.ny, point.nx), base = start ? normalAngle - Math.PI : normalAngle;
      for (let j = 1; j < n; j++) {
        const u = j / n, angle = base - Math.PI * u;
        const natural = edgeFactor(cfg, { closed: false }, (start ? 371 : 83) + r * Math.PI * u, start ? 4 : 5);
        const edge = lerp(fromFactor, toFactor, u);
        const factor = lerp(edge, natural, Math.sin(Math.PI * u));
        vertices.push({ x: point.x + Math.cos(angle) * r * factor, y: point.y + Math.sin(angle) * r * factor });
      }
    }
    const last = points[points.length - 1], first = points[0];
    cap(last, false, edgeFactor(cfg, geometry, geometry.length, 1), edgeFactor(cfg, geometry, geometry.length, 2));
    vertices.push(...right.slice().reverse());
    cap(first, true, edgeFactor(cfg, geometry, 0, 2), edgeFactor(cfg, geometry, 0, 1));
    polygonFill(ctx, vertices);
  }
  function starVertices(state, cfg, index, scale) {
    const vertices = [], seed = cfg.seed + index * 211;
    for (let i = 0; i < 8; i++) {
      const angle = state.angle + i * Math.PI / 4;
      const r = state.r * scale * (i % 2 === 0 ? 1 : 0.22) * (1 + cfg.texture * (random(seed, i + 72) - 0.5) * 0.12);
      vertices.push({ x: state.x + Math.cos(angle) * r, y: state.y + Math.sin(angle) * r });
    }
    return vertices;
  }
  function edgePolygon(ctx, vertices, cfg, seed) {
    const outline = []; let arc = 0;
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i], b = vertices[(i + 1) % vertices.length], length = distance(a, b);
      const nx = (b.y - a.y) / (length || 1), ny = -(b.x - a.x) / (length || 1);
      const count = Math.max(1, Math.ceil(length / 1.4));
      for (let j = 0; j < count; j++) {
        const t = j / count, fade = Math.sin(Math.PI * t);
        const offset = cfg.texture * Math.min(1.1, cfg.width * 0.045) * edgeNoise(seed, arc + t * length, 2.4, 0) * fade;
        outline.push({ x: lerp(a.x, b.x, t) + nx * offset, y: lerp(a.y, b.y, t) + ny * offset });
      }
      arc += length;
    }
    polygonFill(ctx, outline);
  }
  function stampStates(geometry, cfg, time) {
    const phase = mod(time, LOOP) / LOOP * cfg.speed + cfg.phase;
    const isStar = cfg.brush === 'star';
    return stampPositions(geometry, Math.max(18, cfg.width * (isStar ? 2.6 : 3.1))).map((p, i) => {
      const theta = TAU * (phase + random(cfg.seed, i * 5 + 13));
      const size = cfg.width * (0.65 + random(cfg.seed, i * 5 + 3) * 0.65);
      const pulse = 0.5 + 0.5 * Math.sin(theta), sway = cfg.intensity * Math.min(18, cfg.width * 0.65);
      return isStar
        ? { x: p.x, y: p.y, r: size * (0.8 + cfg.intensity * pulse * 0.3), angle: random(cfg.seed, i + 451) * 0.35 }
        : { x: p.x + Math.sin(theta) * sway, y: p.y + Math.cos(theta + 0.7) * sway,
          r: size * (0.82 + cfg.intensity * 0.12 * Math.sin(theta + 1)), angle: 0 };
    });
  }
  function makeGrains(geometry, cfg) {
    // Sparse edge-only defects: count follows perimeter, never filled stroke area.
    const stamp = cfg.brush === 'star' || cfg.brush === 'bubble';
    const positions = stamp ? stampPositions(geometry, Math.max(18, cfg.width * (cfg.brush === 'star' ? 2.6 : 3.1))) : null;
    const perimeter = stamp ? positions.length * cfg.width * 6 : 2 * geometry.length + TAU * cfg.width * 0.5;
    const density = cfg.material === 'marker' ? 0.10 : cfg.material === 'pencil' ? 0.055 : 0.033;
    const count = clamp(Math.round(perimeter * density * cfg.texture), 2, 340);
    const capChance = !stamp && !geometry.closed && geometry.points.length > 1
      ? Math.min(0.5, Math.PI * cfg.width / Math.max(1, perimeter)) : 0;
    return Array.from({ length: count }, (_, i) => {
      const r = j => random(cfg.seed + 419, i * 13 + j);
      const cap = r(0) < capChance ? (r(1) < 0.5 ? 'start' : 'end') : '';
      return { u: r(2), side: r(3) > 0.5 ? 1 : -1, angle: r(4) * TAU,
        radius: (0.22 + r(5) * 0.68) * (cfg.material === 'marker' ? 1.25 : cfg.material === 'pencil' ? 0.65 : 1),
        scatter: r(6) > (cfg.material === 'marker' ? 0.7 : 0.82), cap,
        stamp: positions ? Math.floor(r(7) * positions.length) : -1 };
    });
  }
  function ringGeometry(state) {
    const count = Math.max(32, Math.ceil(TAU * state.r / 2));
    const points = [];
    for (let j = 0; j <= count; j++) {
      const a = TAU * j / count;
      points.push({ x: state.x + Math.cos(a) * state.r, y: state.y + Math.sin(a) * state.r,
        nx: Math.cos(a), ny: Math.sin(a), p: 0.5, s: TAU * state.r * j / count });
    }
    return { points, length: TAU * state.r, closed: true };
  }
  function edgeGrainLocation(grain, geometry, cfg, states) {
    if (states) {
      const state = states[grain.stamp];
      if (cfg.brush === 'star') {
        const vertices = starVertices(state, cfg, grain.stamp, 1);
        const f = grain.u * vertices.length, index = Math.floor(f), t = f - index;
        const a = vertices[index], b = vertices[(index + 1) % vertices.length], l = distance(a, b) || 1;
        const outer = grain.scatter ? grain.radius * 1.6 : 0;
        return { x: lerp(a.x, b.x, t) + (b.y - a.y) / l * outer,
          y: lerp(a.y, b.y, t) - (b.x - a.x) / l * outer, radius: grain.radius * 0.75 };
      }
      const lineWidth = Math.max(1.8, cfg.width * 0.14), r = state.r + grain.side * lineWidth * 0.5;
      const outer = grain.scatter ? grain.radius * 1.2 : 0;
      return { x: state.x + Math.cos(grain.angle) * (r + grain.side * outer),
        y: state.y + Math.sin(grain.angle) * (r + grain.side * outer), radius: Math.min(grain.radius * 0.5, lineWidth * 0.13) };
    }
    const p = atLength(geometry, geometry.length * grain.u);
    const radius = cfg.width * (0.34 + 0.32 * p.p);
    const size = Math.min(grain.radius, radius * (cfg.material === 'marker' ? 0.10 : 0.07));
    const scatterOffset = grain.scatter ? size * 1.7 : size * 0.1;
    if (geometry.points.length === 1 || grain.cap) {
      const endpoint = grain.cap === 'start' ? geometry.points[0] : grain.cap === 'end' ? geometry.points[geometry.points.length - 1] : p;
      const normal = Math.atan2(endpoint.ny, endpoint.nx);
      const a = geometry.points.length === 1 ? grain.angle
        : normal - (grain.cap === 'start' ? Math.PI : 0) - (grain.angle / 2);
      const r = cfg.width * (0.34 + 0.32 * endpoint.p);
      const factor = edgeFactor(cfg, { closed: true, length: TAU * r }, grain.angle * r, 3);
      return { x: endpoint.x + Math.cos(a) * (r * factor + scatterOffset),
        y: endpoint.y + Math.sin(a) * (r * factor + scatterOffset), radius: size };
    }
    const factor = edgeFactor(cfg, geometry, p.s, grain.side > 0 ? 1 : 2);
    const offset = (radius * factor + scatterOffset) * grain.side;
    return { x: p.x + p.nx * offset, y: p.y + p.ny * offset, radius: size };
  }
  function paintMaterial(ctx, geometry, cfg, time, grains) {
    const rough = roughGeometry(geometry, cfg, time);
    const stamp = cfg.brush === 'star' || cfg.brush === 'bubble';
    const states = stamp ? stampStates(geometry, cfg, time) : null;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.fillStyle = cfg.color; ctx.strokeStyle = cfg.color;
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    if (cfg.brush === 'flow') {
      // Motion lives in the halo; the colored body remains saturated and opaque.
      glowLine(ctx, rough, { ...cfg, opacity: 1 }, time); ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    }
    if (!stamp) edgeRibbon(ctx, rough, cfg);
    else states.forEach((state, index) => {
      if (cfg.brush === 'star') edgePolygon(ctx, starVertices(state, cfg, index, 1), cfg, cfg.seed + index * 33);
      else edgeRibbon(ctx, ringGeometry(state), { ...cfg, width: Math.max(1.8, cfg.width * 0.14), seed: cfg.seed + index * 127 });
    });
    // Only a few tiny defects straddle the outer contour; no grain is distributed through the body.
    ctx.shadowBlur = 0; ctx.fillStyle = '#000000'; ctx.globalCompositeOperation = 'destination-out';
    for (const grain of grains) {
      if (grain.scatter) continue;
      const location = edgeGrainLocation(grain, rough, cfg, states);
      disk(ctx, location.x, location.y, location.radius);
    }
    ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = cfg.color;
    for (const grain of grains) {
      if (!grain.scatter) continue;
      const location = edgeGrainLocation(grain, rough, cfg, states);
      disk(ctx, location.x, location.y, location.radius * 0.75);
    }
    // Restore an opaque 82% core AFTER edge erosion. This protects body, crossings and caps.
    if (!stamp) ribbon(ctx, rough.points, cfg.width * 0.82);
    else states.forEach((state, index) => {
      if (cfg.brush === 'star') polygonFill(ctx, starVertices(state, cfg, index, 0.82));
      else ribbon(ctx, ringGeometry(state).points, Math.max(1.8, cfg.width * 0.14) * 0.82);
    });
    if (cfg.brush === 'flow' && cfg.intensity > 0 && geometry.length > 0) {
      // A small light travels on top of the solid edge-shaped body, without turning it translucent.
      const u = mod(mod(time, LOOP) / LOOP * cfg.speed + cfg.phase, 1);
      const edgeFade = geometry.closed ? 1 : Math.sin(Math.PI * u) ** 2;
      const point = atLength(rough, geometry.length * u);
      ctx.globalAlpha = 0.7 * cfg.intensity * edgeFade; ctx.fillStyle = '#ffffff';
      ctx.shadowColor = cfg.color; ctx.shadowBlur = cfg.width * 0.9;
      disk(ctx, point.x, point.y, Math.max(0.7, cfg.width * 0.17));
    }
    ctx.shadowBlur = 0; ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }
  function texturedStroke(ctx, stroke, geometry, cfg, time) {
    const matrix = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
    const requestedScale = matrix ? Math.max(1, Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d)) : 1;
    const box = strokeBounds(stroke);
    const x = Math.floor(box.x - cfg.offset.x - 2), y = Math.floor(box.y - cfg.offset.y - 2);
    const width = Math.max(1, Math.ceil(box.width + 4)), height = Math.max(1, Math.ceil(box.height + 4));
    // Bound any one image, including very large imported strokes; normal 960×720 work stays at full resolution.
    const scale = Math.max(0.00001, Math.min(2, requestedScale, 1536 / width, 1536 / height));
    const w = Math.max(1, Math.ceil(width * scale)), h = Math.max(1, Math.ceil(height * scale));
    const signature = [cfg.brush, cfg.color, cfg.width, cfg.material, cfg.texture, cfg.intensity, cfg.speed, cfg.phase, cfg.seed, w, h].join('|');
    let entry = textureCache.get(stroke);
    if (!entry || entry.geometry !== geometry || entry.signature !== signature) {
      if (entry) for (const cell of Array.from(entry.frames.values())) discardSurface(cell);
      entry = { geometry, signature, frames: new Map(), grains: null };
      textureCache.set(stroke, entry);
    }
    const staticStroke = cfg.brush === 'ink' || cfg.intensity === 0;
    const frame = staticStroke ? 'still' : cfg.brush === 'boil'
      ? 'boil-' + Math.floor(mod(time, LOOP) * 12 * cfg.speed + cfg.phase * 3 + 0.00000001) % 3 : 'motion';
    // Keep original timing for the three-frame brush; continuous materials use a 30Hz clock.
    const renderTime = staticStroke ? 0 : cfg.brush === 'boil' ? time : Math.floor((mod(time, LOOP) + 1e-9) * 30) / 30;
    let cell = entry.frames.get(frame);
    if (cell && (frame !== 'motion' || cell.time === renderTime)) {
      touchSurface(cell);
    } else {
      if (!cell) {
        const surface = createTextureSurface(w, h);
        if (!surface) return false;
        const layer = surface.getContext('2d');
        if (!layer) return false;
        cell = { surface, layer, pixels: w * h, owner: entry, frame, time: renderTime };
        entry.frames.set(frame, cell); texturePixels += cell.pixels; textureLRU.set(cell, true);
        limitTextureMemory();
      }
      const layer = cell.layer;
      layer.setTransform(1, 0, 0, 1, 0, 0); layer.clearRect(0, 0, w, h);
      layer.setTransform(scale, 0, 0, scale, -x * scale, -y * scale);
      layer.globalAlpha = 1; layer.globalCompositeOperation = 'source-over'; layer.shadowBlur = 0;
      if (!entry.grains) entry.grains = makeGrains(geometry, cfg);
      paintMaterial(layer, geometry, { ...cfg, opacity: 1 }, renderTime, entry.grains);
      cell.time = renderTime; touchSurface(cell);
    }
    ctx.save(); ctx.globalAlpha = cfg.opacity; ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur = 0; ctx.drawImage(cell.surface, x + cfg.offset.x, y + cfg.offset.y, w / scale, h / scale); ctx.restore();
    return true;
  }
  function drawStroke(ctx, stroke, time) {
    if (stroke && stroke.referenceArtwork !== undefined && typeof LD.drawReferenceStroke === 'function' && LD.drawReferenceStroke(ctx, stroke, time)) return;
    const geometry = prepareStroke(stroke);
    if (!geometry.points.length) return;
    const cfg = settings(stroke);
    if (cfg.texture > 0 && texturedStroke(ctx, stroke, geometry, cfg, time)) return;
    ctx.save();
    ctx.translate(cfg.offset.x, cfg.offset.y);
    ctx.globalAlpha = cfg.opacity;
    ctx.fillStyle = cfg.color; ctx.strokeStyle = cfg.color;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (cfg.brush === 'flow') glowLine(ctx, geometry, cfg, time);
    else if (cfg.brush === 'star' || cfg.brush === 'bubble') stamps(ctx, geometry, cfg, time);
    else ribbon(ctx, motionPoints(geometry, cfg, time), cfg.width);
    ctx.restore();
  }
  function strokeBounds(stroke) {
    if (stroke && stroke.referenceArtwork !== undefined && typeof LD.referenceStrokeBounds === 'function') {
      const bounds = LD.referenceStrokeBounds(stroke); if (bounds) return bounds;
    }
    const g = prepareStroke(stroke), cfg = settings(stroke || {});
    if (!g.points.length) return { x: 0, y: 0, width: 0, height: 0, minX: 0, minY: 0, maxX: 0, maxY: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of g.points) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    let margin = cfg.width * 0.7 + 2;
    if (cfg.brush === 'boil') margin += cfg.intensity * (1.5 + Math.min(cfg.width, 30) * 0.22);
    if (cfg.brush === 'wiggle') margin += cfg.intensity * (3 + Math.min(cfg.width, 45) * 0.45);
    if (cfg.brush === 'flow') margin = cfg.width * 4 + 4;
    if (cfg.brush === 'star') margin = cfg.width * 2.2 + 3;
    if (cfg.brush === 'bubble') margin = cfg.width * 1.4 + cfg.intensity * Math.min(18, cfg.width * 0.65) + 3;
    margin += cfg.texture * (2 + cfg.width * 0.15);
    minX += cfg.offset.x - margin; maxX += cfg.offset.x + margin;
    minY += cfg.offset.y - margin; maxY += cfg.offset.y + margin;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY, minX, minY, maxX, maxY };
  }
  function segmentDistance(x, y, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, q = dx * dx + dy * dy;
    const u = q ? clamp(((x - a.x) * dx + (y - a.y) * dy) / q, 0, 1) : 0;
    return Math.hypot(x - a.x - u * dx, y - a.y - u * dy);
  }
  function hitTest(doc, x, y, tolerance) {
    const entries = doc && Array.isArray(doc.layers) && LD.layers
      ? LD.layers.entries(doc, true)
      : (doc && Array.isArray(doc.strokes) ? doc.strokes : []).map(stroke => ({ stroke, matrix: { x: 0, y: 0, scale: 1 } }));
    const extra = Math.max(0, finite(tolerance, 12));
    for (let i = entries.length - 1; i >= 0; i--) {
      const { stroke, matrix } = entries[i];
      const localX = (x - matrix.x) / matrix.scale, localY = (y - matrix.y) / matrix.scale;
      const localExtra = extra / matrix.scale;
      if (stroke && stroke.referenceArtwork !== undefined && typeof LD.hitReferenceStroke === 'function') {
        if (LD.hitReferenceStroke(stroke, localX, localY, localExtra)) return stroke.id;
        continue;
      }
      const cfg = settings(stroke), geometry = prepareStroke(stroke);
      if (cfg.opacity === 0 || !geometry.points.length) continue;
      const px = localX - cfg.offset.x, py = localY - cfg.offset.y;
      let reach = cfg.width * 0.7 + localExtra;
      if (cfg.brush === 'wiggle') reach += cfg.intensity * (3 + Math.min(cfg.width, 45) * 0.45);
      if (cfg.brush === 'boil') reach += cfg.intensity * (1.5 + Math.min(cfg.width, 30) * 0.22) * 1.42;
      if (cfg.brush === 'star' || cfg.brush === 'bubble') {
        reach = cfg.width * (cfg.brush === 'star' ? 1.5 : 1.4) + localExtra;
        if (cfg.brush === 'bubble') reach += cfg.intensity * Math.min(18, cfg.width * 0.65);
        const centers = stampPositions(geometry, Math.max(18, cfg.width * (cfg.brush === 'star' ? 2.6 : 3.1)));
        if (centers.some(p => Math.hypot(px - p.x, py - p.y) <= reach)) return stroke.id;
      } else if (geometry.points.length === 1) {
        if (Math.hypot(px - geometry.points[0].x, py - geometry.points[0].y) <= reach) return stroke.id;
      } else {
        for (let j = 1; j < geometry.points.length; j++) {
          if (segmentDistance(px, py, geometry.points[j - 1], geometry.points[j]) <= reach) return stroke.id;
        }
      }
    }
    return null;
  }
  function drawScene(ctx, doc, time, options) {
    const opts = options || {}, width = finite(doc.width, 960), height = finite(doc.height, 720);
    const t = Number.isFinite(Number(time)) ? Number(time) : 0;
    ctx.save();
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; ctx.shadowColor = 'rgba(0,0,0,0)';
    if ('filter' in ctx) ctx.filter = 'none';
    ctx.setLineDash([]);
    ctx.clearRect(0, 0, width, height);
    if (!opts.transparent) {
      ctx.fillStyle = doc.background && doc.background.color || '#fffefa';
      ctx.fillRect(0, 0, width, height);
      if (typeof LD.paintReferencePaper === 'function') LD.paintReferencePaper(ctx, doc);
      const image = opts.backgroundImage;
      if (image && (image.naturalWidth || image.width) && (image.naturalHeight || image.height)) {
        const iw = image.naturalWidth || image.width, ih = image.naturalHeight || image.height;
        const fit = doc.background && doc.background.fit || 'contain';
        const scale = fit === 'cover' ? Math.max(width / iw, height / ih) : Math.min(width / iw, height / ih);
        const w = iw * scale, h = ih * scale;
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.clip();
        ctx.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
        ctx.restore();
      }
    }
    if (Array.isArray(doc.layers) && LD.layers) LD.layers.draw(ctx, doc, t, opts, drawStroke);
    else {
      for (const stroke of doc.strokes || []) drawStroke(ctx, stroke, t);
      if (opts.activeStroke) drawStroke(ctx, opts.activeStroke, t);
    }
    if (opts.selection && opts.selectedId != null) {
      const selected = (doc.strokes || []).find(s => s.id === opts.selectedId);
      if (selected && (!Array.isArray(doc.layers) || !LD.layers || LD.layers.isVisible(doc, selected.layerId))) {
        let bounds = strokeBounds(selected);
        if (Array.isArray(doc.layers) && LD.layers) {
          const matrix = LD.layers.placement(doc, selected.layerId);
          const x = bounds.x * matrix.scale + matrix.x, y = bounds.y * matrix.scale + matrix.y;
          const w = bounds.width * matrix.scale, h = bounds.height * matrix.scale;
          bounds = { x, y, width: w, height: h, maxX: x + w, maxY: y + h };
        }
        ctx.save(); ctx.globalAlpha = 0.7; ctx.strokeStyle = '#4268d2'; ctx.lineWidth = 1.6;
        ctx.setLineDash([5, 5]);
        ctx.strokeRect(bounds.x - 7, bounds.y - 7, bounds.width + 14, bounds.height + 14);
        ctx.setLineDash([]); ctx.fillStyle = '#fffefa';
        for (const [x, y] of [[bounds.x - 7, bounds.y - 7], [bounds.maxX + 7, bounds.maxY + 7]]) {
          ctx.fillRect(x - 3, y - 3, 6, 6); ctx.strokeRect(x - 3, y - 3, 6, 6);
        }
        ctx.restore();
      }
    }
    ctx.restore();
  }
  function sampleScene() {
    const doc = { version: 1, width: 960, height: 720, background: { color: '#fffefa', image: null, fit: 'contain' }, strokes: [] };
    let serial = 0;
    function add(points, brush, color, width, intensity, phase) {
      serial++;
      doc.strokes.push({ id: 'sample-' + serial, points: points.map((p, i) => ({ x: p[0], y: p[1], p: p[2] == null ? 0.5 : p[2], t: i * 12 })), brush, color, width: brush === 'star' || brush === 'bubble' ? width : width * 1.45, material: 'crayon', texture: 0.65, opacity: 1, intensity: intensity == null ? 0.5 : intensity, speed: 1, seed: 173 + serial * 673, phase: phase == null ? serial * 0.137 % 1 : phase, offset: { x: 0, y: 0 } });
    }
    function ellipse(cx, cy, rx, ry, rotate, from, to, count) {
      const result = [], a = from == null ? 0 : from, b = to == null ? TAU : to;
      for (let i = 0; i <= (count || 120); i++) {
        const t = a + (b - a) * i / (count || 120), x = rx * Math.cos(t), y = ry * Math.sin(t);
        result.push([cx + x * Math.cos(rotate) - y * Math.sin(rotate), cy + x * Math.sin(rotate) + y * Math.cos(rotate)]);
      }
      return result;
    }
    const navy = '#171717', blue = '#00aee8', red = '#ec008c', gold = '#ffd500', green = '#171717';
    // Every visible object is an editable stroke, including the planetary arcs.
    add(ellipse(484, 345, 102, 104, -0.08), 'boil', navy, 7, 0.27, 0.1);
    add(ellipse(483, 341, 66, 100, -0.44, -1.53, 1.60, 65), 'ink', '#171717', 4, 0, 0);
    add(ellipse(480, 347, 97, 31, -0.37, 0.15, 2.95, 55), 'ink', '#171717', 4, 0, 0);
    add(ellipse(480, 347, 229, 68, -0.35), 'flow', blue, 9, 0.62, 0.04);
    // A lively hand drawn heart.
    const heart = [];
    for (let i = 0; i <= 100; i++) {
      const t = TAU * i / 100;
      heart.push([251 + 3.1 * 16 * Math.sin(t) ** 3, 209 - 3.1 * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))]);
    }
    add(heart, 'boil', red, 8, 0.7, 0.13);
    add([[205, 152], [195, 135]], 'ink', red, 5, 0, 0);
    add([[226, 137], [224, 121]], 'ink', red, 4, 0, 0);
    // Golden stars are individually selectable, with independent phases.
    add([[680, 197]], 'star', gold, 24, 0.74, 0.11);
    add([[725, 247]], 'star', gold, 13, 0.72, 0.6);
    add([[631, 149]], 'star', gold, 10, 0.6, 0.38);
    add([[346, 442]], 'star', gold, 10, 0.6, 0.78);
    // A tiny garden with a stem and two softly moving leaves.
    add([[251, 553], [257, 529], [266, 506], [271, 481]], 'ink', green, 6, 0, 0);
    add([[263, 514], [244, 506], [226, 487], [222, 472], [239, 473], [255, 484], [263, 514]], 'wiggle', green, 6, 0.34, 0.32);
    add([[269, 495], [283, 472], [304, 462], [316, 464], [309, 484], [291, 495], [269, 495]], 'wiggle', green, 6, 0.3, 0.8);
    // Quiet orbiting bubbles and a small spring-like underline.
    add([[725, 410], [757, 452], [724, 491]], 'bubble', '#00aee8', 14, 0.7, 0.2);
    const wave = [];
    for (let i = 0; i <= 72; i++) { const u = i / 72; wave.push([405 + u * 193, 544 + Math.sin(u * Math.PI * 5) * 10]); }
    add(wave, 'wiggle', green, 8, 0.5, 0.35);
    add([[354, 174]], 'ink', '#171717', 8, 0, 0);
    add([[615, 477]], 'ink', red, 9, 0, 0);
    add([[183, 347]], 'star', '#171717', 9, 0.45, 0.2);
    return doc;
  }
  Object.assign(LD, { LOOP_DURATION: LOOP, prepareStroke, drawScene, strokeBounds, hitTest, sampleScene, invalidateStroke: stroke => {
    cache.delete(stroke);
    const entry = textureCache.get(stroke);
    if (entry) for (const cell of Array.from(entry.frames.values())) discardSurface(cell);
    textureCache.delete(stroke);
  }, getTextureStats: () => ({ pixels: texturePixels, surfaces: textureLRU.size, pixelBudget: TEXTURE_PIXEL_BUDGET }) });
})(window);
