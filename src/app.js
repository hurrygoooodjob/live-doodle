(() => {
  'use strict';
  const LD = window.LiveDoodle;
  const layers = LD.layers;
  const $ = id => document.getElementById(id);
  const canvas = $('drawing-canvas');
  const ctx = canvas.getContext('2d');
  const brushNames = {ink:'Pen',flow:'Ink',boil:'Boil',wiggle:'Wiggle',star:'Star',bubble:'Bubble'};
  const paletteColors = {ink:'#111111',flow:'#111111',boil:'#ff0099',wiggle:'#00bfdf',star:'#fff02a',bubble:'#00bfdf'};
  const draftKey = 'live-doodle-draft-v5';
  const materialNames = {crayon:'Natural',pencil:'Fine',marker:'Dissolve'};
  const referenceBrushes = new Set(['ink','boil','wiggle']);
  const defaults = {brush:'ink',color:'#111111',width:12,opacity:1,intensity:.5,speed:1,material:'crayon',texture:.65};
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let doc = LD.validateProject({version:1,width:1060,height:697,background:{color:'#ffffff',image:null,fit:'contain'},strokes:[]});
  let backgroundImage = null;
  let layerImages = new Map();
  let selectedLayerId = doc.activeLayerId;
  let activeBefore = null;
  let activeTransientBefore = false;
  let exportLayerIds = new Set();
  let tool = 'draw';
  let selectedId = null;
  let activeStroke = null;
  let pointerId = null;
  let drag = null;
  let undoStack = [], redoStack = [];
  let playing = false;
  let liveEnabled = true;
  let currentTime = 0, previousFrame = null, lastUiFrame = 0;
  let dirty = true;
  let saveTimer = null, toastTimer = null;
  let fieldSnapshot = null;
  let imageOperation = 0;
  let exportController = null;
  let replacementAction = null;
  let transientInput = false;
  let documentRevision = 0;
  let pointBudget = 6000;
  let ready = false;
  let previewMaterialKey = '';

  const copy = value => JSON.parse(JSON.stringify(value));
  const snapshot = () => JSON.stringify(doc);
  const selected = () => doc.strokes.find(s => s.id === selectedId) || null;
  const editingStyle = () => selected() || defaults;
  const makeId = () => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
  function toast(message) {
    $('toast').textContent = message;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {$('toast').hidden = true;},3800);
  }
  function pushUndo(before) {
    if (before === snapshot()) return;
    undoStack.push(before);
    if (undoStack.length > 35) undoStack.shift();
    redoStack = [];
  }
  function afterChange() {
    documentRevision++;
    transientInput = false;
    dirty = true;
    if(selectedId&&!layers.isEditable(doc,selected()?.layerId))selectedId=null;
    updateUI();
    scheduleSave();
  }
  function commit(change) {
    finishFieldEdit();
    const before=snapshot(),layerId=selectedLayerId,strokeId=selectedId,imagesBefore=new Map(layerImages);
    try{change();LD.validateProject(doc);}
    catch(error){doc=JSON.parse(before);layerImages=imagesBefore;selectedLayerId=layerId;selectedId=strokeId;dirty=true;updateUI();toast(error.message);return false;}
    pushUndo(before);afterChange();return true;
  }
  function scheduleSave() {
    $('save-state').textContent = 'Saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft,500);
  }
  function saveDraft() {
    clearTimeout(saveTimer);
    if (!ready || transientInput || fieldSnapshot!==null) return;
    try {
      localStorage.setItem(draftKey, snapshot());
      $('save-state').textContent = 'Draft saved';
    } catch (_) {
      $('save-state').textContent = 'Draft unavailable. Use Save.';
    }
  }
  function loadImage(data) {
    if (!data) return Promise.resolve(null);
    return new Promise((resolve,reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Cannot read this photo. Try PNG, JPG or WebP.'));
      image.src = data;
    });
  }
  async function installDocument(next, {record = true} = {}) {
    next = LD.validateProject(next);
    const operation = ++imageOperation;
    const revision = documentRevision;
    const [loaded,images] = await Promise.all([loadImage(next.background.image),layers.loadImages(next)]);
    if (operation !== imageOperation) return false;
    if (record && (revision !== documentRevision || pointerId !== null)) {toast('The canvas changed. Open the project again.');return false;}
    if (record) {
      const before = snapshot();
      doc = next;
      pushUndo(before);
    } else doc = next;
    backgroundImage = loaded;layerImages=images;selectedLayerId=doc.activeLayerId;
    selectedId = null; activeStroke = null; pointerId = null; drag = null;
    canvas.width = doc.width; canvas.height = doc.height;
    fitCanvas();
    currentTime = 0;
    afterChange();
    return true;
  }
  async function historyStep(direction) {
    finishFieldEdit();
    if (pointerId !== null || exportController) return;
    const source = direction === 'undo' ? undoStack : redoStack;
    const target = direction === 'undo' ? redoStack : undoStack;
    if (!source.length) return;
    const next = LD.validateProject(JSON.parse(source[source.length-1]));
    const operation = ++imageOperation;
    const revision = documentRevision;
    try {
      const [image,images] = await Promise.all([loadImage(next.background.image),layers.loadImages(next)]);
      if (operation !== imageOperation) return;
      if (revision !== documentRevision || pointerId !== null) {toast('The canvas changed. Try undo or redo again.');return;}
      target.push(snapshot()); source.pop();
      doc = next; backgroundImage = image;layerImages=images;selectedLayerId=doc.activeLayerId; selectedId = null;
      canvas.width=doc.width;canvas.height=doc.height;
      fitCanvas();
      afterChange();
    } catch(error) {toast(error.message);}
  }
  function setTool(next) {
    finishFieldEdit();
    tool = next;
    if (next !== 'select') selectedId = null;
    closeTools();
    dirty = true; updateUI();
  }
  function chooseBrush(brush) {
    finishFieldEdit();
    selectedId = null;
    defaults.brush = brush;
    tool = 'draw'; dirty = true; updateUI();
  }
  function changeStyle(key,value,continuous=false) {
    if(key==='material'&&!Object.hasOwn(materialNames,value))return;
    if(key==='texture') {
      if(!Number.isFinite(value))return;
      value=Math.max(0,Math.min(1,value));
    }
    const stroke = selected();
    if(stroke&&!layers.isEditable(doc,stroke.layerId)){toast('Unlock and show this layer to edit it.');return;}
    if(key==='brush'&&stroke?.referenceArtwork&&!referenceBrushes.has(value)){
      toast('This doodle supports Pen, Boil and Wiggle.');updateSettings();return;
    }
    if (continuous && stroke && fieldSnapshot === null) fieldSnapshot = snapshot();
    if (stroke) {
      if (continuous) {stroke[key]=value;if(key==='material'||key==='texture')LD.invalidateStroke?.(stroke);documentRevision++;dirty=true;updateSettings();}
      else commit(()=>{stroke[key]=value;if(key==='material'||key==='texture')LD.invalidateStroke?.(stroke);});
    } else {
      defaults[key]=value;dirty=true;updateSettings();
    }
  }
  function finishFieldEdit() {
    if (fieldSnapshot !== null) {
      const before = fieldSnapshot;
      fieldSnapshot = null;
      try{LD.validateProject(doc);}catch(error){doc=JSON.parse(before);dirty=true;updateUI();toast(error.message);return;}
      pushUndo(before);afterChange();
    }
  }
  function updateSettings() {
    const style = editingStyle();
    for(const option of $('effect-select').options){
      option.disabled=!!style.referenceArtwork&&!referenceBrushes.has(option.value);
    }
    $('effect-select').value=style.brush;
    $('custom-color').value=style.color;
    $('brush-width').value=style.width;
    $('width-value').textContent=`${Math.round(style.width)} px`;
    $('intensity').value=Math.round(style.intensity*100);
    $('intensity-value').textContent=`${Math.round(style.intensity*100)}%`;
    $('intensity').disabled=style.brush==='ink';
    $('material-select').value=style.material || 'crayon';
    $('texture').value=Math.round((style.texture ?? .65)*100);
    $('texture-value').textContent=`${Math.round((style.texture ?? .65)*100)}%`;
    $('settings-title').textContent=selected()?'Selected stroke':'Pen settings';
    $('selection-label').textContent=style.referenceArtwork?'Pen, Boil or Wiggle':selected()?'Drag to move':'For the next stroke';
    $('selection-actions').hidden=!selected();
    document.querySelectorAll('[data-brush]').forEach(b=>{b.classList.toggle('selected',b.dataset.brush===style.brush);b.setAttribute('aria-pressed',String(b.dataset.brush===style.brush));});
    document.querySelectorAll('[data-color]').forEach(b=>{b.classList.toggle('active',b.dataset.color===style.color);b.setAttribute('aria-pressed',String(b.dataset.color===style.color));});
    document.querySelectorAll('[data-speed]').forEach(b=>{b.classList.toggle('active',Number(b.dataset.speed)===style.speed);b.setAttribute('aria-pressed',String(Number(b.dataset.speed)===style.speed));b.disabled=style.brush==='ink';});
    const materialKey=`${style.material || 'crayon'}:${style.texture ?? .65}`;
    if(materialKey!==previewMaterialKey){previewMaterialKey=materialKey;paintBrushPreviews(style);}
  }
  function updateUI() {
    updateSettings();updateLayerUI();
    document.querySelectorAll('[data-tool]').forEach(b=>{b.classList.toggle('active',b.dataset.tool===tool);b.setAttribute('aria-pressed',String(b.dataset.tool===tool));});
    canvas.dataset.mode=tool;
    $('undo').disabled=!undoStack.length;
    $('redo').disabled=!redoStack.length;
    document.querySelectorAll('[data-paper]').forEach(b=>{b.classList.toggle('active',b.dataset.paper===doc.background.color);b.setAttribute('aria-pressed',String(b.dataset.paper===doc.background.color));});
    $('stroke-count').textContent=`${doc.strokes.length} strokes`;
    $('canvas-hint').textContent=tool==='erase'?'Tap a stroke to erase it.':tool==='select'?'Tap a stroke to select. Drag to move.':'Draw something.';
    const list=$('stroke-list');list.replaceChildren();
    const ordered=layers.orderedStrokes(doc).slice().reverse();
    if(!ordered.length){const hint=document.createElement('p');hint.className='empty-list';hint.textContent='No visible strokes.';list.append(hint);}
    ordered.forEach((stroke,index)=>{
      const button=document.createElement('button');button.className='stroke-row';button.classList.toggle('selected',stroke.id===selectedId);
      button.disabled=!layers.isEditable(doc,stroke.layerId);
      button.style.setProperty('--stroke',stroke.color);button.dataset.strokeId=stroke.id;button.setAttribute('aria-label',`Select stroke ${ordered.length-index}: ${brushNames[stroke.brush]}`);
      const dot=document.createElement('span');dot.className='dot';
      const name=document.createElement('span');name.textContent=brushNames[stroke.brush];
      const number=document.createElement('span');number.className='row-number';number.textContent=String(ordered.length-index).padStart(2,'0');
      button.append(dot,name,number);button.addEventListener('click',()=>{
        if(!layers.isEditable(doc,stroke.layerId))return;
        finishFieldEdit();selectedId=stroke.id;selectedLayerId=layers.rootFor(doc,stroke.layerId)?.id||doc.activeLayerId;doc.activeLayerId=selectedLayerId;tool='select';dirty=true;updateUI();
      });list.append(button);
    });
    updatePlayback();
  }
  function currentLayer(){return layers.find(doc,selectedLayerId)||layers.find(doc,doc.activeLayerId)||doc.layers[doc.layers.length-1]||null;}
  function canChangeLayers(){return ready&&pointerId===null&&!exportController;}
  function selectLayer(id){
    if(!canChangeLayers())return;finishFieldEdit();
    const layer=layers.rootFor(doc,id);if(!layer)return;
    selectedLayerId=layer.id;doc.activeLayerId=layer.id;selectedId=null;
    documentRevision++;dirty=true;updateUI();scheduleSave();
  }
  function updateLayerControls(){
    const layer=currentLayer();
    for(const id of ['layer-name','layer-visible','layer-locked','layer-opacity','duplicate-layer','delete-layer','merge-layer','layer-up','layer-down'])$(id).disabled=!layer;
    if(!layer){$('layer-name').value='';$('image-layer-settings').hidden=true;$('remove-photo').disabled=true;return;}
    if(document.activeElement!==$('layer-name'))$('layer-name').value=layer.name;
    $('layer-visible').checked=layer.visible;$('layer-locked').checked=layer.locked;
    $('layer-opacity').value=Math.round(layer.opacity*100);$('layer-opacity-value').textContent=`${Math.round(layer.opacity*100)}%`;
    const image=layer.kind==='image';$('image-layer-settings').hidden=!image;
    $('remove-photo').disabled=!image;$('photo-fit-label').hidden=!image;
    if(image){
      $('photo-fit').value=layer.fit||'contain';
      $('layer-scale').value=Math.round((layer.transform?.scale||1)*100);$('layer-scale-value').textContent=`${Math.round((layer.transform?.scale||1)*100)}%`;
      if(document.activeElement!==$('layer-x'))$('layer-x').value=layer.transform?.x||0;
      if(document.activeElement!==$('layer-y'))$('layer-y').value=layer.transform?.y||0;
    }
    const index=doc.layers.findIndex(l=>l.id===layer.id);
    $('layer-down').disabled=index<=0;$('layer-up').disabled=index<0||index===doc.layers.length-1;
    $('merge-layer').disabled=index<=0;
  }
  function layerIcon(kind){
    const paths={
      eye:'<path d="M2 11.8c4.3-6.5 8.8-7.8 13.1-4.7 2 1.2 4.1 3.1 6.2 5-4.2 5.6-8.8 7.4-13 4.6C5.8 15.4 3.9 13.8 2 11.8Z"/><path d="M9 11.7c.1-3.9 6.6-3.9 6.1.3-.3 4-6.1 3.9-6.1-.3Z"/>',
      'eye-off':'<path d="M3 9.4c4-3.9 7.5-4.4 11.3-2.3M18.4 9.2 21 12c-3.8 5.4-7.8 6.3-12 4.5M3 3l18 18"/>',
      lock:'<path d="m5 10 14 .3-.2 11-14.1-.5L5 10Z M8 10V6c.4-6 8.4-5.4 8.2.1v4.2 M12 14v3.7"/>',
      unlock:'<path d="m5 10 14 .3-.2 11-14.1-.5L5 10Z M8 10V6c.4-5.7 7.8-5.4 8.3-.7 M12 14v3.7"/>'
    };
    return `<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[kind]}</svg>`;
  }
  function updateLayerUI(){
    if(!layers.find(doc,selectedLayerId))selectedLayerId=doc.activeLayerId;
    const list=$('layer-list');list.replaceChildren();
    doc.layers.slice().reverse().forEach(layer=>{
      const row=document.createElement('div');row.className='layer-row';row.dataset.layerId=layer.id;row.classList.toggle('selected',layer.id===selectedLayerId);
      const choose=document.createElement('button');choose.className='layer-select';choose.setAttribute('aria-pressed',String(layer.id===selectedLayerId));
      const kind=document.createElement('span');kind.className='layer-kind';kind.textContent=layer.kind==='image'?'Image':layer.kind==='group'?'Group':'Draw';
      const title=document.createElement('span');title.className='layer-title';title.textContent=layer.name;
      const meta=document.createElement('span');meta.className='layer-meta';meta.textContent=`${Math.round(layer.opacity*100)}%`;
      choose.append(kind,title,meta);choose.addEventListener('click',()=>selectLayer(layer.id));
      const eye=document.createElement('button');eye.className='layer-eye';eye.innerHTML=layerIcon(layer.visible?'eye':'eye-off');eye.setAttribute('aria-label',`${layer.visible?'Hide':'Show'} ${layer.name}`);eye.setAttribute('aria-pressed',String(layer.visible));
      eye.addEventListener('click',()=>{if(canChangeLayers())commit(()=>{layer.visible=!layer.visible;});});
      const lock=document.createElement('button');lock.className='layer-lock';lock.innerHTML=layerIcon(layer.locked?'lock':'unlock');lock.setAttribute('aria-label',`${layer.locked?'Unlock':'Lock'} ${layer.name}`);lock.setAttribute('aria-pressed',String(layer.locked));
      lock.addEventListener('click',()=>{if(canChangeLayers())commit(()=>{layer.locked=!layer.locked;});});
      row.append(choose,eye,lock);list.append(row);
    });
    updateLayerControls();
  }
  function changeLayer(key,value,continuous=false){
    if(!canChangeLayers())return;const layer=currentLayer();if(!layer)return;
    if(key==='name'){value=String(value).trim().slice(0,80)||'Layer';}
    if(key==='opacity'){if(!Number.isFinite(value))return;value=Math.max(0,Math.min(1,value));}
    if(key==='scale'||key==='x'||key==='y'){
      if(layer.kind!=='image'||!Number.isFinite(value))return;
      value=key==='scale'?Math.max(.25,Math.min(3,value)):Math.max(-4*(key==='x'?doc.width:doc.height),Math.min(5*(key==='x'?doc.width:doc.height),value));
    }
    const change=()=>{if(['scale','x','y'].includes(key))layer.transform={...layer.transform,[key]:value};else layer[key]=value;};
    if(continuous){if(fieldSnapshot===null)fieldSnapshot=snapshot();change();documentRevision++;dirty=true;updateLayerControls();}
    else commit(change);
  }
  function preserveImageCopies(before){
    const byData=new Map(layers.all(before).filter(l=>l.kind==='image').map(l=>[l.image,layerImages.get(l.id)]));
    const next=new Map();for(const layer of layers.all(doc))if(layer.kind==='image'){const image=layerImages.get(layer.id)||byData.get(layer.image);if(image)next.set(layer.id,image);}
    layerImages=next;
  }
  function layerAction(action){
    if(!canChangeLayers())return;
    try{commit(()=>{
      const layer=currentLayer(),before=copy(doc);if(!layer&&action!=='add')return;
      if(action==='add'){
        const node=layers.createPaint(`Drawing ${doc.layers.filter(l=>l.kind==='paint').length+1}`),index=doc.layers.findIndex(l=>l.id===layer?.id);
        doc.layers.splice(index<0?doc.layers.length:index+1,0,node);doc.activeLayerId=node.id;selectedLayerId=node.id;
      }else if(action==='duplicate')selectedLayerId=layers.duplicate(doc,layer.id);
      else if(action==='delete')selectedLayerId=layers.remove(doc,layer.id);
      else if(action==='merge')selectedLayerId=layers.mergeDown(doc,layer.id);
      else if(action==='up'||action==='down'){
        const from=doc.layers.findIndex(l=>l.id===layer.id),to=from+(action==='up'?1:-1);
        if(from>=0&&to>=0&&to<doc.layers.length)[doc.layers[from],doc.layers[to]]=[doc.layers[to],doc.layers[from]];
      }
      selectedId=null;preserveImageCopies(before);
    });}catch(error){toast(error.message);}
  }
  function ensureDrawingLayer(){
    const layer=currentLayer();
    if(!layer){const node=layers.createPaint('Doodles');doc.layers.push(node);doc.activeLayerId=node.id;selectedLayerId=node.id;return node.id;}
    if(layer.kind!=='image'){
      if(!layers.isEditable(doc,layer.id)){toast('Unlock and show this layer to draw.');return null;}
      doc.activeLayerId=layer.id;return layer.id;
    }
    const index=doc.layers.findIndex(l=>l.id===layer.id);
    let target=doc.layers.slice(index+1).find(l=>l.kind!=='image'&&layers.isEditable(doc,l.id));
    if(!target){if(layers.all(doc).length>=layers.LIMITS.nodes){toast('This project has reached its layer limit.');return null;}target=layers.createPaint('Tracing');doc.layers.splice(index+1,0,target);}
    doc.activeLayerId=target.id;toast(`Drawing on ${target.name}.`);return target.id;
  }
  function transformFor(id){
    let found={x:0,y:0,scale:1};
    function visit(nodes,parent){for(const layer of nodes){const local=layer.transform||{x:0,y:0,scale:1},combined={x:parent.x+local.x*parent.scale,y:parent.y+local.y*parent.scale,scale:parent.scale*local.scale};if(layer.id===id){found=combined;return true;}if(visit(layer.children||[],combined))return true;}return false;}
    visit(doc.layers,{x:0,y:0,scale:1});return found;
  }
  function toLayerPoint(point,id){const t=transformFor(id);return {...point,x:Math.max(-4*doc.width,Math.min(5*doc.width,doc.width/2+(point.x-doc.width/2-t.x)/t.scale)),y:Math.max(-4*doc.height,Math.min(5*doc.height,doc.height/2+(point.y-doc.height/2-t.y)/t.scale))};}
  function showLayers(visible){$('layers-panel').hidden=!visible;$('open-layers').setAttribute('aria-expanded',String(visible));}
  $('open-layers').addEventListener('click',()=>{finishFieldEdit();showLayers($('layers-panel').hidden);updateLayerUI();});
  $('layers-close').addEventListener('click',()=>{finishFieldEdit();showLayers(false);});
  for(const [id,action]of [['add-layer','add'],['duplicate-layer','duplicate'],['delete-layer','delete'],['merge-layer','merge'],['layer-up','up'],['layer-down','down']])$(id).addEventListener('click',()=>layerAction(action));
  $('layer-name').addEventListener('input',event=>changeLayer('name',event.target.value,true));
  $('layer-name').addEventListener('change',finishFieldEdit);$('layer-name').addEventListener('blur',finishFieldEdit);
  $('layer-name').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();finishFieldEdit();event.target.blur();}});
  $('layer-visible').addEventListener('change',event=>changeLayer('visible',event.target.checked));
  $('layer-locked').addEventListener('change',event=>changeLayer('locked',event.target.checked));
  for(const [id,key,factor]of [['layer-opacity','opacity',.01],['layer-scale','scale',.01],['layer-x','x',1],['layer-y','y',1]]){
    $(id).addEventListener('input',event=>changeLayer(key,Number(event.target.value)*factor,true));
    $(id).addEventListener('change',finishFieldEdit);$(id).addEventListener('blur',finishFieldEdit);
  }
  function updatePlayback() {
    $('play-label').textContent=playing?'Pause':'Play';
    $('play-pause').setAttribute('aria-label',playing?'Pause animation':'Play animation');
    $('play-icon').innerHTML=playing?'<path d="M7 4v12M13 4v12"/>':'<path d="m6 3 10 7-10 7V3Z"/>';
    $('live-toggle').setAttribute('aria-pressed',String(liveEnabled));
    $('live-toggle').setAttribute('aria-label',liveEnabled?'Live on':'Live off');
    window.InkboxSkin?.refresh();
  }
  function setPlaying(value) {
    playing=!!value;
    if(playing)liveEnabled=true;
    previousFrame=null;updatePlayback();dirty=true;
  }
  function fitCanvas() {
    // Keep the reference paper fixed; older project sizes fit inside it without distortion.
    const paper=$('paper-wrap'),width=paper.clientWidth,height=paper.clientHeight;
    if(!width||!height)return;
    const scale=Math.min(width/doc.width,height/doc.height);
    canvas.style.width=`${doc.width*scale}px`;
    canvas.style.height=`${doc.height*scale}px`;
    canvas.style.position='absolute';canvas.style.left='50%';canvas.style.top='50%';
    canvas.style.transform='translate(-50%,-50%)';
  }
  function closeTools() {if($('tools-dialog').open)$('tools-dialog').close();}
  $('tools-toggle').addEventListener('click',()=>{finishFieldEdit();updateUI();$('tools-dialog').showModal();});
  $('tools-close').addEventListener('click',closeTools);
  $('live-toggle').addEventListener('click',()=>{
    liveEnabled=!liveEnabled;
    if(!liveEnabled){currentTime=0;setPlaying(false);updateTime();}
    else setPlaying(true);
  });
  if(typeof ResizeObserver==='function')new ResizeObserver(fitCanvas).observe($('paper-wrap'));
  window.addEventListener('resize',fitCanvas);
  function position(event) {
    const rect=canvas.getBoundingClientRect();
    return {x:Math.max(0,Math.min(doc.width,(event.clientX-rect.left)*doc.width/rect.width)),y:Math.max(0,Math.min(doc.height,(event.clientY-rect.top)*doc.height/rect.height)),p:event.pointerType==='pen'&&event.pressure>0?event.pressure:.5,t:Math.max(0,event.timeStamp)};
  }
  function addSamples(event) {
    if (!activeStroke) return;
    const merged=event.getCoalescedEvents?event.getCoalescedEvents():[];
    const events=merged.length?merged:[event];
    for (const item of events) {
      if(activeStroke.points.length>=pointBudget)break;
      const point=toLayerPoint(position(item),activeStroke.layerId), last=activeStroke.points[activeStroke.points.length-1];
      if (!last || Math.hypot(point.x-last.x,point.y-last.y)>.65) activeStroke.points.push(point);
    }
    dirty=true;
  }
  canvas.addEventListener('pointerdown',event=>{
    if (!ready || event.button!==0 || pointerId!==null || exportController) return;
    event.preventDefault();finishFieldEdit();
    if(doc.strokes.length>=2000&&tool==='draw'){toast('This page is full. Save it, then start a new page.');return;}
    pointBudget=Math.min(6000,200000-doc.strokes.reduce((sum,stroke)=>sum+stroke.points.length,0));
    if(tool==='draw'&&pointBudget<1){toast('This page is full. Save it, then start a new page.');return;}
    let targetLayerId=null;
    if(tool==='draw'){activeTransientBefore=transientInput;activeBefore=snapshot();targetLayerId=ensureDrawingLayer();if(!targetLayerId){activeBefore=null;return;}}
    pointerId=event.pointerId;canvas.setPointerCapture(pointerId);
    const p=position(event);
    if(tool==='draw') {
      selectedId=null;
      transientInput=true;
      activeStroke={...copy(defaults),id:makeId(),layerId:targetLayerId,points:[toLayerPoint(p,targetLayerId)],seed:Math.floor(Math.random()*2147483647),phase:Math.random(),offset:{x:0,y:0}};
    } else {
      const hit=LD.hitTest(doc,p.x,p.y,12);
      if(tool==='erase') {
        if(hit&&layers.isEditable(doc,doc.strokes.find(s=>s.id===hit)?.layerId))commit(()=>{doc.strokes=doc.strokes.filter(s=>s.id!==hit);selectedId=null;});
      } else {
        selectedId=hit;
        const stroke=selected();
        if(stroke&&layers.isEditable(doc,stroke.layerId)){selectedLayerId=layers.rootFor(doc,stroke.layerId)?.id||doc.activeLayerId;doc.activeLayerId=selectedLayerId;drag={scale:transformFor(stroke.layerId).scale,x:p.x,y:p.y,origin:{...(stroke.offset||{x:0,y:0})},before:snapshot(),moved:false};}else selectedId=null;
        updateUI();
      }
    }
    dirty=true;
  });
  canvas.addEventListener('pointermove',event=>{
    if(event.pointerId!==pointerId)return;
    event.preventDefault();
    if(activeStroke)addSamples(event);
    else if(drag&&selected()) {
      const p=position(event),stroke=selected();
      stroke.offset={x:Math.max(-4*doc.width,Math.min(5*doc.width,drag.origin.x+(p.x-drag.x)/drag.scale)),y:Math.max(-4*doc.height,Math.min(5*doc.height,drag.origin.y+(p.y-drag.y)/drag.scale))};
      drag.moved=drag.moved||Math.hypot(p.x-drag.x,p.y-drag.y)>1;
      dirty=true;
    }
  });
  function finishPointer(event,cancel=false) {
    if(event.pointerId!==pointerId)return;
    if(activeStroke) {
      if(!cancel){addSamples(event);doc.strokes.push(activeStroke);activeStroke=null;pushUndo(activeBefore);afterChange();if(liveEnabled&&!reduced.matches)setPlaying(true);}
      else{activeStroke=null;if(activeBefore)doc=LD.validateProject(JSON.parse(activeBefore));transientInput=activeTransientBefore;updateUI();}
      activeBefore=null;
    }
    if(drag) {
      if(cancel&&selected())selected().offset=drag.origin;
      else if(drag.moved){pushUndo(drag.before);afterChange();}
      drag=null;
    }
    if(canvas.hasPointerCapture(pointerId))canvas.releasePointerCapture(pointerId);
    pointerId=null;dirty=true;
  }
  canvas.addEventListener('pointerup',event=>finishPointer(event));
  canvas.addEventListener('pointercancel',event=>finishPointer(event,true));
  canvas.addEventListener('lostpointercapture',event=>{if(pointerId===event.pointerId)finishPointer(event,true);});

  document.querySelectorAll('[data-brush]').forEach(b=>b.addEventListener('click',()=>chooseBrush(b.dataset.brush)));
  document.querySelectorAll('[data-tool]').forEach(b=>b.addEventListener('click',()=>setTool(b.dataset.tool)));
  document.querySelectorAll('[data-color]').forEach(b=>b.addEventListener('click',()=>changeStyle('color',b.dataset.color)));
  document.querySelectorAll('[data-speed]').forEach(b=>b.addEventListener('click',()=>changeStyle('speed',Number(b.dataset.speed))));
  document.querySelectorAll('[data-paper]').forEach(b=>b.addEventListener('click',()=>commit(()=>{doc.background.color=b.dataset.paper;})));
  $('effect-select').addEventListener('change',event=>changeStyle('brush',event.target.value));
  $('material-select').addEventListener('change',event=>changeStyle('material',event.target.value));
  [['brush-width','width',1],['intensity','intensity',.01],['texture','texture',.01]].forEach(([id,key,factor])=>{
    $(id).addEventListener('input',event=>changeStyle(key,Number(event.target.value)*factor,true));
    $(id).addEventListener('change',finishFieldEdit);$(id).addEventListener('blur',finishFieldEdit);
  });
  $('custom-color').addEventListener('input',event=>changeStyle('color',event.target.value,true));
  $('custom-color').addEventListener('change',finishFieldEdit);
  $('duplicate-stroke').addEventListener('click',()=>{const stroke=selected();if(!stroke||!layers.isEditable(doc,stroke.layerId))return;if(doc.strokes.length>=2000||doc.strokes.reduce((sum,s)=>sum+s.points.length,0)+stroke.points.length>200000){toast('This page is full. Save your project first.');return;}commit(()=>{const duplicate=copy(stroke);duplicate.id=makeId();duplicate.offset={x:Math.min(5*doc.width,(stroke.offset?.x||0)+22),y:Math.min(5*doc.height,(stroke.offset?.y||0)+22)};doc.strokes.push(duplicate);selectedId=duplicate.id;});});
  $('bring-front').addEventListener('click',()=>{const stroke=selected();if(stroke&&layers.isEditable(doc,stroke.layerId))commit(()=>{doc.strokes=doc.strokes.filter(s=>s!==stroke);doc.strokes.push(stroke);});});
  function deleteSelected(){if(selectedId&&layers.isEditable(doc,selected()?.layerId))commit(()=>{doc.strokes=doc.strokes.filter(s=>s.id!==selectedId);selectedId=null;});}
  $('delete-stroke').addEventListener('click',deleteSelected);
  $('undo').addEventListener('click',()=>historyStep('undo'));
  $('redo').addEventListener('click',()=>historyStep('redo'));
  $('play-pause').addEventListener('click',()=>setPlaying(!playing));
  $('timeline').addEventListener('input',event=>{setPlaying(false);currentTime=Math.min(2.999,Number(event.target.value)/1000);dirty=true;updateTime();});
  function updateTime(){if(document.activeElement!==$('timeline'))$('timeline').value=String(Math.round(currentTime*1000));$('time-readout').textContent=`${currentTime.toFixed(2)} / 3s`;}
  $('photo-fit').addEventListener('change',event=>changeLayer('fit',event.target.value));
  $('remove-photo').addEventListener('click',()=>{if(currentLayer()?.kind==='image')layerAction('delete');});
  function requestPhoto(){if(!ready||exportController||pointerId!==null)return;closeTools();finishFieldEdit();$('photo-input').value='';$('photo-input').click();}
  $('import-photo').addEventListener('click',requestPhoto);
  $('layer-import-photo').addEventListener('click',requestPhoto);
  $('photo-input').addEventListener('change',async event=>{
    const file=event.target.files[0];if(!file||!ready||exportController)return;finishFieldEdit();
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)){toast('Choose a PNG, JPG or WebP image.');return;}
    if(file.size>12*1024*1024){toast('Choose an image under 12 MB.');return;}
    const operation=++imageOperation,revision=documentRevision,targetId=currentLayer()?.id;
    try{
      const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Cannot read the image.'));reader.readAsDataURL(file);});
      const image=await loadImage(data);if(operation!==imageOperation)return;
      if(image.width*image.height>40_000_000)throw new Error('This image is too large. Resize it first.');
      const ratio=Math.min(1,1920/Math.max(image.width,image.height));
      const photoCanvas=document.createElement('canvas');photoCanvas.width=Math.round(image.width*ratio);photoCanvas.height=Math.round(image.height*ratio);photoCanvas.getContext('2d').drawImage(image,0,0,photoCanvas.width,photoCanvas.height);
      const normalized=photoCanvas.toDataURL(file.type==='image/png'?'image/png':'image/jpeg',.9);
      const normalizedImage=await loadImage(normalized);if(operation!==imageOperation)return;
      if(revision!==documentRevision||pointerId!==null){toast('The canvas changed. Import the image again.');return;}
      const added=commit(()=>{
        const node=layers.createImage(normalized,(file.name||'Reference image').replace(/\.[^.]+$/,'').slice(0,80));
        const index=doc.layers.findIndex(l=>l.id===targetId);doc.layers.splice(index<0?0:index,0,node);
        layerImages.set(node.id,normalizedImage);doc.activeLayerId=node.id;selectedLayerId=node.id;selectedId=null;
      });
      if(added){showLayers(true);toast('Image added. Draw on the layer above.');}
    }catch(error){if(operation===imageOperation)toast(error.message);}
  });
  $('open-project').addEventListener('click',()=>{closeTools();$('project-input').value='';$('project-input').click();});
  $('project-input').addEventListener('change',async event=>{
    const file=event.target.files[0];if(!file)return;
    const operation=++imageOperation,revision=documentRevision;
    try{const next=await LD.readProject(file);if(operation!==imageOperation)return;if(revision!==documentRevision||pointerId!==null){toast('The canvas changed. Open the project again.');return;}if(await installDocument(next))toast('Project opened.');}catch(error){toast(error.message);}
  });
  $('save-project').addEventListener('click',()=>{finishFieldEdit();try{LD.download(new Blob([LD.serializeProject(doc)],{type:'application/json'}),'inkbox-project.json');toast('Project saved.');}catch(error){toast(error.message);}});
  function askReplace(isSample) {
    closeTools();finishFieldEdit();
    replacementAction=async()=>{
      const sample=LD.sampleScene();
      const next=isSample?sample:{version:1,width:sample.width,height:sample.height,background:{color:sample.background.color,image:null,fit:'contain'},strokes:[]};
      if(await installDocument(next)){setPlaying(false);toast(isSample?'Sample opened. Every doodle is editable.':'New page ready.');}
    };
    $('replace-title').textContent=isSample?'Open the sample?':'Start a new page?';
    $('replace-confirm').textContent=isSample?'Open sample':'New page';
    $('replace-dialog').showModal();
  }
  $('new-page').addEventListener('click',()=>askReplace(false));
  $('load-sample').addEventListener('click',()=>askReplace(true));
  $('replace-cancel').addEventListener('click',()=>{$('replace-dialog').close();replacementAction=null;});
  $('replace-confirm').addEventListener('click',()=>{$('replace-dialog').close();const action=replacementAction;replacementAction=null;action?.().catch(error=>toast(error.message));});

  function updateExportFormat(){
    const format=$('export-format').value;
    $('transparent-row').hidden=format!=='png';
    $('export-note').textContent=format==='png'?'Save the selected layers. Transparent removes the paper; selected images stay.':format==='gif'?'Selected layers, 3-second loop at 12–15 fps. GIF colors may simplify.':'Experimental real-time recording, about 3 seconds. MP4 or WebM depends on your browser. Keep this tab visible. GIF is more reliable.';
  }
  function setExportSelection(includeImages=false){
    exportLayerIds=new Set(doc.layers.filter(layer=>layer.visible&&(includeImages||layer.kind!=='image')).map(layer=>layer.id));renderExportLayers();
  }
  function renderExportLayers(){
    const list=$('export-layer-list');list.replaceChildren();
    doc.layers.slice().reverse().forEach(layer=>{
      const label=document.createElement('label');label.className='export-layer-choice';
      const box=document.createElement('input');box.type='checkbox';box.value=layer.id;box.checked=exportLayerIds.has(layer.id);box.disabled=!!exportController;
      box.addEventListener('change',()=>{if(box.checked)exportLayerIds.add(layer.id);else exportLayerIds.delete(layer.id);$('start-export').disabled=!exportLayerIds.size;});
      const name=document.createElement('span');name.textContent=`${layer.name}${layer.visible?'':' (hidden)'}`;label.append(box,name);list.append(label);
    });
    $('start-export').disabled=!!exportController||!exportLayerIds.size;
  }
  $('export-all-visible').addEventListener('click',()=>{if(!exportController)setExportSelection(true);});
  $('export-doodles').addEventListener('click',()=>{if(!exportController)setExportSelection(false);});
  $('open-export').addEventListener('click',()=>{closeTools();finishFieldEdit();setExportSelection(false);updateExportFormat();$('export-dialog').showModal();});
  $('export-format').addEventListener('change',updateExportFormat);
  $('cancel-export').addEventListener('click',()=>exportController?.abort());
  $('export-dialog').addEventListener('cancel',event=>{if(exportController){event.preventDefault();exportController.abort();}});
  $('export-dialog').addEventListener('close',()=>exportController?.abort());
  $('start-export').addEventListener('click',async()=>{
    if(exportController||!exportLayerIds.size)return;
    exportController=new AbortController();renderExportLayers();
    const wasPlaying=playing;setPlaying(false);
    const format=$('export-format').value;
    $('export-progress-wrap').hidden=false;$('cancel-export').hidden=false;
    $('start-export').disabled=true;$('export-format').disabled=true;$('export-transparent').disabled=true;
    $('export-progress').value=0;$('export-status').textContent='Preparing…';
    try{
      let result;
      const exportDoc=layers.forExport(doc,[...exportLayerIds]);
      if(format==='png')result={blob:await LD.exportPNG(exportDoc,currentTime,{transparent:$('export-transparent').checked,backgroundImage,layerImages}),extension:'png'};
      else result=await LD.exportAnimation(exportDoc,{backgroundImage,layerImages,transparent:false,format,duration:3,fps:format==='gif'?12:30,signal:exportController.signal,onProgress:progress=>{$('export-progress').value=progress;$('export-status').textContent=`${format==='video'?'Recording':'Rendering'} ${Math.round(progress*100)}%`;}});
      if(exportController.signal.aborted)throw new DOMException('Cancelled','AbortError');
      LD.download(result.blob,`inkbox-${format==='png'?'drawing':'loop'}.${result.extension}`);
      $('export-progress').value=1;
      $('export-status').textContent='Done. Your download is ready.';
      toast(`${result.extension.toUpperCase()} exported.`);
    }catch(error){$('export-status').textContent=error.name==='AbortError'?'Cancelled. Try again anytime.':error.message;}
    finally{exportController=null;renderExportLayers();$('start-export').disabled=!exportLayerIds.size;$('export-format').disabled=false;$('export-transparent').disabled=false;$('cancel-export').hidden=true;if(wasPlaying&&!document.hidden)setPlaying(true);}
  });
  document.addEventListener('keydown',event=>{
    if(event.target.matches('input,select,textarea')||document.querySelector('dialog[open]')||pointerId!==null)return;
    const key=event.key.toLowerCase();
    if((event.ctrlKey||event.metaKey)&&key==='z'){event.preventDefault();historyStep(event.shiftKey?'redo':'undo');}
    else if((event.ctrlKey||event.metaKey)&&key==='s'){event.preventDefault();$('save-project').click();}
    else if(event.code==='Space'){event.preventDefault();setPlaying(!playing);}
    else if(!event.ctrlKey&&!event.metaKey&&key==='b')setTool('draw');
    else if(!event.ctrlKey&&!event.metaKey&&key==='v')setTool('select');
    else if(!event.ctrlKey&&!event.metaKey&&key==='e')setTool('erase');
    else if(key==='delete'||key==='backspace'){event.preventDefault();deleteSelected();}
    else if(key==='escape'){selectedId=null;dirty=true;updateUI();}
  });
  document.addEventListener('visibilitychange',()=>{previousFrame=null;if(document.hidden){saveDraft();if(exportController&&$('export-format').value==='video'){exportController.abort();toast('Recording cancelled. Keep this tab visible.');}}});
  window.addEventListener('pagehide',saveDraft);
  reduced.addEventListener('change',()=>{if(reduced.matches)setPlaying(false);});
  function paintBrushPreviews(style=editingStyle()){
    document.querySelectorAll('[data-brush]').forEach(button=>{
      const preview=button.querySelector('canvas.brush-motion-preview');if(!preview)return;
      const previewCtx=preview.getContext('2d'),brush=button.dataset.brush;
      const points=Array.from({length:50},(_,i)=>({x:8+i*2.72,y:18+7*Math.sin(i/49*Math.PI*2),p:.5,t:i*10}));
      const previewDoc={version:1,width:150,height:36,background:{color:'#fffefa',image:null},strokes:[{id:`preview-${brush}`,points,brush,color:paletteColors[brush],width:brush==='star'||brush==='bubble'?10:6,opacity:1,intensity:.5,speed:1,material:style.material || 'crayon',texture:style.texture ?? .65,seed:17,phase:.17,offset:{x:0,y:0}}]};
      LD.drawScene(previewCtx,previewDoc,.8,{transparent:true});
    });
  }
  function frame(now){
    if(!document.hidden){
      if(playing&&previousFrame!==null)currentTime=(currentTime+Math.min(.1,(now-previousFrame)/1000))%3;
      if(playing||dirty){LD.drawScene(ctx,doc,currentTime,{backgroundImage,layerImages,activeStroke,selectedId,selection:!!selectedId});dirty=false;}
      if(now-lastUiFrame>70){updateTime();lastUiFrame=now;}
      previousFrame=now;
    }else previousFrame=null;
    requestAnimationFrame(frame);
  }
  async function start(){
    try {
      await LD.initReferenceArt();
      await installDocument(LD.sampleScene(),{record:false});
    } catch(error) {
      transientInput=true;
      $('save-state').textContent='Reference could not load.';
      toast(error.message || 'Reference could not load. Reload to try again.');
      updateUI();fitCanvas();requestAnimationFrame(frame);
      return;
    }
    try {
      const saved=localStorage.getItem(draftKey);
      if(saved!==null){
        await installDocument(LD.validateProject(JSON.parse(saved)),{record:false});
        $('save-state').textContent='Draft restored';
      }
    }catch(_){$('save-state').textContent='Draft unavailable. Original draft kept.';transientInput=true;}
    setPlaying(false);currentTime=0;updateUI();fitCanvas();requestAnimationFrame(frame);
    ready=true;
    if(!transientInput&&!localStorageSafeHasDraft())scheduleSave();
  }
  function localStorageSafeHasDraft(){try{return localStorage.getItem(draftKey)!==null;}catch(_){return false;}}
  start();
})();
