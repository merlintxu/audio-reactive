const { ipcRenderer } = require("electron");

const LIFECYCLE = Object.freeze({ BOOT:0, READY:1, AUDIO:2, RUN:3 });
let life = LIFECYCLE.BOOT;
const lifeName = (v)=> v===0?"BOOT":v===1?"READY":v===2?"AUDIO":"RUN";
function setLife(v){
  life = Math.max(life, v);
  ipcRenderer.send("viz-status", { type:"life", value: lifeName(life), canRecord: life>=LIFECYCLE.AUDIO });
}
setLife(LIFECYCLE.BOOT);

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;

const canvas = document.getElementById("c");
let gl=null;
let W=0,H=0,DPR=1, fbW=0, fbH=0;

const state = {
  trailAlpha:0.06,
  sensitivity:1.2,
  freeCount:90,
  bits:56,
  mode:"log",
  follow:0.78,
  burst:0.62,
  safe:0.18,
  close:0.14,
  fpsDebug:false,
  autoQuality:true,
  targetFps:60
};
const quality = {
  targetFps:60,
  dprScale:1.0,
  stringStep:2,
  edgeBudget:9000,
  edgesPerNode:22,
  connScale:1.0,
  maxShapes:90,
  maxSpawnPerFrame:2
};
let fpsEMA=60, dtEMA=16.7, lastEdges=0;

/* ===== Audio graph (mic or file) ===== */
let audioCtx=null, analyser=null, masterGain=null, mediaDest=null;
let timeData=null, freqData=null, sampleRate=48000;
let micStream=null, micSource=null;
let fileAudioEl=null, fileSource=null, fileLoaded=false;
let binsBuf=new Float32Array(56);
let logRanges=null, linRanges=null, bandBins=null;

function buildBandBins(){
  const nyq=sampleRate/2;
  const binHz=nyq/freqData.length;
  const toIdx=f=>clamp(Math.floor(f/binHz),0,freqData.length-1);
  bandBins={ low:[toIdx(20),toIdx(180)], mid:[toIdx(180),toIdx(2200)], high:[toIdx(2200),toIdx(12000)],
             s0:[toIdx(25),toIdx(60)], s1:[toIdx(60),toIdx(140)], s2:[toIdx(140),toIdx(280)] };
}
function buildBucketRanges(){
  const B=binsBuf.length;
  linRanges=new Array(B);
  for(let i=0;i<B;i++){
    const a=Math.floor((i/B)*freqData.length);
    const b=Math.floor(((i+1)/B)*freqData.length);
    linRanges[i]=[a,Math.max(a+1,b)];
  }
  const nyq=sampleRate/2, binHz=nyq/freqData.length;
  const fMin=30,fMax=12000;
  const logMin=Math.log(fMin), logMax=Math.log(fMax);
  logRanges=new Array(B);
  for(let i=0;i<B;i++){
    const t0=i/B,t1=(i+1)/B;
    const f0=Math.exp(lerp(logMin,logMax,t0));
    const f1=Math.exp(lerp(logMin,logMax,t1));
    const a=clamp(Math.floor(f0/binHz),0,freqData.length-1);
    const b=clamp(Math.floor(f1/binHz),a+1,freqData.length);
    logRanges[i]=[a,b];
  }
}
function ensureBinsBuffers(){
  const B=Math.max(8,(state.bits|0));
  if(!binsBuf || binsBuf.length!==B) binsBuf=new Float32Array(B);
  if(life>=LIFECYCLE.AUDIO) buildBucketRanges();
}
async function ensureAudioGraph(){
  if(audioCtx) return;
  audioCtx = new (window.AudioContext||window.webkitAudioContext)();
  sampleRate = audioCtx.sampleRate;

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.80;

  masterGain = audioCtx.createGain();
  masterGain.gain.value = 1.0;

  mediaDest = audioCtx.createMediaStreamDestination();

  masterGain.connect(audioCtx.destination);
  masterGain.connect(analyser);
  masterGain.connect(mediaDest);

  timeData = new Uint8Array(analyser.fftSize);
  freqData = new Uint8Array(analyser.frequencyBinCount);

  ensureBinsBuffers();
  buildBandBins();
  buildBucketRanges();

  setLife(LIFECYCLE.AUDIO);
}
async function resumeAudio(){
  await ensureAudioGraph();
  if(audioCtx.state==="suspended") await audioCtx.resume();
  setLife(LIFECYCLE.RUN);
}
async function enableMic(){
  await resumeAudio();
  if(micSource) return;
  try{
    micStream = await navigator.mediaDevices.getUserMedia({ audio:true });
    micSource = audioCtx.createMediaStreamSource(micStream);
    micSource.connect(masterGain);
    ipcRenderer.send("viz-status",{type:"source", value:"Source: Mic"});
  }catch{
    try{ ipcRenderer.send("viz-status",{type:"error", message:"Mic unavailable or permission denied. Use MP3 or enable mic access."}); }catch{}
    return;
  }
}
function attachFile(filePath){
  if(fileSource){ try{fileSource.disconnect();}catch{} fileSource=null; }
  fileLoaded=false;
  if(!fileAudioEl){
    fileAudioEl=document.createElement("audio");
    fileAudioEl.loop=true;
    fileAudioEl.preload="metadata";
  }
  fileAudioEl.src = `file://${filePath.replace(/\\/g,"/")}`;
  ensureAudioGraph().then(()=>{
    try{
      fileSource = audioCtx.createMediaElementSource(fileAudioEl);
      fileSource.connect(masterGain);
      fileLoaded=true;
      ipcRenderer.send("viz-status",{type:"source", value:"Source: MP3 (paused)"});
    }catch(e){
      ipcRenderer.send("viz-status",{type:"error", message:`MediaElementSource failed: ${e?.message||String(e)}. The audio element will still play but may not be routed into the AudioContext.`});
    }
  });
}
async function filePlay(playing){
  await resumeAudio();
  if(!fileLoaded || !fileAudioEl) return;
  if(playing){
    try{ await fileAudioEl.play(); }catch{}
    ipcRenderer.send("viz-status",{type:"source", value:"Source: MP3"});
  }else{
    fileAudioEl.pause();
    ipcRenderer.send("viz-status",{type:"source", value:"Source: MP3 (paused)"});
  }
}
function avgBand(i1,i2){
  let s=0,c=0;
  for(let i=i1;i<=i2;i++){ s+=freqData[i]/255; c++; }
  return clamp(Math.pow((c?s/c:0)*state.sensitivity,0.92),0,1);
}
function getAudio(){
  if(life < LIFECYCLE.AUDIO) return { rms:0, low:0, mid:0, high:0, bins:binsBuf, sBands:new Float32Array([0,0,0]) };

  analyser.getByteTimeDomainData(timeData);
  let sum=0;
  for(let i=0;i<timeData.length;i++){ const v=(timeData[i]-128)/128; sum+=v*v; }
  const rms=clamp(Math.sqrt(sum/timeData.length)*state.sensitivity,0,1);

  analyser.getByteFrequencyData(freqData);
  const low=avgBand(bandBins.low[0],bandBins.low[1]);
  const mid=avgBand(bandBins.mid[0],bandBins.mid[1]);
  const high=avgBand(bandBins.high[0],bandBins.high[1]);
  const sBands=new Float32Array([ avgBand(bandBins.s0[0],bandBins.s0[1]), avgBand(bandBins.s1[0],bandBins.s1[1]), avgBand(bandBins.s2[0],bandBins.s2[1]) ]);

  const ranges = (state.mode==="linear") ? linRanges : logRanges;
  for(let i=0;i<binsBuf.length;i++){
    const [a,b]=ranges[i];
    let s=0,c=0;
    for(let k=a;k<b;k++){ s+=freqData[k]/255; c++; }
    binsBuf[i]=clamp(Math.pow((c?s/c:0)*state.sensitivity,0.92),0,1);
  }
  return { rms, low, mid, high, bins: binsBuf, sBands };
}

/* ===== WebGL: trails (ping-pong FBO) + additive triangles + point sprites ===== */
function assertGL(){
  if(gl) return true;
  gl = canvas.getContext("webgl2",{alpha:false,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false});
  if(!gl){ ipcRenderer.send("viz-status",{type:"gl", value:"GL: WebGL2 unavailable"}); return false; }
  ipcRenderer.send("viz-status",{type:"gl", value:"GL: OK"});
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);
  return true;
}
function compileShader(type,src){
  const sh=gl.createShader(type);
  gl.shaderSource(sh,src); gl.compileShader(sh);
  if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS)){
    const log = gl.getShaderInfoLog(sh) || "shader compile failed";
    try{ ipcRenderer.send("viz-status",{type:"error", message:`Shader compile error: ${log}`}); }catch{}
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}
function createProgram(vsSrc,fsSrc){
  const vs = compileShader(gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl.FRAGMENT_SHADER, fsSrc);
  if(!vs || !fs){ try{ ipcRenderer.send("viz-status",{type:"error", message:"Program creation aborted due to shader compile errors."}); }catch{}
    return null; }
  const p = gl.createProgram();
  gl.attachShader(p,vs); gl.attachShader(p,fs); gl.linkProgram(p);
  gl.deleteShader(vs); gl.deleteShader(fs);
  if(!gl.getProgramParameter(p,gl.LINK_STATUS)){
    const log = gl.getProgramInfoLog(p) || "program link failed";
    try{ ipcRenderer.send("viz-status",{type:"error", message:`Program link error: ${log}`}); }catch{}
    gl.deleteProgram(p);
    return null;
  }
  return p;
}
function createTex(w,h){
  const t=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D,t);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  return t;
}
function createFBO(tex){
  const f=gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER,f);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if(status !== gl.FRAMEBUFFER_COMPLETE){
    try{ ipcRenderer.send("viz-status",{type:"error", message:`FBO incomplete (status=${status})`}); }catch{}
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.deleteFramebuffer(f);
    return null;
  }
  return f;
}

const quadVS=`#version 300 es
in vec2 aPos;
out vec2 vUv;
void main(){ vUv=aPos*0.5+0.5; gl_Position=vec4(aPos,0.0,1.0); }`;
const blitFS=`#version 300 es
precision highp float;
in vec2 vUv; out vec4 frag;
uniform sampler2D uTex; uniform float uDecay;
void main(){ frag = texture(uTex,vUv) * uDecay; }`;
const geoVS=`#version 300 es
precision highp float;
layout(location=0) in vec3 aP; uniform vec2 uRes; out float vA;
void main(){ vec2 ndc=(aP.xy/uRes)*2.0-1.0; ndc.y*=-1.0; gl_Position=vec4(ndc,0.0,1.0); vA=aP.z; }`;
const geoFS=`#version 300 es
precision highp float;
in float vA; out vec4 frag; uniform vec3 uColor;
void main(){ frag=vec4(uColor*vA,1.0); }`;
const ptVS=`#version 300 es
precision highp float;
layout(location=0) in vec2 aQuad;
layout(location=1) in vec4 aPt; // x,y,size,alpha
uniform vec2 uRes; out vec2 vQ; out float vA;
void main(){
  vec2 pos=aPt.xy + aQuad*aPt.z;
  vec2 ndc=(pos/uRes)*2.0-1.0; ndc.y*=-1.0;
  gl_Position=vec4(ndc,0.0,1.0);
  vQ=aQuad; vA=aPt.w;
}`;
const ptFS=`#version 300 es
precision highp float;
in vec2 vQ; in float vA; out vec4 frag; uniform vec3 uColor;
void main(){
  float r=length(vQ);
  float a=smoothstep(1.0,0.0,r);
  a=a*a;
  frag=vec4(uColor*(vA*a),1.0);
}`;

let progBlit=null, progGeo=null, progPt=null;
let vaoQuad=null, vboQuad=null;
let vaoGeo=null, vboGeo=null;
let vaoPoly=null, vboPoly=null;
let vaoPt=null, vboPtQuad=null, vboPt=null;
let fboA=null,texA=null,fboB=null,texB=null, ping=true;

function ensureFBO(){
  const w=Math.max(2,Math.floor(W*quality.dprScale));
  const h=Math.max(2,Math.floor(H*quality.dprScale));
  if(w===fbW && h===fbH && texA && texB) return;
  fbW=w; fbH=h;
  if(fboA){ gl.deleteFramebuffer(fboA); gl.deleteFramebuffer(fboB); gl.deleteTexture(texA); gl.deleteTexture(texB); }
  texA=createTex(fbW,fbH); texB=createTex(fbW,fbH);
  fboA=createFBO(texA); fboB=createFBO(texB);
  if(!fboA || !fboB){
    try{ ipcRenderer.send("viz-status",{type:"error", message:"Failed to create ping-pong FBOs. Trails will be disabled."}); }catch{}
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    return;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER,fboA); gl.viewport(0,0,fbW,fbH); gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER,fboB); gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
}
function initGL(){
  if(!assertGL()) return;
  progBlit=createProgram(quadVS,blitFS);
  progGeo=createProgram(geoVS,geoFS);
  progPt=createProgram(ptVS,ptFS);
  if(!progBlit || !progGeo || !progPt){
    try{ ipcRenderer.send("viz-status",{type:"error", message:"GL program initialization failed. Rendering is disabled."}); }catch{}
    return;
  }

  vaoQuad=gl.createVertexArray();
  vboQuad=gl.createBuffer();
  gl.bindVertexArray(vaoQuad);
  gl.bindBuffer(gl.ARRAY_BUFFER,vboQuad);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1, 1,-1, -1,1, 1,1]),gl.STATIC_DRAW);
  const loc=gl.getAttribLocation(progBlit,"aPos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
  gl.bindVertexArray(null);

  vaoGeo=gl.createVertexArray(); vboGeo=gl.createBuffer();
  gl.bindVertexArray(vaoGeo);
  gl.bindBuffer(gl.ARRAY_BUFFER,vboGeo);
  gl.bufferData(gl.ARRAY_BUFFER,4,gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0,3,gl.FLOAT,false,12,0);
  gl.bindVertexArray(null);

  vaoPoly=gl.createVertexArray(); vboPoly=gl.createBuffer();
  gl.bindVertexArray(vaoPoly);
  gl.bindBuffer(gl.ARRAY_BUFFER,vboPoly);
  gl.bufferData(gl.ARRAY_BUFFER,4,gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0,3,gl.FLOAT,false,12,0);
  gl.bindVertexArray(null);

  vaoPt=gl.createVertexArray();
  vboPtQuad=gl.createBuffer();
  vboPt=gl.createBuffer();
  gl.bindVertexArray(vaoPt);

  gl.bindBuffer(gl.ARRAY_BUFFER,vboPtQuad);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1, 1,-1, -1,1, 1,1]),gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
  gl.vertexAttribDivisor(0,0);

  gl.bindBuffer(gl.ARRAY_BUFFER,vboPt);
  gl.bufferData(gl.ARRAY_BUFFER,4,gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1,4,gl.FLOAT,false,16,0);
  gl.vertexAttribDivisor(1,1);

  gl.bindVertexArray(null);

  ensureFBO();
}
function render(points,edgeTris,polyTris){
  if(!gl) return;
  // if GL programs failed to initialize, skip rendering
  if(!progBlit || !progGeo || !progPt) return;

  ensureFBO();

  // If ping-pong FBOs are unavailable, fall back to direct rendering (no trails)
  if(!texA || !texB || !fboA || !fboB){
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.viewport(0,0,W,H);
    gl.clearColor(0,0,0,1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE,gl.ONE);

    const uResLocGeo = gl.getUniformLocation(progGeo,"uRes");
    const uColorLocGeo = gl.getUniformLocation(progGeo,"uColor");

    if(edgeTris && edgeTris.length){
      gl.useProgram(progGeo);
      gl.uniform2f(uResLocGeo,W,H);
      gl.uniform3f(uColorLocGeo,0.68,0.82,1.0);
      gl.bindVertexArray(vaoGeo);
      gl.bindBuffer(gl.ARRAY_BUFFER,vboGeo);
      gl.bufferData(gl.ARRAY_BUFFER,edgeTris,gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES,0,(edgeTris.length/3)|0);
    }

    if(polyTris && polyTris.length){
      gl.useProgram(progGeo);
      gl.uniform2f(uResLocGeo,W,H);
      gl.uniform3f(uColorLocGeo,0.50,0.68,1.0);
      gl.bindVertexArray(vaoPoly);
      gl.bindBuffer(gl.ARRAY_BUFFER,vboPoly);
      gl.bufferData(gl.ARRAY_BUFFER,polyTris,gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES,0,(polyTris.length/3)|0);
    }

    if(points && points.length){
      gl.useProgram(progPt);
      gl.uniform2f(gl.getUniformLocation(progPt,"uRes"),W,H);
      gl.uniform3f(gl.getUniformLocation(progPt,"uColor"),0.92,0.97,1.0);
      gl.bindVertexArray(vaoPt);
      gl.bindBuffer(gl.ARRAY_BUFFER,vboPt);
      gl.bufferData(gl.ARRAY_BUFFER,points,gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP,0,4,(points.length/4)|0);
    }

    gl.bindVertexArray(null);
    return;
  }

  const srcTex=ping?texA:texB;
  const dstFbo=ping?fboB:fboA;
  ping=!ping;

  gl.bindFramebuffer(gl.FRAMEBUFFER,dstFbo);
  gl.viewport(0,0,fbW,fbH);

  gl.disable(gl.BLEND);
  gl.useProgram(progBlit);
  gl.bindVertexArray(vaoQuad);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D,srcTex);
  gl.uniform1i(gl.getUniformLocation(progBlit,"uTex"),0);
  const decay=1.0-clamp(state.trailAlpha,0.01,0.25);
  gl.uniform1f(gl.getUniformLocation(progBlit,"uDecay"),decay);
  gl.drawArrays(gl.TRIANGLE_STRIP,0,4);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE,gl.ONE);

  const uResLocGeo=gl.getUniformLocation(progGeo,"uRes");
  const uColorLocGeo=gl.getUniformLocation(progGeo,"uColor");

  if(edgeTris && edgeTris.length){
    gl.useProgram(progGeo);
    gl.uniform2f(uResLocGeo,W,H);
    gl.uniform3f(uColorLocGeo,0.68,0.82,1.0);
    gl.bindVertexArray(vaoGeo);
    gl.bindBuffer(gl.ARRAY_BUFFER,vboGeo);
    gl.bufferData(gl.ARRAY_BUFFER,edgeTris,gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES,0,(edgeTris.length/3)|0);
  }

  if(polyTris && polyTris.length){
    gl.useProgram(progGeo);
    gl.uniform2f(uResLocGeo,W,H);
    gl.uniform3f(uColorLocGeo,0.50,0.68,1.0);
    gl.bindVertexArray(vaoPoly);
    gl.bindBuffer(gl.ARRAY_BUFFER,vboPoly);
    gl.bufferData(gl.ARRAY_BUFFER,polyTris,gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES,0,(polyTris.length/3)|0);
  }

  if(points && points.length){
    gl.useProgram(progPt);
    gl.uniform2f(gl.getUniformLocation(progPt,"uRes"),W,H);
    gl.uniform3f(gl.getUniformLocation(progPt,"uColor"),0.92,0.97,1.0);
    gl.bindVertexArray(vaoPt);
    gl.bindBuffer(gl.ARRAY_BUFFER,vboPt);
    gl.bufferData(gl.ARRAY_BUFFER,points,gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP,0,4,(points.length/4)|0);
  }

  gl.bindVertexArray(null);

  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  gl.viewport(0,0,W,H);
  gl.disable(gl.BLEND);
  gl.useProgram(progBlit);
  gl.bindVertexArray(vaoQuad);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, ping?texA:texB);
  gl.uniform1i(gl.getUniformLocation(progBlit,"uTex"),0);
  gl.uniform1f(gl.getUniformLocation(progBlit,"uDecay"),1.0);
  gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
}

/* ===== Worker ===== */
const worker = new Worker("./physics.worker.js");
let workerReady=false;

function postInit(){
  worker.postMessage({
    type:"init",
    W,H,DPR,
    state:{ safe:state.safe, close:state.close, follow:state.follow, burst:state.burst, freeCount:state.freeCount },
    quality:{ stringStep:quality.stringStep, connScale:quality.connScale, edgeBudget:quality.edgeBudget, edgesPerNode:quality.edgesPerNode, maxShapes:quality.maxShapes, maxSpawnPerFrame:quality.maxSpawnPerFrame }
  });
}
worker.onmessage=(e)=>{
  const msg=e.data;
  if(msg.type==="ready"){ workerReady=true; setLife(LIFECYCLE.READY); return; }
  if(msg.type==="frame"){ lastEdges=msg.edgesDrawn|0; render(msg.points,msg.edgeTris,msg.polyTris); }
};

/* ===== Resize + auto-quality ===== */
function resize(){
  DPR=Math.max(1,Math.min(2.5,(window.devicePixelRatio||1)*quality.dprScale));
  W=Math.floor(innerWidth*DPR);
  H=Math.floor(innerHeight*DPR);
  canvas.width=W; canvas.height=H;
  if(gl) gl.viewport(0,0,W,H);
  if(gl) ensureFBO();
  if(workerReady) worker.postMessage({type:"resize",W,H,DPR});
}
addEventListener("resize",resize,{passive:true});

function updateAutoQuality(dt){
  dtEMA=lerp(dtEMA,dt,0.08);
  const fps=1000/Math.max(1e-3,dtEMA);
  fpsEMA=lerp(fpsEMA,fps,0.08);

  if(!state.autoQuality) return;

  const target=quality.targetFps;
  const tooSlow=fpsEMA<(target-8);
  const tooFast=fpsEMA>(target+10);

  if(tooSlow){
    quality.connScale=Math.max(0.72,quality.connScale*0.985);
    quality.edgeBudget=Math.max(2600,(quality.edgeBudget*0.985)|0);
    if(quality.stringStep<4 && fpsEMA<(target-12)) quality.stringStep++;
    if(quality.dprScale>0.72 && fpsEMA<(target-14)){ quality.dprScale=Math.max(0.72,quality.dprScale-0.01); resize(); }
    quality.maxSpawnPerFrame=1;
    quality.maxShapes=Math.max(40,quality.maxShapes-1);
  }else if(tooFast){
    quality.connScale=Math.min(1.12,quality.connScale*1.01);
    quality.edgeBudget=Math.min(16000,(quality.edgeBudget*1.01)|0);
    if(quality.stringStep>2 && fpsEMA>(target+16)) quality.stringStep--;
    if(quality.dprScale<1.0 && fpsEMA>(target+18)){ quality.dprScale=Math.min(1.0,quality.dprScale+0.01); resize(); }
    quality.maxSpawnPerFrame=2;
    quality.maxShapes=Math.min(110,quality.maxShapes+1);
  }

  quality.edgesPerNode=clamp((14+(quality.edgeBudget/1000)|0),14,42);

  if(workerReady){
    worker.postMessage({type:"param",key:"stringStep",value:quality.stringStep|0});
    worker.postMessage({type:"param",key:"connScale",value:quality.connScale});
    worker.postMessage({type:"param",key:"edgeBudget",value:quality.edgeBudget|0});
    worker.postMessage({type:"param",key:"edgesPerNode",value:quality.edgesPerNode|0});
    worker.postMessage({type:"param",key:"maxShapes",value:quality.maxShapes|0});
    worker.postMessage({type:"param",key:"maxSpawnPerFrame",value:quality.maxSpawnPerFrame|0});
  }

  const qStr=`Q: dpr×${quality.dprScale.toFixed(2)} · step${quality.stringStep} · edges ${quality.edgeBudget} · fps ${fpsEMA.toFixed(0)}`;
  ipcRenderer.send("viz-status",{type:"quality", value:qStr});
}

/* ===== Recorder ===== */
let mediaRecorder=null, recordedChunks=[], recording=false;
function bestMime(){
  const c=["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm;codecs=opus","video/webm"];
  return c.find(t=>MediaRecorder.isTypeSupported(t))||"";
}
function sendDownload(blob){
  const url=URL.createObjectURL(blob);
  const ts=new Date().toISOString().replace(/[:.]/g,"-");
  ipcRenderer.send("viz-status",{type:"download", html:`<a href="${url}" download="audio-visual-${ts}.webm">Descargar vídeo</a>`});
}
async function startRecording(){
  await resumeAudio();
  const canvasStream=canvas.captureStream(60);
  const mixed=new MediaStream();
  const v=canvasStream.getVideoTracks()[0];
  if(v) mixed.addTrack(v);
  mediaDest.stream.getAudioTracks().forEach(t=>mixed.addTrack(t));

  recordedChunks=[];
  const mt=bestMime();
  mediaRecorder=new MediaRecorder(mixed, mt?{mimeType:mt}:undefined);
  mediaRecorder.ondataavailable=(ev)=>{ if(ev.data && ev.data.size) recordedChunks.push(ev.data); };
  mediaRecorder.onstop=()=>{ const blob=new Blob(recordedChunks,{type:recordedChunks[0]?.type||"video/webm"}); sendDownload(blob); };
  mediaRecorder.start(200);
  recording=true;
}
function stopRecording(){
  if(mediaRecorder && recording){ recording=false; try{mediaRecorder.stop();}catch{} }
}

/* ===== IPC ===== */
ipcRenderer.on("update-param",(_evt,p)=>{
  if(!p||!p.key) return;
  const {key,value}=p;

  if(key==="sensitivity") state.sensitivity=value;
  else if(key==="freeCount"){ state.freeCount=value; if(workerReady) worker.postMessage({type:"param",key:"freeCount",value:value|0}); worker.postMessage({type:"reset"}); }
  else if(key==="trailAlpha") state.trailAlpha=value;
  else if(key==="bits"){ state.bits=value|0; ensureBinsBuffers(); }
  else if(key==="mode") state.mode=value;
  else if(key==="follow"){ state.follow=value; if(workerReady) worker.postMessage({type:"param",key:"follow",value}); }
  else if(key==="burst"){ state.burst=value; if(workerReady) worker.postMessage({type:"param",key:"burst",value}); }
  else if(key==="safe"){ state.safe=value; if(workerReady) worker.postMessage({type:"param",key:"safe",value}); worker.postMessage({type:"reset"}); }
  else if(key==="close"){ state.close=value; if(workerReady) worker.postMessage({type:"param",key:"close",value}); worker.postMessage({type:"reset"}); }
  else if(key==="fpsDebug") state.fpsDebug=!!value;
  else if(key==="autoQuality") state.autoQuality=!!value;
  else if(key==="targetFps"){ quality.targetFps=value|0; state.targetFps=value|0; }
});

ipcRenderer.on("audio-cmd",async(_evt,p)=>{
  if(!p) return;
  try{
    if(p.cmd==="start"){ await resumeAudio(); await enableMic(); }
    else if(p.cmd==="useMic"){ await enableMic(); }
    else if(p.cmd==="loadFile"){ await resumeAudio(); attachFile(p.path); }
    else if(p.cmd==="filePlay"){ await filePlay(!!p.playing); }
  }catch(e){
    ipcRenderer.send("viz-status",{type:"error", message:e?.message?e.message:String(e)});
  }
});

ipcRenderer.on("rec-cmd",async(_evt,p)=>{
  if(!p) return;
  if(p.cmd==="toggle"){
    if(!recording) await startRecording();
    else stopRecording();
  }
});

/* ===== Boot + Loop ===== */
function boot(){
  ensureBinsBuffers();
  resize();
  initGL();
  postInit();
  setLife(LIFECYCLE.READY);
}
boot();

let last=performance.now();
function tick(now){
  const dt=Math.min(60,now-last);
  last=now;

  updateAutoQuality(dt);

  const aud=getAudio();
  if(workerReady){
    const bins=new Float32Array(aud.bins.length); bins.set(aud.bins);
    const sBands=new Float32Array(3); sBands.set(aud.sBands);
    worker.postMessage({type:"tick", t:now, aud:{rms:aud.rms,low:aud.low,mid:aud.mid,high:aud.high,bins,sBands}}, [bins.buffer, sBands.buffer]);
  }

  if(state.fpsDebug){
    const s=`Q: dpr×${quality.dprScale.toFixed(2)} · step${quality.stringStep} · edges ${quality.edgeBudget} · drawn ${lastEdges} · fps ${fpsEMA.toFixed(0)}`;
    ipcRenderer.send("viz-status",{type:"quality", value:s});
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

addEventListener("keydown",(e)=>{
  if(e.key==="r"||e.key==="R") worker.postMessage({type:"reset"});
  if(e.key==="f"||e.key==="F"){ if(document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); }
});
