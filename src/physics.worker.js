// physics.worker.js
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const rand=(a,b)=>a+Math.random()*(b-a);
const dist2=(ax,ay,bx,by)=>{const dx=bx-ax,dy=by-ay;return dx*dx+dy*dy;};
const pairKey=(aId,bId)=>(aId<bId)?(aId+"|"+bId):(bId+"|"+aId);

const STRING_PROFILES = [
  { band:0, stiff:0.022, damp:0.88, follow:0.86, delay:0.00, micro:0.45 },
  { band:1, stiff:0.026, damp:0.84, follow:0.72, delay:0.12, micro:0.55 },
  { band:2, stiff:0.030, damp:0.80, follow:0.58, delay:0.22, micro:0.70 }
];

let S=null;

function convexHull(points){
  if(!points||points.length<3) return points||[];
  const key=p=>((p.x*0.5)|0)+","+((p.y*0.5)|0);
  const map=new Map();
  for(const p of points) map.set(key(p),p);
  const pts=[...map.values()];
  if(pts.length<3) return pts;
  pts.sort((a,b)=>a.x===b.x?a.y-b.y:a.x-b.x);
  const cross=(o,a,b)=>(a.x-o.x)*(b.y-o.y)-(a.y-o.y)*(b.x-o.x);
  const lower=[];
  for(const p of pts){
    while(lower.length>=2 && cross(lower[lower.length-2],lower[lower.length-1],p)<=0) lower.pop();
    lower.push(p);
  }
  const upper=[];
  for(let i=pts.length-1;i>=0;i--){
    const p=pts[i];
    while(upper.length>=2 && cross(upper[upper.length-2],upper[upper.length-1],p)<=0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  const hull=lower.concat(upper);
  return hull.length>=3?hull:pts.slice(0,3);
}
function downsamplePolygon(poly,maxSides){
  if(poly.length<=maxSides) return poly;
  const out=[];
  for(let i=0;i<maxSides;i++) out.push(poly[(i*poly.length/maxSides)|0]);
  return out;
}

function placeStrings(fullReset){
  const { W,H, safe, close } = S.state;
  const left=safe*W, right=(1-safe)*W, span=right-left;
  const cx = left + span*(0.45 + rand(-0.08,0.08));
  const spacing = span*close;
  const xs=[cx-spacing,cx,cx+spacing];

  if(fullReset || !S.strings || S.strings.length!==3){
    S.strings=[];
    for(let si=0;si<3;si++){
      const count = 68 + ((Math.random()*14)|0);
      const pts=[];
      for(let i=0;i<count;i++){
        const y=(i/(count-1))*H;
        pts.push({ id:`s${si}_${i}`, x:xs[si], y, vx:0, phase:Math.random()*Math.PI*2, bin:0 });
      }
      S.strings.push({ x0:xs[si], pts, drift:rand(-1,1), scale:0.92+Math.random()*0.22 });
    }
  }else{
    for(let si=0;si<3;si++){
      const St=S.strings[si];
      const dx=xs[si]-St.x0;
      St.x0=xs[si];
      for(const p of St.pts) p.x+=dx;
    }
  }
}
function makeFree(){
  const { DPR, freeCount } = S.state;
  if(!S.strings || S.strings.length!==3) placeStrings(true);
  S.free=[];
  const n=Math.max(0,(freeCount|0));
  for(let i=0;i<n;i++){
    const si=(Math.random()*3)|0;
    const St=S.strings[si];
    const p=St.pts[(Math.random()*St.pts.length)|0];
    S.free.push({
      id:"f"+i+"_"+Math.random().toString(16).slice(2),
      x:p.x+rand(-22,22)*DPR,
      y:p.y+rand(-44,44)*DPR,
      vx:rand(-0.25,0.25)*DPR,
      vy:rand(-0.25,0.25)*DPR,
      homeS:si,
      homeT:Math.random(),
      attach:1.0,
      tw:Math.random()
    });
  }
}
function resetSim(){
  placeStrings(true);
  makeFree();
  S.burstEnergy=0;
  S.contactMap.clear();
  S.shapes=[];
}

function updateBurst(low){
  const TH=0.28;
  let target=0;
  if(low>TH) target=clamp((low-TH)/0.50,0,1);
  target*=S.state.burst;
  S.burstEnergy=Math.max(target,S.burstEnergy*0.965);
  S.burstEnergy=clamp(S.burstEnergy,0,1);
}
function updateStrings(aud,t){
  const { bins, sBands, high } = aud;
  const B=bins.length;
  const gFollow=clamp(S.state.follow,0,1);
  for(let si=0;si<3;si++){
    const St=S.strings[si], prof=STRING_PROFILES[si], pts=St.pts;
    const e=sBands[si];
    const baseX=St.x0 + Math.sin(t*0.00020*St.drift)*5*S.state.DPR;
    const sway=(10+135*e)*St.scale*S.state.DPR;
    for(let i=0;i<pts.length;i++){
      const p=pts[i];
      const k=i/(pts.length-1);
      const env=Math.sin(Math.PI*k);
      if(i===0||i===pts.length-1){ p.x=baseX; p.vx=0; continue; }
      const bi=Math.min(B-1,(k*B)|0);
      p.bin=lerp(p.bin,bins[bi],0.18+0.22*e);
      const local=p.bin*sway*env*(prof.follow*gFollow);
      const wave=Math.sin(p.phase+t*0.00105+prof.delay+k*3.0);
      const targetX=baseX + local + wave*sway*(1-prof.follow*gFollow)*env;
      const stiff=prof.stiff*(1-0.40*S.burstEnergy);
      const damp =prof.damp *(1-0.18*S.burstEnergy);
      p.vx=(p.vx+(targetX-p.x)*stiff)*damp;
      p.x+=p.vx;
      p.x+=(Math.random()-0.5)*(0.18+2.2*high)*S.state.DPR*env*prof.micro;
    }
  }
}
function updateFree(aud){
  const { high, low } = aud;
  const detach=S.burstEnergy, wantAttach=1-detach;
  const jitter=(0.03+0.38*high)*S.state.DPR;
  const pullBase=(0.0022+0.0065*low)*S.state.DPR;

  for(const n of S.free){
    n.tw=clamp(n.tw+(Math.random()-0.5)*0.05,0,1);
    n.attach=lerp(n.attach,wantAttach,0.045);

    const St=S.strings[n.homeS];
    const idx=clamp(Math.round(n.homeT*(St.pts.length-1)),0,St.pts.length-1);
    const hp=St.pts[idx];

    const pull=pullBase*(0.25+1.70*n.attach);
    n.vx+=(hp.x-n.x)*pull;
    n.vy+=(hp.y-n.y)*(pull*0.10);

    const push=(0.010+0.080*detach)*S.state.DPR;
    n.vx+=(n.x-hp.x)*push;
    n.vy+=(n.y-hp.y)*push*0.12;

    n.vx+=(Math.random()-0.5)*jitter;
    n.vy+=(Math.random()-0.5)*jitter;

    const damp=0.985-0.10*low-0.06*detach;
    n.vx*=damp; n.vy*=damp;

    n.x+=n.vx; n.y+=n.vy;

    const W=S.state.W,H=S.state.H,DPR=S.state.DPR;
    if(n.x<-30*DPR) n.x=W+30*DPR;
    if(n.x> W+30*DPR) n.x=-30*DPR;
    if(n.y<-30*DPR) n.y=H+30*DPR;
    if(n.y> H+30*DPR) n.y=-30*DPR;
  }
}

function accumulateContacts(aud){
  const low=aud.low;
  const DPR=S.state.DPR;
  const HIT_ON=(9+10*low)*DPR;
  const HIT_OFF=HIT_ON*1.55;
  const HIT_ON2=HIT_ON*HIT_ON;
  const HIT_OFF2=HIT_OFF*HIT_OFF;
  const gain=0.09+0.40*low;
  const decay=0.965-0.05*low;

  const touchers=S._touchers;
  const grid=S._contactGrid;
  touchers.length=0;

  const step=S.state.stringStep;
  for(let si=0;si<3;si++){
    const pts=S.strings[si].pts;
    for(let i=0;i<pts.length;i+=step){
      const p=pts[i];
      touchers.push({id:p.id,x:p.x,y:p.y,kind:"string"});
    }
  }
  for(const n of S.free) touchers.push({id:n.id,x:n.x,y:n.y,kind:"free"});

  const cell=Math.max(24*DPR, HIT_OFF*2);
  grid.clear();
  const key=(gx,gy)=>(gx<<16)^gy;

  for(let i=0;i<touchers.length;i++){
    const a=touchers[i];
    const gx=(a.x/cell)|0, gy=(a.y/cell)|0;
    const k=key(gx,gy);
    let arr=grid.get(k);
    if(!arr){arr=[];grid.set(k,arr);}
    arr.push(i);
  }

  for(let i=0;i<touchers.length;i++){
    const a=touchers[i];
    const gx=(a.x/cell)|0, gy=(a.y/cell)|0;

    for(let oy=-1;oy<=1;oy++)for(let ox=-1;ox<=1;ox++){
      const bucket=grid.get(key(gx+ox,gy+oy));
      if(!bucket) continue;
      for(const j of bucket){
        if(j<=i) continue;
        const b=touchers[j];
        if(a.kind==="string" && b.kind==="string") continue;

        const k2=pairKey(a.id,b.id);
        const d2=dist2(a.x,a.y,b.x,b.y);
        const existing=S.contactMap.get(k2);
        if(!existing){ if(d2>HIT_ON2) continue; }
        else { if(d2>HIT_OFF2) continue; }

        const cx=(a.x+b.x)/2, cy=(a.y+b.y)/2;
        const d=Math.sqrt(d2)||1e-6;
        const hitR=existing?HIT_OFF:HIT_ON;

        let c=existing;
        if(!c){ c={life:0,ax:0,ay:0,bx:0,by:0,cx:0,cy:0}; S.contactMap.set(k2,c); }
        c.ax=a.x;c.ay=a.y;c.bx=b.x;c.by=b.y;c.cx=cx;c.cy=cy;
        c.life=clamp(c.life + gain*(1-d/hitR),0,2.0);
      }
    }
  }

  for(const [k,c] of S.contactMap.entries()){
    c.life*=decay;
    if(c.life<0.03) S.contactMap.delete(k);
  }
}

function spawnPolys(aud){
  const low=aud.low;
  if(S.shapes.length>=S.state.maxShapes) return;

  const TH=0.95-0.35*low;
  const CL=(90+90*low)*S.state.DPR;
  const key=(gx,gy)=>(gx<<16)^gy;

  const shapeGrid=S._shapeGrid;
  const shapeKeys=S._shapeKeys;
  shapeGrid.clear(); shapeKeys.length=0;

  for(const c of S.contactMap.values()){
    if(c.life<TH) continue;
    const gx=(c.cx/CL)|0, gy=(c.cy/CL)|0;
    const k=key(gx,gy);
    let arr=shapeGrid.get(k);
    if(!arr){arr=[];shapeGrid.set(k,arr);shapeKeys.push(k);}
    arr.push(c);
  }
  if(!shapeKeys.length) return;

  for(let i=shapeKeys.length-1;i>0;i--){
    const j=(Math.random()*(i+1))|0;
    const tmp=shapeKeys[i]; shapeKeys[i]=shapeKeys[j]; shapeKeys[j]=tmp;
  }

  let spawned=0;
  for(let ki=0;ki<shapeKeys.length && spawned<S.state.maxSpawnPerFrame;ki++){
    const arr=shapeGrid.get(shapeKeys[ki]);
    if(!arr || arr.length<3) continue;

    let poly=convexHull(arr.map(c=>({x:c.cx,y:c.cy})));
    if(poly.length<3) continue;
    const targetSides = 4 + ((Math.random()*3)|0); // 4..6
    poly=downsamplePolygon(poly, targetSides);
    if(poly.length<4) continue;

    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(const p of poly){minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);}
    if(maxX-minX>280*S.state.DPR || maxY-minY>280*S.state.DPR) continue;

    const cx=poly.reduce((s,p)=>s+p.x,0)/poly.length;
    const cy=poly.reduce((s,p)=>s+p.y,0)/poly.length;

    const push=(0.020+0.080*low)*S.state.DPR;
    const spin=rand(-0.28,0.28);

    S.shapes.push({
      pts: poly.map(p=>{
        const ox=p.x-cx, oy=p.y-cy;
        return {x:p.x,y:p.y,vx:ox*push+rand(-0.15,0.15)*S.state.DPR,vy:oy*push+rand(-0.15,0.15)*S.state.DPR};
      }),
      life:1.0,
      cohesion:0.0010+0.0020*low,
      spin
    });

    const consumeR2=(150*S.state.DPR)*(150*S.state.DPR);
    for(const [ck,c] of S.contactMap.entries()){
      if(dist2(c.cx,c.cy,cx,cy)<consumeR2) S.contactMap.delete(ck);
    }
    spawned++;
  }
}
function updateShapes(aud){
  const low=aud.low;
  const W=S.state.W,H=S.state.H,DPR=S.state.DPR;
  for(let i=S.shapes.length-1;i>=0;i--){
    const sh=S.shapes[i];
    sh.life*=(0.985+0.012*low);
    sh.life*=0.985;

    const pts=sh.pts;
    let cx=0,cy=0;
    for(const p of pts){cx+=p.x;cy+=p.y;}
    cx/=pts.length; cy/=pts.length;

    const coh=sh.cohesion*(0.55+0.75*sh.life);

    for(const p of pts){
      p.vx+=(cx-p.x)*coh*DPR;
      p.vy+=(cy-p.y)*coh*DPR;

      const dx=p.x-cx, dy=p.y-cy;
      p.vx+=-dy*sh.spin*0.01;
      p.vy+= dx*sh.spin*0.01;

      p.vx+=(Math.random()-0.5)*0.006*DPR;
      p.vy+=(Math.random()-0.5)*0.006*DPR;

      p.vx*=0.985; p.vy*=0.985;
      p.x+=p.vx; p.y+=p.vy;

      if(p.x<-40*DPR) p.x=W+40*DPR;
      if(p.x> W+40*DPR) p.x=-40*DPR;
      if(p.y<-40*DPR) p.y=H+40*DPR;
      if(p.y> H+40*DPR) p.y=-40*DPR;
    }
    if(sh.life<0.08) S.shapes.splice(i,1);
  }
}

function buildGeometry(aud){
  const low=aud.low;
  const DPR=S.state.DPR;

  const nodes=S._drawNodes;
  nodes.length=0;
  const step=S.state.stringStep;

  for(let si=0;si<3;si++){
    const pts=S.strings[si].pts;
    for(let i=0;i<pts.length;i+=step){
      const p=pts[i];
      nodes.push({x:p.x,y:p.y,isString:true,tw:1});
    }
  }
  for(const n of S.free) nodes.push({x:n.x,y:n.y,isString:false,tw:n.tw});

  const conn=(42+260*S.burstEnergy+40*low)*DPR*S.state.connScale;
  const cell=Math.max(34*DPR, conn*0.65);
  const grid=S._drawGrid;
  grid.clear();
  const key=(gx,gy)=>(gx<<16)^gy;

  for(let i=0;i<nodes.length;i++){
    const a=nodes[i];
    const gx=(a.x/cell)|0, gy=(a.y/cell)|0;
    const k=key(gx,gy);
    let arr=grid.get(k);
    if(!arr){arr=[];grid.set(k,arr);}
    arr.push(i);
  }

  const edgeBase=0.028+0.10*S.burstEnergy+0.05*low;
  const thickness=(0.85+0.85*low+0.65*S.burstEnergy)*DPR;

  const EDGE_BUDGET=S.state.edgeBudget|0;
  const PER_NODE=S.state.edgesPerNode|0;

  const edgeTris=new Float32Array(EDGE_BUDGET*6*3);
  let evi=0, edges=0;

  function pushEdge(ax,ay,bx,by,aAlpha){
    const dx=bx-ax, dy=by-ay;
    const len=Math.hypot(dx,dy)||1e-6;
    const nx=-dy/len, ny=dx/len;
    const w=thickness*(0.65+0.55*aAlpha);
    const ox=nx*w, oy=ny*w;

    const x0=ax+ox,y0=ay+oy;
    const x1=ax-ox,y1=ay-oy;
    const x2=bx+ox,y2=by+oy;
    const x3=bx-ox,y3=by-oy;

    edgeTris[evi++]=x0; edgeTris[evi++]=y0; edgeTris[evi++]=aAlpha;
    edgeTris[evi++]=x2; edgeTris[evi++]=y2; edgeTris[evi++]=aAlpha;
    edgeTris[evi++]=x1; edgeTris[evi++]=y1; edgeTris[evi++]=aAlpha;

    edgeTris[evi++]=x2; edgeTris[evi++]=y2; edgeTris[evi++]=aAlpha;
    edgeTris[evi++]=x3; edgeTris[evi++]=y3; edgeTris[evi++]=aAlpha;
    edgeTris[evi++]=x1; edgeTris[evi++]=y1; edgeTris[evi++]=aAlpha;
  }

  for(let i=0;i<nodes.length && edges<EDGE_BUDGET;i++){
    const a=nodes[i];
    const gx=(a.x/cell)|0, gy=(a.y/cell)|0;
    let per=0;

    for(let oy=-1;oy<=1;oy++)for(let ox=-1;ox<=1;ox++){
      const bucket=grid.get(key(gx+ox,gy+oy));
      if(!bucket) continue;

      for(const j of bucket){
        if(j<=i) continue;
        if(edges>=EDGE_BUDGET || per>=PER_NODE) break;
        const b=nodes[j];

        const dx=b.x-a.x, dy=b.y-a.y;
        const d2=dx*dx+dy*dy;
        if(d2>conn*conn) continue;

        const d=Math.sqrt(d2);
        const c=1-(d/conn);
        let aEdge=edgeBase*(0.22+0.78*c);
        if(a.isString||b.isString) aEdge*=(1.06+0.20*low);
        aEdge=clamp(aEdge,0,0.55);

        pushEdge(a.x,a.y,b.x,b.y,aEdge);
        edges++; per++;
      }
    }
  }

  const pr=(1.35+0.95*low+0.65*S.burstEnergy)*DPR;
  const points=new Float32Array(nodes.length*4);
  let pi=0;
  for(const n of nodes){
    const tw=n.isString?1.0:(0.45+0.55*(n.tw||0.5));
    const alpha=(0.30+0.55*tw)*(0.60+0.65*low+0.55*S.burstEnergy);
    points[pi++]=n.x; points[pi++]=n.y; points[pi++]=pr; points[pi++]=clamp(alpha,0,1);
  }

  const maxDraw=Math.min(S.shapes.length,S.state.maxShapes|0);
  let triCount=0;
  for(let i=0;i<maxDraw;i++){
    const m=S.shapes[i].pts.length;
    triCount += Math.max(0,m-2);
  }
  const polyTris=new Float32Array(triCount*3*3);
  let pvi=0;
  for(let i=0;i<maxDraw;i++){
    const sh=S.shapes[i];
    const aAlpha=clamp((0.05+0.12*S.burstEnergy)*sh.life*(0.6+0.7*low),0,0.25);
    const pts=sh.pts;
    const x0=pts[0].x,y0=pts[0].y;
    for(let k=1;k<pts.length-1;k++){
      const x1=pts[k].x,y1=pts[k].y;
      const x2=pts[k+1].x,y2=pts[k+1].y;
      polyTris[pvi++]=x0; polyTris[pvi++]=y0; polyTris[pvi++]=aAlpha;
      polyTris[pvi++]=x1; polyTris[pvi++]=y1; polyTris[pvi++]=aAlpha;
      polyTris[pvi++]=x2; polyTris[pvi++]=y2; polyTris[pvi++]=aAlpha;
    }
  }

  return { points, edgeTris: edgeTris.subarray(0,evi), polyTris: polyTris.subarray(0,pvi), edgesDrawn: edges };
}

function stepSim(t,aud){
  updateBurst(aud.low);
  updateStrings(aud,t);
  updateFree(aud);
  accumulateContacts(aud);
  spawnPolys(aud);
  updateShapes(aud);
}

onmessage=(e)=>{
  const msg=e.data;
  if(msg.type==="init"){
    S={
      state:{
        W:msg.W,H:msg.H,DPR:msg.DPR,
        safe:msg.state.safe, close:msg.state.close,
        follow:msg.state.follow, burst:msg.state.burst,
        freeCount:msg.state.freeCount,
        stringStep:msg.quality.stringStep|0,
        connScale:msg.quality.connScale,
        edgeBudget:msg.quality.edgeBudget|0,
        edgesPerNode:msg.quality.edgesPerNode|0,
        maxShapes:msg.quality.maxShapes|0,
        maxSpawnPerFrame:msg.quality.maxSpawnPerFrame|0
      },
      strings:[], free:[], shapes:[], burstEnergy:0,
      contactMap:new Map(),
      _touchers:[], _contactGrid:new Map(),
      _drawNodes:[], _drawGrid:new Map(),
      _shapeGrid:new Map(), _shapeKeys:[]
    };
    resetSim();
    postMessage({type:"ready"});
    return;
  }
  if(!S) return;

  if(msg.type==="resize"){ S.state.W=msg.W; S.state.H=msg.H; S.state.DPR=msg.DPR; placeStrings(false); return; }
  if(msg.type==="param"){ const {key,value}=msg; if(key in S.state) S.state[key]=value; return; }
  if(msg.type==="reset"){ resetSim(); return; }

  if(msg.type==="tick"){
    stepSim(msg.t, msg.aud);
    const geo=buildGeometry(msg.aud);
    postMessage({ type:"frame", t:msg.t, edgesDrawn:geo.edgesDrawn, points:geo.points, edgeTris:geo.edgeTris, polyTris:geo.polyTris },
      [geo.points.buffer, geo.edgeTris.buffer, geo.polyTris.buffer]
    );
  }
};
