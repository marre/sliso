import {test} from 'node:test';
import assert from 'node:assert/strict';
import {graphFromTiles,routeOrigin,routeDestinationAccess,originTileRefs,type FootpathTile} from '../src/core/origin-access';
import {defaults,shareHash,parseHash} from '../src/core/settings';
import {search} from '../src/core/router';
import {journeyFor} from '../src/core/journey';
import {stockholmInstant} from '../src/core/time';
import type {Stop,Network,Manifest,OriginAccess} from '../src/core/types';
const stops:Stop[]=Array.from({length:5},(_,i)=>({id:String(i),name:`Stop ${i}`,lat:59,lon:18+i*.001,station:String(i),platform:'A',walkingArea:true}));
const tile:FootpathTile={schema:1,nodes:[[0,590000000,180000000],[1,590000000,180010000],[2,590010000,180010000],[3,590010000,180000000],[4,590000010,180000000],[5,590000010,179990000]],edges:[[0,1,57,43,0],[1,2,111,84,0],[2,3,57,43,0],[4,5,57,43,0]],stops:[[3,'0',0,0,59,18],[5,'1',0,0,59,18.001]]};
test('mapped access follows a detour and never crosses a nearby disconnected component',()=>{
 const graph=graphFromTiles([tile,tile],stops);assert.equal(graph.segments.length,4);
 const r=routeOrigin(graph,[59,18],300);assert.equal(r.walks.length,1);assert.equal(r.walks[0].seconds,170);assert.equal(r.walks[0].to,0);assert.equal(r.walks[0].path.length,4);
 assert.throws(()=>routeOrigin(graph,[59.02,18],1800),/Ingen kartlagd/);
 assert.deepEqual(routeOrigin(graph,[59,18],100).walks,[]);
});
test('mid-edge origin respects one-way walking and never creates a reverse edge',()=>{
 const t:FootpathTile={...tile,edges:[[0,1,57,43,1]],stops:[[0,'0',0,0,59,18],[1,'1',0,0,59,18.001]]};
 const r=routeOrigin(graphFromTiles([t],stops),[59,18.0005],100);assert.deepEqual(r.walks.map(w=>w.to),[1]);assert.equal(r.walks[0].seconds,22);
});
test('stale coordinates and retired endpoints cannot become access stops',()=>{
 assert.deepEqual(routeOrigin(graphFromTiles([tile],stops.map(s=>({...s,lat:58}))),[59,18],300).walks,[]);
 assert.deepEqual(routeOrigin(graphFromTiles([tile],stops.map(s=>({...s,retired:true}))),[59,18],300).walks,[]);
});
test('tile selection covers boundary crossings without loading unrelated tiles',()=>{
 const a={url:'/data/a.bin',sha256:'a',bytes:1},b={...a,url:'/data/b.bin'},m={footpaths:{format:'sliso-footpaths-v1',tileDegrees:.05,index:{'1180_360':a,'1179_359':b,'1300_400':a}}} as unknown as Manifest;
 assert.deepEqual(originTileRefs(m,[59,18],15),[a,b]);assert.throws(()=>originTileRefs({} as Manifest,[59,18],15),/saknar gångnät/);
});
test('multiple mapped access stops preserve walking budgets, boarding windows and journey geometry',()=>{
 const n:Network={stops,routes:[{id:'bus',name:'1',mode:'bus'}],walks:[{from:0,to:1,seconds:300,source:'mapped',metres:400},{from:1,to:2,seconds:120,source:'mapped',metres:160}],connections:[],transfers:[]};
 const s={...defaults(stops[0]),origin:'point' as const,stop:'@point',date:'2026-10-23',time:'08:00',walkMinutes:5};
 const base=stockholmInstant(s.date,s.time);
 for(const [from,to,dep,arr] of [[0,3,1,2],[0,4,10,15],[1,3,3,5]])n.connections.push({from,to,departure:base+dep*60,arrival:base+arr*60,trip:`t${from}${to}`,route:0,sequence:0,pickup:true,dropoff:true});
 const access:OriginAccess={lat:59,lon:18,snapMetres:0,walks:[{to:0,seconds:120,metres:160,path:[[59,17.999],[59,18]]},{to:1,seconds:240,metres:320,path:[[59,17.999],[59.001,18],[59,18.001]]}]};
 const r=search(n,s,{access});assert.equal(r.values[3],null,'cannot board before arrival');assert.equal(r.values[4]?.seconds,420,'initial waiting excluded but two-minute walk included');assert.equal(r.values[2],null,'access does not reset continuous walking budget');
 const legs=journeyFor(r,4,[...stops,{...stops[0],id:'@point'}]);assert.equal(legs[0].from,stops.length);assert.equal(legs[0].arrival,base+600);assert.equal(legs[0].departure,base+480);assert.deepEqual(legs[0].path,access.walks[0].path);
 assert.deepEqual(parseHash(shareHash(s)),s);assert.throws(()=>search(n,s),/saknas/);
 // Even with precomputed closure, mapped seed walking expands its remaining budget.
 n.walkingClosure={maxSeconds:1800,pairs:2,begin:i=>i===0?0:1,end:i=>i===0?1:i===1?2:1,destination:e=>e===0?1:2,seconds:e=>e===0?300:120,path:(a,b)=>n.walks.filter(w=>w.from===a&&w.to===b)};
 const closure=search(n,{...s,walkMinutes:10},{access}),plain=search({...n,walkingClosure:undefined},{...s,walkMinutes:10},{access});
 assert.deepEqual(closure.values,plain.values);assert.deepEqual(closure.journeys,plain.journeys);
});

test('multi-stop access matches an explicit virtual origin across 80 seeded timetable networks',()=>{
 let seed=92714;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
 for(let sample=0;sample<80;sample++){
  const n:Network={stops,routes:[{id:'bus',name:'1',mode:'bus'}],walks:[],connections:[],transfers:[]};
  const s={...defaults(stops[0]),origin:'point' as const,stop:'@point',date:'2026-10-23',time:'08:00',walkMinutes:[5,15,30][sample%3],maxTransfers:sample%3},base=stockholmInstant(s.date,s.time);
  for(let i=0;i<12;i++){const from=Math.floor(random()*4),to=from+1+Math.floor(random()*(4-from)),departure=base+Math.floor(random()*2400);n.connections.push({from,to,departure,arrival:departure+30+Math.floor(random()*600),trip:`t${i}`,route:0,sequence:0,pickup:true,dropoff:true});}
  for(let i=0;i<4;i++)if(random()<.5)n.walks.push({from:i,to:i+1,seconds:30+Math.floor(random()*700),source:'mapped',metres:100});
  const access:OriginAccess={lat:59,lon:18,snapMetres:0,walks:[0,1,2].map(to=>({to,seconds:Math.floor(random()*1000),metres:100,path:[[59,18],[stops[to].lat,stops[to].lon]]}))};
  const virtual:Network={...n,stops:[...stops,{...stops[0],id:'virtual',walkingArea:false}],walks:[...n.walks,...access.walks.map(w=>({from:stops.length,to:w.to,seconds:w.seconds,metres:w.metres,source:'mapped'}))]};
  const next=search(n,s,{access}),expected=search(virtual,{...s,origin:undefined,stop:'virtual'});
  const objectives=(r:typeof next)=>r.values.slice(0,stops.length).map(v=>v?{seconds:v.seconds,arrival:v.arrival,boardings:v.boardings}:null);
  assert.deepEqual(objectives(next),objectives(expected),`network ${sample}`);
  const sources=(r:typeof next)=>r.walkSources.filter(w=>w.stop<stops.length).sort((a,b)=>a.stop-b.stop||a.seconds-b.seconds||a.walked-b.walked);
  assert.deepEqual(sources(next),sources(expected),`walking sources ${sample}`);
 }
});

test('walk-only origin remains valid when no stop binding is reachable',()=>{
 const graph=graphFromTiles([{schema:1,nodes:[[1,590000000,180000000],[2,590000000,180010000]],edges:[[1,2,80,60,0]],stops:[]}],stops);
 const origin=routeOrigin(graph,[59,18.0002],300);
 assert.deepEqual(origin.walks,[]);
 assert.ok(origin.anchor);
 const target=routeDestinationAccess(graph,[59,18.0008],300,{stop:stops.length,...origin});
 const direct=target.walks.find(w=>w.to===stops.length);
 assert.ok(direct,'the destination can be reached without a transit stop');
 assert.ok(direct.seconds>0&&direct.seconds<=60);
 const settings={...defaults(stops[0]),origin:'point' as const,stop:'@point',walkMinutes:5};
 const result=search({stops,routes:[],connections:[],walks:[],transfers:[]},settings,{access:origin,destinationJourneys:true});
 assert.equal(result.destinationSources?.length,0);
 assert.equal(result.values.filter(Boolean).length,0);
});
