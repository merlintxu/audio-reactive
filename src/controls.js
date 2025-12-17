const { ipcRenderer } = require("electron");
const $ = (id) => document.getElementById(id);
const ui = {
  startBtn:$("startBtn"), state:$("state"), err:$("err"),
  sens:$("sens"), sensV:$("sensV"),
  nodes:$("nodes"), nodesV:$("nodesV"),
  trail:$("trail"), trailV:$("trailV"),
  bits:$("bits"), bitsV:$("bitsV"),
  mode:$("mode"), modeV:$("modeV"),
  follow:$("follow"), followV:$("followV"),
  burst:$("burst"), burstV:$("burstV"),
  safe:$("safe"), safeV:$("safeV"),
  close:$("close"), closeV:$("closeV"),
  aq:$("aq"), aqV:$("aqV"),
  tf:$("tf"), tfV:$("tfV"),
  fileInput:$("fileInput"), filePlay:$("filePlay"), useMic:$("useMic"),
  player:$("player"), srcPill:$("srcPill"),
  recBtn:$("recBtn"), dl:$("dl"),
  fpsToggle:$("fpsToggle"), qPill:$("qPill"), glPill:$("glPill")
};
const showErr = (m)=>{ ui.err.style.display="block"; ui.err.textContent=m; };
function bindRange(input,out,key,fmt){
  const up=()=>{ const v=parseFloat(input.value); out.textContent=fmt?fmt(v):String(v); ipcRenderer.send("update-param",{key,value:v}); };
  input.addEventListener("input",up); up();
}
bindRange(ui.sens,ui.sensV,"sensitivity",v=>v.toFixed(2));
bindRange(ui.nodes,ui.nodesV,"freeCount",v=>String(Math.round(v)));
bindRange(ui.trail,ui.trailV,"trailAlpha",v=>v.toFixed(3));
bindRange(ui.bits,ui.bitsV,"bits",v=>String(Math.round(v)));
bindRange(ui.follow,ui.followV,"follow",v=>v.toFixed(2));
bindRange(ui.burst,ui.burstV,"burst",v=>v.toFixed(2));
bindRange(ui.safe,ui.safeV,"safe",v=>v.toFixed(2));
bindRange(ui.close,ui.closeV,"close",v=>v.toFixed(2));
bindRange(ui.tf,ui.tfV,"targetFps",v=>String(Math.round(v)));

ui.mode.addEventListener("change",()=>{ ui.modeV.textContent=ui.mode.value; ipcRenderer.send("update-param",{key:"mode",value:ui.mode.value});});
ui.modeV.textContent=ui.mode.value;
ui.aq.addEventListener("change",()=>{ ui.aqV.textContent=ui.aq.value; ipcRenderer.send("update-param",{key:"autoQuality",value:ui.aq.value==="on"});});
ui.aqV.textContent=ui.aq.value;

ui.fpsToggle.addEventListener("change",()=>ipcRenderer.send("update-param",{key:"fpsDebug",value:!!ui.fpsToggle.checked}));

ui.startBtn.addEventListener("click",()=>ipcRenderer.send("audio-cmd",{cmd:"start"}));
ui.useMic.addEventListener("click",()=>ipcRenderer.send("audio-cmd",{cmd:"useMic"}));

ui.fileInput.addEventListener("change",(e)=>{
  const f=e.target.files&&e.target.files[0]; if(!f) return;
  const filePath=f.path;
  ui.player.src = f.path ? `file://${filePath.replace(/\\/g,"/")}` : URL.createObjectURL(f);
  ui.player.loop=true;
  ui.filePlay.disabled=false; ui.filePlay.textContent="▶ Play";
  ipcRenderer.send("audio-cmd",{cmd:"loadFile",path:filePath});
});
ui.filePlay.addEventListener("click",async()=>{
  if(!ui.player.src) return;
  if(ui.player.paused){
    try{ await ui.player.play(); }catch(_){}
    ui.filePlay.textContent="⏸ Pause";
    ipcRenderer.send("audio-cmd",{cmd:"filePlay",playing:true});
  }else{
    ui.player.pause();
    ui.filePlay.textContent="▶ Play";
    ipcRenderer.send("audio-cmd",{cmd:"filePlay",playing:false});
  }
});

ui.recBtn.addEventListener("click",()=>ipcRenderer.send("rec-cmd",{cmd:"toggle"}));

ipcRenderer.on("viz-status",(_evt,p)=>{
  if(p.type==="life"){ ui.state.textContent=p.value; ui.recBtn.disabled=!p.canRecord; }
  if(p.type==="source") ui.srcPill.textContent=p.value;
  if(p.type==="quality") ui.qPill.textContent=p.value;
  if(p.type==="gl") ui.glPill.textContent=p.value;
  if(p.type==="download") ui.dl.innerHTML=p.html;
  if(p.type==="error") showErr(p.message);
});
