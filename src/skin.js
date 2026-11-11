/* Inkbox v05: original art as the visual skin; all hit areas remain semantic controls. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const image = $('skin-art'), board = $('app-shell');
  const W = 1487, H = 1058;
  const regions = {
    'pen-state': [1104,232,376,668], 'size-state': [26,945,405,85],
    'edge-state': [454,945,400,85], 'palette-state': [880,947,277,74],
    'live-state': [1280,962,81,51], 'play-state': [1392,949,68,66]
  };
  const source = document.createElement('canvas'); source.width = W; source.height = H;
  const src = source.getContext('2d', { willReadFrequently: true });
  let original, queued = false;
  const mobileMedia = window.matchMedia('(max-width:700px)');
  const mobileEntries = [];
  function mobileGroup(className) {
    const group=document.createElement('div');group.className='mobile-layout '+className;board.appendChild(group);return group;
  }
  function croppedArt(parent,rect,className='') {
    const c=document.createElement('canvas');c.width=rect[2];c.height=rect[3];
    c.className='mobile-art '+className;c.setAttribute('aria-hidden','true');parent.appendChild(c);
    mobileEntries.push({canvas:c,rect});return c;
  }
  function moveControl(parent,id,rect) {const control=$(id);parent.appendChild(control);if(rect)croppedArt(control,rect);return control;}
  const mobileHeader=mobileGroup('mobile-header');
  moveControl(mobileHeader,'tools-toggle',[35,18,53,51]);
  croppedArt(mobileHeader,[101,17,170,50],'mobile-logo');
  moveControl(mobileHeader,'undo',[620,96,97,84]);
  moveControl(mobileHeader,'redo',[723,96,97,84]);
  const mobileActions=mobileGroup('mobile-actions');
  [['new-page',[32,98,180,80]],['open-project',[221,98,177,81]],['save-project',[407,96,172,85]],['open-export',[1133,89,338,106]]].forEach(([id,rect])=>moveControl(mobileActions,id,rect));
  moveControl(mobileActions,'import-photo');
  moveControl(mobileActions,'open-layers');
  const mobilePens=mobileGroup('mobile-pens');
  [['ink',[1104,232,376,110]],['flow',[1104,342,376,110]],['boil',[1104,454,376,103]],['wiggle',[1104,554,376,104]],['star',[1104,656,376,113]],['bubble',[1104,765,376,125]]].forEach(([key,rect])=>moveControl(mobilePens,'pen-'+key,rect));
  const mobileColors=mobileGroup('mobile-colors');
  [['Black',[881,950,64,70]],['Pink',[944,950,56,68]],['Cyan',[995,950,56,68]],['Yellow',[1046,950,56,68]],['White',[1099,950,56,68]]].forEach(([name,rect])=>moveControl(mobileColors,'color-'+name,rect));
  const mobileSliders=mobileGroup('mobile-sliders');
  [['brush-width','size-state'],['texture','edge-state']].forEach(([id,key])=>{
    const group=document.createElement('div');group.className='mobile-slider-box';group.dataset.sourceRect=regions[key].join(',');mobileSliders.appendChild(group);
    croppedArt(group,regions[key]);group.appendChild($(id));
  });
  const mobilePlayback=mobileGroup('mobile-playback');
  croppedArt(mobilePlayback,[1191,945,276,85]);
  mobilePlayback.appendChild($('live-toggle'));mobilePlayback.appendChild($('play-pause'));
  function paintMobile() {
    if(!original)return;
    // Reuse the original controls and the same live state patches; no second set of handlers or IDs.
    for(const entry of mobileEntries){
      const c=entry.canvas,ctx=c.getContext('2d'),r=entry.rect;
      ctx.clearRect(0,0,c.width,c.height);ctx.drawImage(image,...r,0,0,r[2],r[3]);
      for(const [key,p] of Object.entries(regions)){
        const x=Math.max(r[0],p[0]),y=Math.max(r[1],p[1]),right=Math.min(r[0]+r[2],p[0]+p[2]),bottom=Math.min(r[1]+r[3],p[1]+p[3]);
        if(right<=x||bottom<=y)continue;
        ctx.drawImage($(key),x-p[0],y-p[1],right-x,bottom-y,x-r[0],y-r[1],right-x,bottom-y);
      }
    }
  }
  mobileMedia.addEventListener('change',()=>schedule());
  const yellow = (r,g,b) => r > 175 && g > 145 && b < 160 && r-b > 65 && g-b > 40;
  const originalAt = (x,y) => ((Math.max(0,Math.min(H-1,y|0))*W)+Math.max(0,Math.min(W-1,x|0)))*4;
  function base(id) {
    const r = regions[id], c = $(id), ctx = c.getContext('2d');
    ctx.clearRect(0,0,c.width,c.height);
    ctx.drawImage(image,...r,0,0,r[2],r[3]);
    return {ctx,r};
  }
  function outsidePaper(data,w,h) {
    // Flood only light background connected to the region edge; enclosed pen bodies stay untouched.
    const seen = new Uint8Array(w*h), queue = new Int32Array(w*h); let first=0,last=0;
    const add = n => {if(n<0||n>=w*h||seen[n])return;const i=n*4;if(data[i]<150||data[i+1]<150||data[i+2]<150)return;seen[n]=1;queue[last++]=n;};
    for(let x=0;x<w;x++){add(x);add((h-1)*w+x);}for(let y=0;y<h;y++){add(y*w);add(y*w+w-1);}
    while(first<last){const n=queue[first++],x=n%w; if(x)add(n-1);if(x<w-1)add(n+1);if(n>=w)add(n-w);if(n<w*(h-1))add(n+w);}
    return seen;
  }
  function penState() {
    const selected = document.querySelector('[data-brush].selected') || document.querySelector('[data-brush][aria-pressed="true"]');
    const brush = selected ? selected.dataset.brush : 'ink';
    const {ctx,r}=base('pen-state'); if(brush==='ink')return;
    const patch=ctx.getImageData(0,0,r[2],r[3]), d=patch.data, pw=r[2];
    for(let y=0;y<112;y++)for(let x=0;x<pw;x++){
      const i=(y*pw+x)*4;if(!yellow(d[i],d[i+1],d[i+2]))continue;
      // Reuse a clean piece of the original toolbox stipple, rather than painting a flat replacement.
      const s=originalAt(1120+((x*7+y*3)%80),880+((y*5+x)%23));
      d[i]=original[s];d[i+1]=original[s+1];d[i+2]=original[s+2];d[i+3]=255;
    }
    const target={flow:[110,108],boil:[222,103],wiggle:[322,104],star:[424,113],bubble:[533,125]}[brush];
    if(target){
      const [start,hh]=target;const local=new Uint8ClampedArray(pw*hh*4);
      for(let y=0;y<hh;y++)local.set(d.subarray((start+y)*pw*4,(start+y+1)*pw*4),y*pw*4);
      const outside=outsidePaper(local,pw,hh);
      for(let y=0;y<hh;y++)for(let x=0;x<pw;x++){
        const s=originalAt(r[0]+x,r[1]+Math.floor(y*108/hh));
        if(!outside[y*pw+x]||!yellow(original[s],original[s+1],original[s+2]))continue;
        const i=((start+y)*pw+x)*4;d[i]=original[s];d[i+1]=original[s+1];d[i+2]=original[s+2];
      }
    }
    ctx.putImageData(patch,0,0);
  }
  function paletteState() {
    const selected=document.querySelector('[data-color].active') || document.querySelector('[data-color][aria-pressed="true"]');
    const color=selected?.dataset.color?.toLowerCase(); const {ctx,r}=base('palette-state');
    if(color==='#111111')return;
    const patch=ctx.getImageData(0,0,r[2],r[3]),d=patch.data,w=r[2];
    for(let y=0;y<74;y++)for(let x=0;x<66;x++){const i=(y*w+x)*4;if(yellow(d[i],d[i+1],d[i+2])){const s=originalAt(1156+(x%8),951+(y%55));d[i]=original[s];d[i+1]=original[s+1];d[i+2]=original[s+2];}}
    const target={'#ff0099':65,'#00bfdf':116,'#fff02a':167,'#ffffff':220}[color];
    if(target!==undefined){
      for(let y=3;y<70;y++)for(let x=0;x<53;x++){
        const s=originalAt(882+Math.floor(x*60/53),950+y-3);
        if(!yellow(original[s],original[s+1],original[s+2]))continue;
        const xx=target+x;if(xx>=w)continue;const i=(y*w+xx)*4;
        // The halo lives outside the original swatch border, preserving its real pigment.
        const outer=x<6||x>47||y<10||y>62;if(!outer)continue;
        d[i]=original[s];d[i+1]=original[s+1];d[i+2]=original[s+2];
      }
    }
    ctx.putImageData(patch,0,0);
  }
  function coordinateFor(value,min,max,anchorValue,left,anchor,right){
    return value<=anchorValue?left+(anchor-left)*(value-min)/(anchorValue-min):anchor+(right-anchor)*(value-anchorValue)/(max-anchorValue);
  }
  function sliderState(id) {
    const size=id==='brush-width', input=$(id), value=Number(input.value);
    const {ctx,r}=base(size?'size-state':'edge-state');
    const initial=size?12:65;if(value===initial)return;
    ctx.save();ctx.translate(-r[0],-r[1]);
    const fillPaper=(x,y,w,h)=>{ctx.drawImage(image,347,951,7,7,x,y,w,h);};
    if(size){
      const cx=coordinateFor(value,Number(input.min),Number(input.max),12,137,199,327);
      fillPaper(182,961,36,53);
      ctx.drawImage(image,221,979,116,24,128,979,209,24);
      ctx.drawImage(image,127,979,12,24,127,979,12,24);
      ctx.drawImage(image,139,984,22,12,137,984,Math.max(0,cx-137),12);
      ctx.drawImage(image,183,962,33,51,cx-16.5,962,33,51);
      fillPaper(362,972,46,31);
      ctx.fillStyle='#111';ctx.font='700 37px InkboxHand';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(String(value),385,989);
    }else{
      const cx=coordinateFor(value,Number(input.min),Number(input.max),65,565,690,757);
      fillPaper(676,963,31,48);
      ctx.drawImage(image,707,978,57,24,562,978,202,24);
      ctx.drawImage(image,560,978,12,24,560,978,12,24);
      ctx.drawImage(image,584,984,24,11,567,984,Math.max(0,cx-567),11);
      ctx.drawImage(image,677,964,28,47,cx-14,964,28,47);
      fillPaper(787,971,45,32);
      ctx.fillStyle='#111';ctx.font='700 37px InkboxHand';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(String(value),809,989);
    }
    ctx.restore();
  }
  function liveState() {
    const {ctx,r}=base('live-state');if($('live-toggle').getAttribute('aria-pressed')!=='false')return;
    ctx.clearRect(0,0,r[2],r[3]);ctx.save();ctx.translate(r[2],0);ctx.scale(-1,1);ctx.drawImage(image,...r,0,0,r[2],r[3]);ctx.restore();
    const patch=ctx.getImageData(0,0,r[2],r[3]);for(let i=0;i<patch.data.length;i+=4)if(yellow(patch.data[i],patch.data[i+1],patch.data[i+2])){patch.data[i]=224;patch.data[i+1]=224;patch.data[i+2]=221;}ctx.putImageData(patch,0,0);
  }
  function playState() {
    const {ctx,r}=base('play-state');const label=$('play-label').textContent.trim().toLowerCase();
    if(label!=='pause')return;
    ctx.save();ctx.translate(-r[0],-r[1]);
    ctx.drawImage(image,1403,961,6,6,1405,960,44,44);
    // Pause bars reuse a vertical black stroke from the source window control.
    ctx.drawImage(image,1367,32,4,17,1414,970,8,29);
    ctx.drawImage(image,1367,32,4,17,1430,970,8,29);
    ctx.restore();
  }
  function refresh(){
    if(!original)return;
    penState();paletteState();sliderState('brush-width');sliderState('texture');liveState();playState();paintMobile();
  }
  function schedule(){if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;refresh();});}
  function bindSlider(id,initial,left,anchor,right){
    const input=$(id);let dragging=false;
    const move=event=>{let x;
      if(mobileMedia.matches){
        const holder=input.closest('.mobile-slider-box'),rect=holder.getBoundingClientRect(),r=holder.dataset.sourceRect.split(',').map(Number);
        const scale=Math.min(rect.width/r[2],rect.height/r[3]),padding=(rect.width-r[2]*scale)/2;
        x=r[0]+(event.clientX-rect.left-padding)/scale;
      }else{const rect=board.getBoundingClientRect();x=(event.clientX-rect.left)*W/rect.width;}
      const min=Number(input.min),max=Number(input.max);
      const value=x<=anchor?min+(initial-min)*(x-left)/(anchor-left):initial+(max-initial)*(x-anchor)/(right-anchor);
      input.value=String(Math.max(min,Math.min(max,Math.round(value))));input.dispatchEvent(new Event('input',{bubbles:true}));schedule();};
    input.addEventListener('pointerdown',event=>{if(event.button!==0)return;event.preventDefault();input.focus({preventScroll:true});dragging=true;input.setPointerCapture(event.pointerId);move(event);});
    input.addEventListener('pointermove',event=>{if(dragging)move(event);});
    const finish=()=>{if(!dragging)return;dragging=false;input.dispatchEvent(new Event('change',{bubbles:true}));};
    input.addEventListener('pointerup',finish);input.addEventListener('pointercancel',finish);input.addEventListener('input',schedule);
  }
  bindSlider('brush-width',12,137,199,327);bindSlider('texture',65,565,690,757);
  const layersPanel=$('layers-panel'), layersHandle=$('layers-drag-handle');
  function hideLayerPanel(){layersPanel.hidden=true;$('open-layers').setAttribute('aria-expanded','false');}
  let layerDrag=null;
  function clampPanelPosition(left,top){
    const rect=layersPanel.getBoundingClientRect();
    layersPanel.style.left=Math.max(8,Math.min(left,window.innerWidth-rect.width-8))+'px';
    layersPanel.style.top=Math.max(8,Math.min(top,window.innerHeight-rect.height-8))+'px';
    layersPanel.style.right='auto';layersPanel.style.bottom='auto';
  }
  layersHandle.addEventListener('pointerdown',event=>{
    if(event.button!==0||event.target.closest('button,input,select'))return;
    event.preventDefault();const rect=layersPanel.getBoundingClientRect();
    layerDrag={x:event.clientX,y:event.clientY,left:rect.left,top:rect.top};
    layersHandle.setPointerCapture(event.pointerId);layersHandle.classList.add('is-dragging');
  });
  layersHandle.addEventListener('pointermove',event=>{if(layerDrag)clampPanelPosition(layerDrag.left+event.clientX-layerDrag.x,layerDrag.top+event.clientY-layerDrag.y);});
  const finishLayerDrag=()=>{layerDrag=null;layersHandle.classList.remove('is-dragging');};
  layersHandle.addEventListener('pointerup',finishLayerDrag);layersHandle.addEventListener('pointercancel',finishLayerDrag);
  mobileMedia.addEventListener('change',()=>{finishLayerDrag();for(const key of ['left','right','top','bottom'])layersPanel.style[key]='';});
  window.addEventListener('resize',()=>{if(!layersPanel.hidden&&layersPanel.style.left){const rect=layersPanel.getBoundingClientRect();clampPanelPosition(rect.left,rect.top);}});
  const observer=new MutationObserver(schedule);
  observer.observe(board,{subtree:true,attributes:true,attributeFilter:['class','aria-pressed'],childList:true,characterData:true});
  $('window-minimize').addEventListener('click',()=>{const minimized=board.classList.toggle('is-minimized');if(minimized)hideLayerPanel();$('window-minimize').setAttribute('aria-pressed',String(minimized));$('window-minimize').setAttribute('aria-label',minimized?'Restore window':'Minimize window');$('window-minimize').title=minimized?'Restore window':'Minimize window';});
  $('window-maximize').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch(_){board.classList.remove('is-minimized');}});
  document.addEventListener('fullscreenchange',()=>{$('window-maximize').setAttribute('aria-pressed',String(!!document.fullscreenElement));});
  $('window-close').addEventListener('click',()=>$('close-dialog').showModal());
  $('close-cancel').addEventListener('click',()=>$('close-dialog').close());
  $('close-confirm').addEventListener('click',()=>{$('close-dialog').close();hideLayerPanel();board.hidden=true;$('restore-window').hidden=false;$('restore-window').focus();});
  $('restore-window').addEventListener('click',()=>{board.hidden=false;board.classList.remove('is-minimized');$('restore-window').hidden=true;$('window-minimize').setAttribute('aria-pressed','false');$('tools-toggle').focus();});
  const ready=new Promise((resolve,reject)=>{
    function loaded(){try{src.drawImage(image,0,0,W,H);original=src.getImageData(0,0,W,H).data;refresh();resolve();}catch(error){reject(error);}}
    if(image.complete&&image.naturalWidth)loaded();else{image.addEventListener('load',loaded,{once:true});image.addEventListener('error',()=>reject(new Error('The interface image could not be loaded.')),{once:true});}
  });
  ready.catch(error=>{console.error(error);});
  if(document.fonts)document.fonts.load('700 37px InkboxHand').then(schedule);
  window.InkboxSkin={ready,refresh,referenceRegion:Object.freeze({x:22,y:212,width:1060,height:697})};
})();
