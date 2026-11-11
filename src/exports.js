/* Live Doodle Demo — project files and browser exports. No third-party code. */
(function (global) {
  'use strict';
  const LD = global.LiveDoodle = global.LiveDoodle || {};
  const LIMITS = Object.freeze({ jsonBytes: 20 * 1024 * 1024, imageBytes: 12 * 1024 * 1024,
    strokes: 2000, pointsPerStroke: 20000, totalPoints: 200000, imagePixels: 32 * 1024 * 1024,
    layers: 48, layerDepth: 6, layerImages: 12, totalImageBytes: 12 * 1024 * 1024,
    isolationPixels: 32 * 1024 * 1024 });
  const BRUSHES = new Set(['ink', 'boil', 'wiggle', 'flow', 'star', 'bubble']);
  const MATERIALS = new Set(['crayon', 'pencil', 'marker']);
  const REFERENCE_ARTWORKS = new Set(['heart', 'scribble', 'star']);
  const abortError = () => new DOMException('Export cancelled.', 'AbortError');
  const checkAbort = signal => { if (signal && signal.aborted) throw abortError(); };
  const pause = () => new Promise(resolve => setTimeout(resolve, 0));
  const fail = message => { throw new Error(message); };
  const object = (value, name) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(name + ' has an invalid format.');
    return value;
  };
  const number = (value, min, max, name) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      fail(name + ' is out of range.');
    }
    return value;
  };
  const integer = (value, min, max, name) => {
    number(value, min, max, name);
    if (!Number.isInteger(value)) fail(name + ' must be an integer.');
    return value;
  };
  const color = (value, name) => {
    if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) fail(name + ' must be a six-digit hex color.');
    return value.toLowerCase();
  };
  function imageData(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') fail('Invalid background photo.');
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match || match[2].length % 4 !== 0) fail('Project photos must be embedded PNG, JPEG or WebP images.');
    if (match[2].length * 0.75 > LIMITS.imageBytes + 2) fail('The project photo exceeds 12 MB. Resize it first.');
    let head;
    try { head = atob(match[2].slice(0, 64)); } catch (_) { fail('The project photo is damaged.'); }
    const isPng = head.slice(0, 8) === '\x89PNG\r\n\x1a\n';
    const isJpeg = head.charCodeAt(0) === 255 && head.charCodeAt(1) === 216 && head.charCodeAt(2) === 255;
    const isWebp = head.slice(0, 4) === 'RIFF' && head.slice(8, 12) === 'WEBP';
    if (!(match[1] === 'png' && isPng || match[1] === 'jpeg' && isJpeg || match[1] === 'webp' && isWebp)) {
      fail('The photo type does not match its contents.');
    }
    if (isPng && head.length >= 24) {
      const u32 = i => ((head.charCodeAt(i) * 16777216) + (head.charCodeAt(i + 1) << 16)
        + (head.charCodeAt(i + 2) << 8) + head.charCodeAt(i + 3)) >>> 0;
      const w = u32(16), h = u32(20);
      if (!w || !h || w > 16384 || h > 16384 || w * h > LIMITS.imagePixels) fail('The project photo has too many pixels. Resize it first.');
    }
    return value;
  }

  LD.validateEmbeddedImage = imageData;
  function validateLayers(raw, width, height) {
    if (!Array.isArray(raw)) fail('Project layers must be an array.');
    const ids = new Map(), objects = new Set();
    let count = 0, imageCount = 0, imageBytes = 0;
    const bool = (value, fallback, name) => {
      if (value === undefined) return fallback;
      if (typeof value !== 'boolean') fail(name + ' must be true or false.'); return value;
    };
    function walk(list, depth, isolated) {
      if (depth > LIMITS.layerDepth) fail('Layers can nest up to 6 levels.');
      return list.map(source => {
        const layer = object(source, 'Layer');
        if (objects.has(layer)) fail('Layer trees cannot contain cycles or shared nodes.'); objects.add(layer);
        if (++count > LIMITS.layers) fail('A project can contain up to 48 layers.');
        if (typeof layer.id !== 'string' || !layer.id.length || layer.id.length > 128 || ids.has(layer.id)) fail('A layer ID is missing or duplicated.');
        if (!['paint', 'image', 'group'].includes(layer.kind)) fail('Unsupported layer type.');
        if (typeof layer.name !== 'string' || !layer.name.trim() || layer.name.length > 80) fail('Layer names need 1 to 80 characters.');
        const opacity = number(layer.opacity === undefined ? 1 : layer.opacity, 0, 1, 'Layer opacity');
        const nextIsolated = isolated + (opacity > 0 && opacity < 1 ? 1 : 0);
        if (width * height * nextIsolated > LIMITS.isolationPixels) fail('Too many translucent groups for this canvas size.');
        const transform = layer.transform === undefined ? { x: 0, y: 0, scale: 1 } : object(layer.transform, 'Layer position');
        const children = layer.children === undefined ? [] : layer.children;
        if (!Array.isArray(children)) fail('Layer children must be an array.');
        if (layer.kind !== 'group' && children.length) fail('Only groups can contain child layers.');
        if (layer.fit !== undefined && !['contain', 'cover'].includes(layer.fit)) fail('Unsupported layer image fit.');
        const image = imageData(layer.image);
        if (layer.kind === 'image') {
          if (!image) fail('An image layer needs an embedded image.');
          if (++imageCount > LIMITS.layerImages) fail('A project can contain up to 12 images.');
          const encoded = image.slice(image.indexOf(',') + 1);
          imageBytes += encoded.length * 0.75 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
          if (imageBytes > LIMITS.totalImageBytes) fail('Project images together must be 12 MB or smaller.');
        } else if (image) fail('Only image layers may contain an image.');
        const result = { id: layer.id, name: layer.name.trim(), kind: layer.kind,
          visible: bool(layer.visible, true, 'Layer visibility'), locked: bool(layer.locked, false, 'Layer lock'), opacity,
          image, fit: layer.fit || 'contain', transform: {
            x: number(transform.x, -4 * width, 5 * width, 'Layer x'), y: number(transform.y, -4 * height, 5 * height, 'Layer y'),
            scale: number(transform.scale, 0.05, 8, 'Layer scale') }, children: [] };
        ids.set(layer.id, result);
        if (children.length) result.children = walk(children, depth + 1, nextIsolated);
        return result;
      });
    }
    return { layers: walk(raw, 1, 0), ids };
  }

  LD.validateProject = function (raw) {
    object(raw, 'Project');
    if (raw.version !== 1 && raw.version !== 2) fail('Unsupported project version. Open a version 1 or 2 project.');
    const width = integer(raw.width, 128, 4096, 'Canvas width');
    const height = integer(raw.height, 128, 4096, 'Canvas height');
    if (width * height > 16777216) fail('The canvas has too many pixels.');
    const bg = object(raw.background, 'Background');
    if (bg.fit !== undefined && bg.fit !== 'contain' && bg.fit !== 'cover') fail('Unsupported photo fit mode.');
    const oldImage = imageData(bg.image);
    if (raw.version === 2 && oldImage) fail('Version 2 photos must belong to image layers.');
    const background = { color: color(bg.color, 'Background color'), image: null, fit: bg.fit || 'contain' };
    const legacyLayer = (id, name, kind, image) => ({ id, name, kind, visible: true, locked: kind === 'image', opacity: 1,
      image: image || null, fit: bg.fit || 'contain', transform: { x: 0, y: 0, scale: 1 }, children: [] });
    const migrated = raw.version === 1
      ? (oldImage ? [legacyLayer('layer-photo', 'Photo', 'image', oldImage)] : []).concat(legacyLayer('layer-doodles', 'Doodles', 'paint'))
      : raw.layers;
    const { layers, ids: layerIds } = validateLayers(migrated, width, height);
    const activeLayerId = raw.version === 1 ? 'layer-doodles' : raw.activeLayerId;
    if (layers.length ? !layers.some(layer => layer.id === activeLayerId) : activeLayerId !== null) fail('The active layer must name a top-level layer.');
    if (!Array.isArray(raw.strokes) || raw.strokes.length > LIMITS.strokes) fail('A project can contain up to 2,000 strokes.');
    let pointCount = 0;
    const ids = new Set();
    const strokes = raw.strokes.map((source, i) => {
      const s = object(source, 'Stroke ' + (i + 1));
      if (typeof s.id !== 'string' || !s.id.length || s.id.length > 128 || ids.has(s.id)) fail('A stroke ID is missing or duplicated.');
      ids.add(s.id);
      if (!BRUSHES.has(s.brush)) fail('Unsupported brush.');
      if (s.referenceArtwork !== undefined && !['ink','boil','wiggle'].includes(s.brush)) fail('Reference artwork supports Pen, Boil and Wiggle only.');
      if (s.referenceArtwork !== undefined && (typeof s.referenceArtwork !== 'string' || !REFERENCE_ARTWORKS.has(s.referenceArtwork))) {
        fail('Unknown reference artwork. Only heart, scribble and star are supported.');
      }
      const material = s.material === undefined ? 'crayon' : s.material;
      if (!MATERIALS.has(material)) fail('Edge style must be natural, fine or dissolve.');
      if (!Array.isArray(s.points) || s.points.length === 0 || s.points.length > LIMITS.pointsPerStroke) {
        fail('Each stroke needs 1 to 20,000 points.');
      }
      pointCount += s.points.length;
      if (pointCount > LIMITS.totalPoints) fail('The project exceeds 200,000 points. Remove some strokes.');
      const offset = s.offset === undefined ? { x: 0, y: 0 } : object(s.offset, 'Stroke position');
      const layerId = raw.version === 1 ? 'layer-doodles' : s.layerId;
      if (typeof layerId !== 'string' || !layerIds.has(layerId) || layerIds.get(layerId).kind === 'image') fail('A stroke refers to a missing or non-paintable layer.');
      return {
        id: s.id, layerId,
        ...(s.referenceArtwork === undefined ? {} : { referenceArtwork: s.referenceArtwork }),
        points: s.points.map(p => {
          object(p, 'Point');
          return { x: number(p.x, -4 * width, 5 * width, 'Point x'),
            y: number(p.y, -4 * height, 5 * height, 'Point y'),
            p: number(p.p === undefined ? 0.5 : p.p, 0, 1, 'Pressure'),
            t: number(p.t === undefined ? 0 : p.t, 0, 1e15, 'Input time') };
        }),
        brush: s.brush, color: color(s.color, 'Stroke color'), material,
        texture: number(s.texture === undefined ? 0.65 : s.texture, 0, 1, 'Edge roughness'),
        width: number(s.width, 1, 160, 'Stroke width'),
        opacity: number(s.opacity === undefined ? 1 : s.opacity, 0, 1, 'Stroke opacity'),
        intensity: number(s.intensity === undefined ? 0.5 : s.intensity, 0, 1, 'Motion intensity'),
        speed: integer(s.speed === undefined ? 1 : s.speed, 1, 3, 'Motion speed'),
        seed: integer(s.seed === undefined ? 1 : s.seed, 0, 4294967295, 'Seed'),
        phase: number(s.phase === undefined ? 0 : s.phase, 0, 1, 'Phase'),
        offset: { x: number(offset.x, -4 * width, 5 * width, 'Stroke x'),
          y: number(offset.y, -4 * height, 5 * height, 'Stroke y') }
      };
    });
    return { version: 2, width, height, background, layers, activeLayerId, strokes };
  };

  LD.serializeProject = function (doc) {
    const json = JSON.stringify(LD.validateProject(doc));
    if (new Blob([json]).size > LIMITS.jsonBytes) fail('The project exceeds 20 MB. Resize its photo or remove some strokes.');
    return json;
  };

  async function loadImage(data) {
    if (!data) return null;
    return new Promise((resolve, reject) => {
      const img = new Image();
      const timer = setTimeout(() => { img.onload = img.onerror = null; reject(new Error('The photo took too long to load. Import it again.')); }, 12000);
      img.onload = () => {
        clearTimeout(timer);
        if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth > 16384 || img.naturalHeight > 16384
          || img.naturalWidth * img.naturalHeight > LIMITS.imagePixels) {
          reject(new Error('The photo is too large or unreadable. Resize it first.'));
        } else resolve(img);
      };
      img.onerror = () => { clearTimeout(timer); reject(new Error('The project photo cannot be read. It may be damaged.')); };
      img.src = data;
    });
  }
  LD.loadProjectImage = loadImage;

  LD.readProject = async function (file) {
    if (!file || typeof file.text !== 'function') fail('Choose a saved inkbox project.');
    if (file.size > LIMITS.jsonBytes) fail('The project exceeds the 20 MB limit.');
    const text = await file.text();
    if (text.length > LIMITS.jsonBytes) fail('The project file is too large.');
    let raw;
    try { raw = JSON.parse(text); } catch (_) { fail('The project is not valid JSON or is damaged.'); }
    const doc = LD.validateProject(raw);
    if (!LD.layers) fail('Layer support is not ready.');
    await LD.layers.loadImages(doc);
    return doc;
  };

  function canvasFor(doc, width, height) {
    if (typeof LD.drawScene !== 'function') fail('The canvas is not ready. Try again shortly.');
    const canvas = document.createElement('canvas');
    canvas.width = width || doc.width; canvas.height = height || doc.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) fail('This browser cannot create an export canvas.');
    return { canvas, ctx };
  }
  function render(ctx, canvas, doc, time, options, image) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(canvas.width / doc.width, canvas.height / doc.height);
    LD.drawScene(ctx, doc, time, { backgroundImage: image, layerImages: options.layerImages,
      transparent: !!options.transparent, selection: false });
    ctx.restore();
  }
  LD.exportPNG = async function (source, time, options) {
    const opts = { ...(options || {}) }, doc = LD.validateProject(source);
    const { canvas, ctx } = canvasFor(doc);
    if (!LD.layers) fail('Layer support is not ready.');
    opts.layerImages = await LD.layers.loadImages(doc);
    const img = opts.backgroundImage || await loadImage(doc.background.image);
    render(ctx, canvas, doc, Number.isFinite(time) ? time : 0, opts, img);
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG export failed. Try again.')), 'image/png');
    });
  };

  // Palette: 216-color RGB cube, 32 grays, 7 paper/ink colors and one transparent entry.
  const palette = new Uint8Array(256 * 3);
  let paletteIndex = 0;
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) {
    palette[paletteIndex++] = r * 51; palette[paletteIndex++] = g * 51; palette[paletteIndex++] = b * 51;
  }
  for (let i = 0; i < 32; i++) {
    const v = Math.round(i * 255 / 31);
    palette[paletteIndex++] = v; palette[paletteIndex++] = v; palette[paletteIndex++] = v;
  }
  ['292b28', 'e85a49', '4268d2', 'f4c74c', '4e8e76', 'fffefa', 'ffffff'].forEach(hex => {
    palette[paletteIndex++] = parseInt(hex.slice(0, 2), 16);
    palette[paletteIndex++] = parseInt(hex.slice(2, 4), 16);
    palette[paletteIndex++] = parseInt(hex.slice(4, 6), 16);
  });
  let quantizer = null;
  function makeQuantizer() {
    if (quantizer) return quantizer;
    quantizer = new Uint8Array(32768);
    for (let key = 0; key < 32768; key++) {
      const r = ((key >> 10) & 31) * 255 / 31, g = ((key >> 5) & 31) * 255 / 31, b = (key & 31) * 255 / 31;
      let best = Math.round(r / 51) * 36 + Math.round(g / 51) * 6 + Math.round(b / 51), distance = Infinity;
      const candidates = [best, 216 + Math.round((r + g + b) / 3 * 31 / 255), 248, 249, 250, 251, 252, 253, 254];
      for (const index of candidates) {
        const dr = r - palette[index * 3], dg = g - palette[index * 3 + 1], db = b - palette[index * 3 + 2];
        const d = dr * dr + dg * dg + db * db;
        if (d < distance) { distance = d; best = index; }
      }
      quantizer[key] = best;
    }
    return quantizer;
  }
  function quantize(rgba, transparent) {
    const table = makeQuantizer(), indexed = new Uint8Array(rgba.length / 4);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
      if (transparent && rgba[i + 3] < 128) { indexed[j] = 255; continue; }
      indexed[j] = table[((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3)];
    }
    return indexed;
  }
  class Bytes {
    constructor() { this.parts = []; this.buffer = new Uint8Array(65536); this.length = 0; }
    byte(n) { if (this.length === this.buffer.length) { this.parts.push(this.buffer); this.buffer = new Uint8Array(65536); this.length = 0; } this.buffer[this.length++] = n; }
    finish() { this.parts.push(this.buffer.slice(0, this.length)); const length = this.parts.reduce((n, p) => n + p.length, 0); const data = new Uint8Array(length); let at = 0; for (const p of this.parts) { data.set(p, at); at += p.length; } return data; }
  }
  function lzw(pixels) {
    const out = new Bytes(), clear = 256, end = 257;
    let bits = 0, accumulator = 0, codeSize = 9, decoderNext = 258, hasPrevious = false;
    const write = code => {
      accumulator |= code << bits; bits += codeSize;
      while (bits >= 8) { out.byte(accumulator & 255); accumulator >>>= 8; bits -= 8; }
    };
    const clearCode = () => { write(clear); codeSize = 9; decoderNext = 258; hasPrevious = false; };
    const dataCode = code => {
      write(code);
      // Track the decoder's dictionary, which is one insertion behind the encoder.
      if (hasPrevious && decoderNext < 4096) {
        decoderNext++;
        if (decoderNext === (1 << codeSize) && codeSize < 12) codeSize++;
      }
      hasPrevious = true;
    };
    let dictionary = new Map(), next = 258, prefix = pixels[0];
    clearCode();
    for (let i = 1; i < pixels.length; i++) {
      const value = pixels[i], key = prefix * 256 + value, found = dictionary.get(key);
      if (found !== undefined) { prefix = found; continue; }
      dataCode(prefix);
      if (next < 4096) dictionary.set(key, next++);
      else { clearCode(); dictionary = new Map(); next = 258; }
      prefix = value;
    }
    dataCode(prefix); write(end);
    if (bits) out.byte(accumulator & 255);
    return out.finish();
  }
  const u16 = (array, n) => { array.push(n & 255, (n >> 8) & 255); };
  function gifHeader(width, height, transparent) {
    const bytes = [71, 73, 70, 56, 57, 97];
    u16(bytes, width); u16(bytes, height); bytes.push(0xf7, transparent ? 255 : 0, 0);
    return new Uint8Array(bytes);
  }
  function gifFrame(pixels, width, height, delay, transparent) {
    const head = [0x21, 0xf9, 4, transparent ? 9 : 4]; // disposal 2 for transparent, 1 for opaque
    u16(head, delay); head.push(transparent ? 255 : 0, 0, 0x2c, 0, 0, 0, 0);
    u16(head, width); u16(head, height); head.push(0, 8);
    const compressed = lzw(pixels), blocks = new Bytes();
    for (let i = 0; i < compressed.length; i += 255) {
      const length = Math.min(255, compressed.length - i); blocks.byte(length);
      for (let j = 0; j < length; j++) blocks.byte(compressed[i + j]);
    }
    blocks.byte(0);
    return [new Uint8Array(head), blocks.finish()];
  }
  async function exportGIF(doc, options, img) {
    const duration = number(options.duration === undefined ? 3 : options.duration, 0.3, 10, 'Export duration');
    let fps = Math.max(1, Math.min(12, Number.isFinite(options.fps) ? options.fps : 12));
    // A speed-3 boil switches 36 times/sec. Sampling it at 12fps lands on the
    // same one of three variants every time. 15fps preserves a changing image.
    if (fps === 12 && doc.strokes.some(stroke => stroke.brush === 'boil' && stroke.speed === 3 && stroke.intensity > 0)) fps = 15;
    const count = Math.max(2, Math.round(duration * fps)), centiseconds = Math.round(duration * 100);
    const scale = Math.min(1, 640 / Math.max(doc.width, doc.height));
    const width = Math.max(1, Math.round(doc.width * scale)), height = Math.max(1, Math.round(doc.height * scale));
    const { canvas, ctx } = canvasFor(doc, width, height);
    const parts = [gifHeader(width, height, options.transparent), palette,
      new Uint8Array([0x21, 0xff, 11, 78, 69, 84, 83, 67, 65, 80, 69, 50, 46, 48, 3, 1, 0, 0, 0])];
    for (let frame = 0; frame < count; frame++) {
      checkAbort(options.signal);
      render(ctx, canvas, doc, frame * duration / count, options, img);
      const pixels = quantize(ctx.getImageData(0, 0, width, height).data, !!options.transparent);
      const delay = Math.round((frame + 1) * centiseconds / count) - Math.round(frame * centiseconds / count);
      parts.push(...gifFrame(pixels, width, height, delay, !!options.transparent));
      if (typeof options.onProgress === 'function') options.onProgress((frame + 1) / count);
      await pause();
    }
    checkAbort(options.signal); parts.push(new Uint8Array([0x3b]));
    return { blob: new Blob(parts, { type: 'image/gif' }), extension: 'gif', mime: 'image/gif',
      width, height, frames: count, duration: centiseconds / 100, fps: count / duration, realtime: false };
  }

  function videoMime() {
    if (typeof global.MediaRecorder !== 'function' || typeof global.MediaRecorder.isTypeSupported !== 'function') return null;
    return ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9',
      'video/webm;codecs=vp8', 'video/webm'].find(type => global.MediaRecorder.isTypeSupported(type)) || null;
  }
  async function exportVideo(doc, options, img) {
    if (options.transparent) fail('Video cannot use a transparent background. Choose PNG or GIF.');
    const mime = videoMime();
    if (!mime) fail('This browser cannot record video. Choose GIF.');
    const duration = number(options.duration === undefined ? 3 : options.duration, 0.3, 10, 'Export duration');
    const fps = Math.max(1, Math.min(30, Number.isFinite(options.fps) ? options.fps : 30));
    const { canvas, ctx } = canvasFor(doc);
    if (typeof canvas.captureStream !== 'function') fail('This browser cannot record a canvas. Choose GIF.');
    render(ctx, canvas, doc, 0, options, img);
    const stream = canvas.captureStream(fps), chunks = [];
    let recorder;
    try { recorder = new global.MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6000000 }); }
    catch (_) { stream.getTracks().forEach(track => track.stop()); fail('This device cannot start recording. Choose GIF.'); }
    return new Promise((resolve, reject) => {
      let ended = false, animationId = null, timer = null, start = 0;
      const cleanup = () => {
        if (animationId !== null) cancelAnimationFrame(animationId);
        if (timer !== null) clearTimeout(timer);
        if (options.signal) options.signal.removeEventListener('abort', cancel);
        stream.getTracks().forEach(track => track.stop());
      };
      const finishError = error => {
        if (ended) return; ended = true; cleanup();
        if (recorder.state !== 'inactive') { try { recorder.stop(); } catch (_) {} }
        reject(error);
      };
      const cancel = () => finishError(abortError());
      recorder.ondataavailable = event => { if (event.data && event.data.size) chunks.push(event.data); };
      recorder.onerror = () => finishError(new Error('Recording failed. Keep this tab visible or choose GIF.'));
      recorder.onstop = () => {
        if (ended) return; ended = true; cleanup();
        if (!chunks.length) { reject(new Error('Recording produced no video. Choose GIF.')); return; }
        const actualMime = recorder.mimeType || mime, blob = new Blob(chunks, { type: actualMime });
        if (typeof options.onProgress === 'function') options.onProgress(1);
        resolve({ blob, extension: actualMime.includes('mp4') ? 'mp4' : 'webm', mime: actualMime,
          width: doc.width, height: doc.height, duration, realtime: true });
      };
      const tick = now => {
        if (ended || recorder.state === 'inactive') return;
        const t = Math.min((now - start) / 1000, duration);
        render(ctx, canvas, doc, t, options, img);
        if (typeof options.onProgress === 'function') options.onProgress(Math.min(0.99, t / duration));
        if (t < duration) animationId = requestAnimationFrame(tick);
      };
      if (options.signal) options.signal.addEventListener('abort', cancel, { once: true });
      if (options.signal && options.signal.aborted) { cancel(); return; }
      try {
        recorder.start(250); start = performance.now(); animationId = requestAnimationFrame(tick);
        timer = setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, duration * 1000);
      } catch (_) { finishError(new Error('Recording could not start. Choose GIF.')); }
    });
  }

  LD.exportAnimation = async function (source, options) {
    const opts = { ...(options || {}) }; checkAbort(opts.signal);
    const doc = LD.validateProject(source);
    if (typeof opts.onProgress === 'function') opts.onProgress(0);
    if (!LD.layers) fail('Layer support is not ready.');
    opts.layerImages = await LD.layers.loadImages(doc);
    const img = opts.backgroundImage || await loadImage(doc.background.image);
    checkAbort(opts.signal);
    if (!opts.format || opts.format === 'gif') return exportGIF(doc, opts, img);
    if (opts.format === 'video') return exportVideo(doc, opts, img);
    fail('Choose GIF or video.');
  };

  LD.download = function (blob, name) {
    if (!(blob instanceof Blob) || !blob.size) fail('There is no file to save.');
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = typeof name === 'string' ? name : 'live-doodle';
    link.style.display = 'none'; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  LD.exportCapabilities = function () {
    return { png: true, gif: true, video: !!videoMime(), videoMime: videoMime(), livePhoto: false,
      gifMaxEdge: 640, gifDefaultFps: 12, gifMaxFps: 15, projectLimits: LIMITS };
  };
})(window);
