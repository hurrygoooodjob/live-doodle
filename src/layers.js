/* Editable layer trees. Strokes stay as live geometry; merging never rasterizes them. */
(function (global) {
  'use strict';
  const LD = global.LiveDoodle = global.LiveDoodle || {};
  const LIMITS = Object.freeze({ nodes: 48, depth: 6, images: 12, imageBytes: 12 * 1024 * 1024,
    isolationPixels: 32 * 1024 * 1024 });
  const clone = value => JSON.parse(JSON.stringify(value));
  const identity = () => ({ x: 0, y: 0, scale: 1 });
  let serial = 0;
  function uid(prefix) {
    return prefix + '-' + (global.crypto && typeof global.crypto.randomUUID === 'function'
      ? global.crypto.randomUUID() : Date.now().toString(36) + '-' + (++serial).toString(36));
  }
  function node(kind, name) {
    return { id: uid('layer'), name: String(name || (kind === 'image' ? 'Reference' : 'Doodles')).slice(0, 80),
      kind, visible: true, locked: kind === 'image', opacity: kind === 'image' ? 0.35 : 1,
      image: null, fit: 'contain', transform: identity(), children: [] };
  }
  function createPaint(name) { return node('paint', name); }
  function createImage(data, name) {
    if (typeof LD.validateEmbeddedImage !== 'function') throw new Error('Image support is not ready.');
    const result = node('image', name); result.image = LD.validateEmbeddedImage(data);
    if (!result.image) throw new Error('Choose a PNG, JPEG or WebP image.');
    return result;
  }
  function all(doc) {
    const result = [], seen = new Set();
    function walk(list) { for (const entry of list || []) {
      if (!entry || seen.has(entry)) continue; seen.add(entry); result.push(entry); walk(entry.children);
    } }
    walk(doc && doc.layers); return result;
  }
  function find(doc, id) { return all(doc).find(entry => entry.id === id) || null; }
  function pathFor(doc, id) {
    function walk(list, path) {
      for (const entry of list || []) {
        const current = path.concat(entry); if (entry.id === id) return current;
        const inside = walk(entry.children, current); if (inside) return inside;
      } return null;
    }
    return walk(doc && doc.layers, []);
  }
  function rootFor(doc, id) { const path = pathFor(doc, id); return path ? path[0] : null; }
  function isVisible(doc, id) {
    const path = pathFor(doc, id); return !!path && path.every(entry => entry.visible && entry.opacity > 0);
  }
  function isEditable(doc, id) {
    const path = pathFor(doc, id); return !!path && path[path.length - 1].kind !== 'image'
      && path.every(entry => entry.visible && !entry.locked && entry.opacity > 0);
  }
  function matrixFor(doc, parent, transform) {
    const scale = transform.scale, tx = transform.x + doc.width * (1 - scale) / 2;
    const ty = transform.y + doc.height * (1 - scale) / 2;
    return { scale: parent.scale * scale, x: parent.x + parent.scale * tx, y: parent.y + parent.scale * ty };
  }
  function placement(doc, id) {
    const path = pathFor(doc, id); if (!path) return identity();
    return path.reduce((parent, entry) => matrixFor(doc, parent, entry.transform), identity());
  }
  function partition(doc, activeStroke) {
    const map = new Map();
    for (const stroke of doc.strokes || []) {
      if (!map.has(stroke.layerId)) map.set(stroke.layerId, []);
      map.get(stroke.layerId).push(stroke);
    }
    if (activeStroke && !(doc.strokes || []).some(s => s.id === activeStroke.id)) {
      if (!map.has(activeStroke.layerId)) map.set(activeStroke.layerId, []);
      map.get(activeStroke.layerId).push(activeStroke);
    }
    return map;
  }
  function entries(doc, editableOnly) {
    const result = [], strokes = partition(doc);
    function walk(list, parent, locked) {
      for (const layer of list) {
        if (!layer.visible || layer.opacity <= 0) continue;
        const matrix = matrixFor(doc, parent, layer.transform), blocked = locked || layer.locked;
        walk(layer.children || [], matrix, blocked);
        if (layer.kind !== 'image' && (!editableOnly || !blocked)) {
          for (const stroke of strokes.get(layer.id) || []) result.push({ stroke, matrix });
        }
      }
    }
    walk(doc.layers || [], identity(), false); return result;
  }
  function orderedStrokes(doc, editableOnly) { return entries(doc, !!editableOnly).map(entry => entry.stroke); }
  function chooseActive(doc) {
    const roots = doc.layers || [];
    return roots.length ? roots[roots.length - 1].id : null;
  }
  function mergeDown(doc, id) {
    const index = (doc.layers || []).findIndex(layer => layer.id === id);
    if (index < 1) throw new Error('Choose a layer with another layer below it.');
    if (all(doc).length >= LIMITS.nodes) throw new Error('The project has reached its layer limit.');
    const below = doc.layers[index - 1], above = doc.layers[index];
    const merged = node('group', (above.name + ' + ' + below.name).slice(0, 80));
    merged.children = [below, above];
    const candidate = { ...doc, layers: doc.layers.slice() };
    candidate.layers.splice(index - 1, 2, merged); candidate.activeLayerId = merged.id;
    if (typeof LD.validateProject === 'function') LD.validateProject(candidate);
    doc.layers = candidate.layers; doc.activeLayerId = merged.id; return merged.id;
  }
  function remove(doc, id) {
    const target = find(doc, id); if (!target) throw new Error('The layer no longer exists.');
    const removed = new Set(all({ layers: [target] }).map(layer => layer.id));
    function filter(list) { return list.filter(layer => !removed.has(layer.id)).map(layer => {
      if (layer.children.length) layer.children = filter(layer.children); return layer;
    }); }
    doc.layers = filter(doc.layers); doc.strokes = doc.strokes.filter(stroke => !removed.has(stroke.layerId));
    if (!doc.layers.some(layer => layer.id === doc.activeLayerId)) doc.activeLayerId = chooseActive(doc);
    return doc.activeLayerId;
  }
  function duplicate(doc, id) {
    const source = rootFor(doc, id); if (!source) throw new Error('The layer no longer exists.');
    const result = clone(source), remap = new Map();
    for (const layer of all({ layers: [result] })) { const old = layer.id; layer.id = uid('layer'); remap.set(old, layer.id); }
    result.name = (source.name + ' copy').slice(0, 80);
    const strokes = doc.strokes.filter(stroke => remap.has(stroke.layerId)).map(stroke => ({ ...clone(stroke), id: uid('stroke'), layerId: remap.get(stroke.layerId) }));
    const candidate = { ...doc, layers: doc.layers.slice(), strokes: doc.strokes.concat(strokes), activeLayerId: result.id };
    candidate.layers.splice(doc.layers.indexOf(source) + 1, 0, result);
    if (typeof LD.validateProject === 'function') LD.validateProject(candidate);
    doc.layers = candidate.layers; doc.strokes = candidate.strokes; doc.activeLayerId = result.id; return result.id;
  }
  function forExport(doc, ids) {
    if (!Array.isArray(ids)) throw new Error('Choose the layers to export.');
    const selected = new Set();
    for (const id of ids) {
      const root = rootFor(doc, id); if (!root) throw new Error('An export layer no longer exists.'); selected.add(root.id);
    }
    const result = clone(doc);
    result.layers = result.layers.filter(layer => selected.has(layer.id));
    result.layers.forEach(layer => { layer.visible = true; });
    const retained = new Set(all(result).map(layer => layer.id));
    result.strokes = result.strokes.filter(stroke => retained.has(stroke.layerId));
    result.activeLayerId = chooseActive(result); return result;
  }
  async function loadImages(doc) {
    const result = new Map(), byData = new Map();
    if (typeof LD.loadProjectImage !== 'function') throw new Error('Image support is not ready.');
    for (const layer of all(doc)) if (layer.kind === 'image') {
      const data = LD.validateEmbeddedImage(layer.image);
      if (!byData.has(data)) byData.set(data, LD.loadProjectImage(data));
      result.set(layer.id, await byData.get(data));
    }
    return result;
  }

  // Only simultaneously nested translucent layers need separate full-canvas buffers.
  const surfaces = [];
  function surface(width, height, depth) {
    if (width * height * (depth + 1) > LIMITS.isolationPixels) throw new Error('Too many translucent groups for this canvas size.');
    while (surfaces.length > depth + 1) { const old = surfaces.pop(); old.canvas.width = old.canvas.height = 1; }
    let entry = surfaces[depth];
    if (!entry) { const c = global.document.createElement('canvas'); entry = surfaces[depth] = { canvas: c, ctx: c.getContext('2d') }; }
    if (entry.canvas.width !== width || entry.canvas.height !== height) { entry.canvas.width = width; entry.canvas.height = height; }
    const ctx = entry.ctx; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur = 0; ctx.shadowOffsetX = ctx.shadowOffsetY = 0; ctx.shadowColor = 'transparent';
    if ('filter' in ctx) ctx.filter = 'none'; ctx.clearRect(0, 0, width, height);
    return entry;
  }
  function draw(ctx, doc, time, options, drawStroke) {
    const strokes = partition(doc, options.activeStroke), images = options.layerImages || new Map();
    function contents(target, layer, matrix, depth) {
      if (layer.kind === 'image') {
        const image = images.get(layer.id);
        if (image) {
          const iw = image.naturalWidth || image.width, ih = image.naturalHeight || image.height;
          if (iw > 0 && ih > 0) {
            const fit = layer.fit === 'cover' ? Math.max(doc.width / iw, doc.height / ih) : Math.min(doc.width / iw, doc.height / ih);
            const w = iw * fit, h = ih * fit;
            target.save(); target.transform(matrix.scale, 0, 0, matrix.scale, matrix.x, matrix.y);
            target.globalAlpha = 1; target.drawImage(image, (doc.width - w) / 2, (doc.height - h) / 2, w, h); target.restore();
          }
        }
      }
      for (const child of layer.children) paint(target, child, matrix, depth);
      if (layer.kind !== 'image') {
        target.save(); target.transform(matrix.scale, 0, 0, matrix.scale, matrix.x, matrix.y);
        for (const stroke of strokes.get(layer.id) || []) drawStroke(target, stroke, time);
        target.restore();
      }
    }
    function paint(target, layer, parent, depth) {
      if (!layer.visible || layer.opacity <= 0) return;
      const matrix = matrixFor(doc, parent, layer.transform);
      if (layer.opacity < 1) {
        const isolated = surface(doc.width, doc.height, depth);
        contents(isolated.ctx, layer, matrix, depth + 1);
        target.save(); target.globalAlpha = layer.opacity; target.globalCompositeOperation = 'source-over';
        target.drawImage(isolated.canvas, 0, 0); target.restore();
      } else contents(target, layer, matrix, depth);
    }
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, doc.width, doc.height); ctx.clip();
    for (const layer of doc.layers) paint(ctx, layer, identity(), 0);
    ctx.restore();
  }
  LD.layers = { LIMITS, createPaint, createImage, find, rootFor, all, isEditable, isVisible,
    orderedStrokes, entries, placement, mergeDown, remove, duplicate, forExport, loadImages, draw };
})(window);
