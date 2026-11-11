/* The three reference drawings are independently editable stencils extracted at runtime.
   Source image is supplied by the user. No project file can supply an asset URL. */
(function (global) {
  'use strict';
  const LD = global.LiveDoodle = global.LiveDoodle || {};
  const REGION = Object.freeze({ x: 22, y: 212, width: 1060, height: 697 });
  const IDS = Object.freeze(['heart', 'scribble', 'star']);
  const COLORS = Object.freeze({ heart: '#f90095', scribble: '#171717', star: '#00bddc' });
  const assets = new Map();
  let paper = null, original = null, ready = false, pending = null;
  const mod = (x, n) => ((x % n) + n) % n;
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const finite = (x, fallback) => Number.isFinite(Number(x)) ? Number(x) : fallback;
  function canvas(width, height) {
    const result = global.document.createElement('canvas');
    result.width = width; result.height = height; return result;
  }
  function strongLabel(r, g, b) {
    if (r - g > 50 && b - g > 25 && r > 140) return 1;
    if (g - r > 40 && b - r > 30 && b > 130) return 3;
    // Isolated pale graphite flecks are part of the black drawing too. Checking
    // the minimum channel includes their antialiased tint without absorbing paper.
    if (Math.min(r, g, b) < 220 && Math.max(r, g, b) - Math.min(r, g, b) < 50) return 2;
    return 0;
  }
  function compatible(label, r, g, b) {
    if (label === 1) return r - g > 1 && b - g > 0.5;
    if (label === 3) return g - r > 1 && b - r > 1;
    return Math.max(r, g, b) - Math.min(r, g, b) < 45 && Math.min(r, g, b) < 254;
  }
  function extract(image) {
    if (image.naturalWidth !== 1487 || image.naturalHeight !== 1058) {
      throw new Error('The reference image must be the original 1487 × 1058 PNG.');
    }
    const width = REGION.width, height = REGION.height;
    original = canvas(width, height);
    const source = original.getContext('2d', { willReadFrequently: true });
    source.drawImage(image, REGION.x, REGION.y, width, height, 0, 0, width, height);
    const pixels = source.getImageData(0, 0, width, height);
    const strong = new Uint8Array(width * height), labels = new Uint8Array(width * height);
    for (let i = 0; i < strong.length; i++) {
      const j = i * 4; strong[i] = strongLabel(pixels.data[j], pixels.data[j + 1], pixels.data[j + 2]);
    }
    labels.set(strong);
    // Include only weak antialiasing within 3 pixels of a definite ink pixel.
    // This prevents paper grain elsewhere in the canvas from becoming black artwork.
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x, j = i * 4;
      if (strong[i]) continue;
      let best = 100, chosen = 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const xx = x + dx, yy = y + dy, distance = dx * dx + dy * dy;
        if (distance > 10 || distance >= best || xx < 0 || xx >= width || yy < 0 || yy >= height) continue;
        const label = strong[yy * width + xx];
        if (label && compatible(label, pixels.data[j], pixels.data[j + 1], pixels.data[j + 2])) {
          best = distance; chosen = label;
        }
      }
      labels[i] = chosen;
    }
    paper = canvas(width, height);
    const paperCtx = paper.getContext('2d');
    const paperPixels = paperCtx.createImageData(width, height); paperPixels.data.set(pixels.data);
    const bounds = IDS.map(() => ({ minX: width, minY: height, maxX: -1, maxY: -1, count: 0 }));
    for (let i = 0; i < labels.length; i++) if (labels[i]) {
      const box = bounds[labels[i] - 1], x = i % width, y = Math.floor(i / width), j = i * 4;
      box.minX = Math.min(box.minX, x); box.minY = Math.min(box.minY, y);
      box.maxX = Math.max(box.maxX, x); box.maxY = Math.max(box.maxY, y); box.count++;
      // The source edge has a white matte. Pair the un-matted stencil with white beneath it.
      paperPixels.data[j] = paperPixels.data[j + 1] = paperPixels.data[j + 2] = 255;
      paperPixels.data[j + 3] = 255;
    }
    paperCtx.putImageData(paperPixels, 0, 0);
    assets.clear();
    IDS.forEach((id, index) => {
      const box = bounds[index];
      if (box.count < 50) throw new Error('Could not identify all three reference drawings.');
      const w = box.maxX - box.minX + 1, h = box.maxY - box.minY + 1;
      const stencil = canvas(w, h), ctx = stencil.getContext('2d');
      const data = ctx.createImageData(w, h), alpha = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const sourceIndex = (y + box.minY) * width + x + box.minX;
        if (labels[sourceIndex] !== index + 1) continue;
        const from = sourceIndex * 4, to = (y * w + x) * 4;
        const minimum = Math.min(pixels.data[from], pixels.data[from + 1], pixels.data[from + 2]);
        const a = Math.min(255, Math.ceil((255 - minimum) / 0.55));
        if (!a) continue;
        for (let channel = 0; channel < 3; channel++) {
          data.data[to + channel] = clamp(Math.round((pixels.data[from + channel] - (255 - a)) * 255 / a), 0, 255);
        }
        data.data[to + 3] = a; alpha[y * w + x] = a;
      }
      ctx.putImageData(data, 0, 0);
      assets.set(id, { id, x: box.minX, y: box.minY, width: w, height: h, color: COLORS[id],
        stencil, alpha, rgba: new Uint8ClampedArray(data.data), inkPixels: box.count, tints: new Map(), edgeCache: new Map() });
    });
    ready = true;
  }
  LD.initReferenceArt = function (url) {
    if (ready) return Promise.resolve(LD.getReferenceArtInfo());
    if (pending) return pending;
    const source = url || global.INKBOX_REFERENCE_ASSET || new URL('assets/inkbox-original.png', global.document.baseURI).href;
    pending = new Promise((resolve, reject) => {
      const image = new Image();
      const timer = setTimeout(() => { image.onload = image.onerror = null; reject(new Error('Reference artwork loading timed out.')); }, 15000);
      image.onload = () => {
        clearTimeout(timer);
        try { extract(image); resolve(LD.getReferenceArtInfo()); }
        catch (error) { reject(new Error('Unable to prepare the reference artwork: ' + error.message)); }
      };
      image.onerror = () => { clearTimeout(timer); reject(new Error('The original reference image could not be loaded.')); };
      image.src = source;
    }).catch(error => { pending = null; throw error; });
    return pending;
  };
  function assetFor(stroke) {
    if (!stroke || !IDS.includes(stroke.referenceArtwork)) return null;
    const asset = assets.get(stroke.referenceArtwork);
    if (!asset) throw new Error('Reference artwork is not ready.');
    return asset;
  }
  function scaleFor(stroke) { return clamp(finite(stroke.width, 12), 1, 160) / 12; }
  function placement(stroke, asset) {
    const scale = scaleFor(stroke);
    return { scale, x: asset.x + asset.width * (1 - scale) / 2 + finite(stroke.offset && stroke.offset.x, 0),
      y: asset.y + asset.height * (1 - scale) / 2 + finite(stroke.offset && stroke.offset.y, 0) };
  }
  function extrema3(input, width, height, maximum) {
    const horizontal = new Uint8Array(input.length), result = new Uint8Array(input.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const row = y * width, a = input[row + Math.max(0, x - 1)], b = input[row + x], c = input[row + Math.min(width - 1, x + 1)];
      horizontal[row + x] = maximum ? Math.max(a, b, c) : Math.min(a, b, c);
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const a = horizontal[Math.max(0, y - 1) * width + x], b = horizontal[y * width + x], c = horizontal[Math.min(height - 1, y + 1) * width + x];
      result[y * width + x] = maximum ? Math.max(a, b, c) : Math.min(a, b, c);
    }
    return result;
  }
  function pixelRandom(x, y, seed) {
    let n = Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263) ^ (seed | 0);
    n = Math.imul(n ^ n >>> 13, 1274126177);
    return ((n ^ n >>> 16) >>> 0) / 4294967296;
  }
  function styledAlpha(asset, stroke) {
    const texture = clamp(finite(stroke.texture, 0.65), 0, 1), material = stroke.material || 'crayon';
    const key = material + ':' + texture.toFixed(3) + ':' + finite(stroke.seed, 1);
    if (material === 'crayon' && Math.abs(texture - 0.65) < 0.00001) return asset.alpha;
    if (asset.edgeCache.has(key)) return asset.edgeCache.get(key);
    let alpha = new Uint8Array(asset.alpha);
    if (texture < 0.65) {
      // Closing followed by opening smooths tiny edge defects; it is not a full-image blur.
      const closed = extrema3(extrema3(asset.alpha, asset.width, asset.height, true), asset.width, asset.height, false);
      const smooth = extrema3(extrema3(closed, asset.width, asset.height, false), asset.width, asset.height, true);
      const amount = (0.65 - texture) / 0.65;
      for (let i = 0; i < alpha.length; i++) alpha[i] = Math.round(asset.alpha[i] * (1 - amount) + smooth[i] * amount);
    } else {
      const onePixelCore = extrema3(asset.alpha, asset.width, asset.height, false);
      const twoPixelCore = material === 'marker' ? extrema3(onePixelCore, asset.width, asset.height, false) : onePixelCore;
      const amount = (texture - 0.65) / 0.35;
      const threshold = amount * 0.42 + (material === 'marker' ? 0.12 : material === 'pencil' ? 0.07 : 0);
      const grid = material === 'pencil' ? 1 : 2;
      for (let y = 0; y < asset.height; y++) for (let x = 0; x < asset.width; x++) {
        const i = y * asset.width + x;
        // A saturated 1–2px neighborhood is immutable: only the silhouette boundary can dissolve.
        if (alpha[i] && twoPixelCore[i] < 20 && pixelRandom(Math.floor(x / grid), Math.floor(y / grid), finite(stroke.seed, 1)) < threshold) {
          alpha[i] = Math.round(alpha[i] * (material === 'pencil' ? 0.28 : 0.06));
        }
      }
    }
    if (asset.edgeCache.size >= 4) asset.edgeCache.delete(asset.edgeCache.keys().next().value);
    asset.edgeCache.set(key, alpha); return alpha;
  }
  function colored(asset, stroke) {
    const color = String(stroke.color || asset.color).toLowerCase();
    const alpha = styledAlpha(asset, stroke);
    if (color === asset.color && alpha === asset.alpha) return asset.stencil;
    const key = [color, stroke.material || 'crayon', finite(stroke.texture, 0.65).toFixed(3), finite(stroke.seed, 1)].join('|');
    if (asset.tints.has(key)) return asset.tints.get(key);
    const result = canvas(asset.width, asset.height), ctx = result.getContext('2d'), data = ctx.createImageData(asset.width, asset.height);
    const value = parseInt(color.slice(1), 16), rgb = [value >> 16 & 255, value >> 8 & 255, value & 255];
    const preserveOriginal = color === asset.color;
    for (let i = 0; i < alpha.length; i++) {
      if (!alpha[i]) continue;
      const j = i * 4;
      for (let c = 0; c < 3; c++) data.data[j + c] = preserveOriginal && asset.alpha[i] ? asset.rgba[j + c] : rgb[c];
      data.data[j + 3] = alpha[i];
    }
    ctx.putImageData(data, 0, 0);
    if (asset.tints.size >= 6) asset.tints.delete(asset.tints.keys().next().value);
    asset.tints.set(key, result); return result;
  }
  function warp(stroke, time, y) {
    const amount = clamp(finite(stroke.intensity, 0.5), 0, 1), speed = clamp(Math.round(finite(stroke.speed, 1)), 1, 3);
    const t = mod(finite(time, 0), 3), phase = mod(finite(stroke.phase, 0), 1), seed = finite(stroke.seed, 1);
    if (!amount || stroke.brush === 'ink' || t === 0) return 0;
    const local = y / 64 + seed * 0.017;
    if (stroke.brush === 'boil') {
      const frame = Math.floor(t * 12 * speed + phase * 3 + 1e-8) % 3;
      if (frame === 0) return 0;
      return amount * 2.2 * (Math.sin(local * 1.7 + frame * 2.1) * 0.7 + Math.sin(local * 0.6 + frame) * 0.3);
    }
    const theta = Math.PI * 2 * (t / 3 * speed);
    return amount * 2.2 * (Math.sin(theta + local) - Math.sin(local)) * 0.5;
  }
  LD.drawReferenceStroke = function (ctx, stroke, time) {
    const asset = assetFor(stroke); if (!asset) return false;
    const place = placement(stroke, asset), image = colored(asset, stroke);
    const t = mod(finite(time, 0), 3), amount = clamp(finite(stroke.intensity, 0.5), 0, 1);
    const opacity = clamp(finite(stroke.opacity, 1), 0, 1);
    ctx.save(); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = opacity;
    ctx.shadowBlur = 0; ctx.translate(place.x, place.y); ctx.scale(place.scale, place.scale);
    if (t === 0 || !amount || stroke.brush === 'ink') ctx.drawImage(image, 0, 0);
    else {
      // Horizontal strip displacements are tied to source y and explicit time.
      // Each strip remains a complete alpha stencil; no frame ever randomizes the pixels.
      const band = 3;
      for (let y = 0; y < asset.height; y += band) {
        const h = Math.min(band, asset.height - y), dx = warp(stroke, t, y + h / 2);
        ctx.drawImage(image, 0, y, asset.width, h, dx, y, asset.width, h);
      }
    }
    ctx.restore(); return true;
  };
  LD.referenceStrokeBounds = function (stroke) {
    const asset = assetFor(stroke); if (!asset) return null;
    const place = placement(stroke, asset), margin = (3 * clamp(finite(stroke.intensity, 0.5), 0, 1) + 1) * place.scale;
    const x = place.x - margin, y = place.y - margin, width = asset.width * place.scale + margin * 2, height = asset.height * place.scale + margin * 2;
    return { x, y, width, height, minX: x, minY: y, maxX: x + width, maxY: y + height };
  };
  LD.hitReferenceStroke = function (stroke, x, y, tolerance) {
    const asset = assetFor(stroke); if (!asset || finite(stroke.opacity, 1) <= 0) return false;
    const alpha = styledAlpha(asset, stroke);
    const place = placement(stroke, asset), px = (x - place.x) / place.scale, py = (y - place.y) / place.scale;
    const radius = Math.min(48, Math.max(0, finite(tolerance, 12)) / place.scale + 3);
    if (px < -radius || py < -radius || px >= asset.width + radius || py >= asset.height + radius) return false;
    const minX = Math.max(0, Math.floor(px - radius)), maxX = Math.min(asset.width - 1, Math.ceil(px + radius));
    const minY = Math.max(0, Math.floor(py - radius)), maxY = Math.min(asset.height - 1, Math.ceil(py + radius));
    for (let yy = minY; yy <= maxY; yy++) for (let xx = minX; xx <= maxX; xx++) {
      if ((xx - px) ** 2 + (yy - py) ** 2 <= radius ** 2 && alpha[yy * asset.width + xx] > 24) return true;
    }
    return false;
  };
  LD.paintReferencePaper = function (ctx, doc) {
    if (!ready || !paper || doc.background && doc.background.image) return false;
    if (String(doc.background && doc.background.color).toLowerCase() !== '#ffffff') return false;
    if (doc.width !== REGION.width || doc.height !== REGION.height) return false;
    ctx.drawImage(paper, 0, 0); return true;
  };
  LD.getReferenceArtInfo = function () {
    return { ready, region: { ...REGION }, artwork: Array.from(assets.values()).map(a => ({ id: a.id, x: a.x, y: a.y,
      width: a.width, height: a.height, color: a.color, inkPixels: a.inkPixels })) };
  };
  LD.drawReferenceOriginal = function (ctx) {
    if (!ready) throw new Error('Reference artwork is not ready.'); ctx.drawImage(original, 0, 0);
  };
  LD.REFERENCE_REGION = REGION;
  LD.REFERENCE_ARTWORK_IDS = IDS;
  LD.sampleScene = function () {
    if (!ready) throw new Error('Call initReferenceArt before creating the reference scene.');
    const strokes = IDS.map((id, i) => {
      const asset = assets.get(id);
      return { id: 'reference-' + id, referenceArtwork: id,
        points: [{ x: asset.x + asset.width / 2, y: asset.y + asset.height / 2, p: 0.5, t: 0 }],
        brush: id === 'star' ? 'wiggle' : 'boil', color: asset.color, width: 12, material: 'crayon', texture: 0.65,
        opacity: 1, intensity: 0.5, speed: 1, seed: 71337 + i * 1771, phase: 0, offset: { x: 0, y: 0 } };
    });
    return { version: 1, width: REGION.width, height: REGION.height,
      background: { color: '#ffffff', image: null, fit: 'contain' }, strokes };
  };
})(window);
