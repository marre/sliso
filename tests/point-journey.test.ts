import {test} from 'node:test';import assert from 'node:assert/strict';
import {search} from '../src/core/router';import {defaults} from '../src/core/settings';import {stockholmInstant} from '../src/core/time';
import {choosePointJourney} from '../src/core/point-journey';import {graphFromTiles,routeDestinationAccess} from '../src/core/origin-access';
import type {Network,OriginAccess} from '../src/core/types';
function network():Network{return {stops:Array.from({length:5},(_,i)=>({id:String(i),name:'Stop '+i,lat:59+i*.0001,lon:18,station:String(i),platform:'A',walkingArea:true})),routes:[{id:'bus',name:'1',mode:'bus'}],connections:[],walks:[],transfers:[]};}
test('walk–bus–walk can use a slower stop arrival with a fresh walking budget',()=>{
 const n=network(),s={...defaults(n.stops[0]),origin:'point' as const,stop:'@point',date:'2026-10-23',time:'08:00',walkMinutes:5},t0=stockholmInstant(s.date,s.time);
 n.walks=[{from:0,to:1,seconds:240,metres:320,source:'mapped'}];n.connections=[{from:0,to:1,departure:t0+120,arrival:t0+480,trip:'bus',route:0,sequence:0,pickup:true,dropoff:true}];
 const initial:OriginAccess={lat:59,lon:18,snapMetres:0,walks:[{to:0,seconds:30,metres:40,path:[[59,17.999],[59,18]]}]};
 const r=search(n,s,{access:initial,destinationJourneys:true}),normal=search(n,s,{access:initial});assert.deepEqual(r.values,normal.values);assert.deepEqual(r.walkSources,normal.walkSources);assert.equal(r.values[1]?.seconds,270);
 const final:OriginAccess={lat:59.001,lon:18,snapMetres:0,walks:[{to:1,seconds:180,metres:240,path:[[59.0001,18],[59.001,18]]}]};
 const point=choosePointJourney(r,s,n.stops,final)!;
 assert.equal(point.value.seconds,570);assert.deepEqual(point.legs.map(l=>l.kind),['walk','transit','walk']);assert.equal(point.legs[0].arrival,t0+120);assert.equal(point.legs.at(-1)!.arrival,t0+660);assert.equal(point.legs[0].departure,t0+90);assert.deepEqual(point.legs.at(-1)!.path,final.walks[0].path);
 assert.equal(point.source.walked,0);assert.equal(point.source.boardings,1);assert.equal(point.legs.at(-1)!.to,n.stops.length+1);
 assert.equal(choosePointJourney(r,s,n.stops,final,9),null);assert.equal(choosePointJourney(r,s,n.stops,{...final,walks:[{...final.walks[0],seconds:301}]}),null);
});
test('final walking obeys one-way paths in the direction from the stop to the point',()=>{
 const n=network(),graph=graphFromTiles([{schema:1,nodes:[[0,590000000,180000000],[1,590000000,180010000]],edges:[[0,1,57,43,1]],stops:[[0,'0',0,0,59,18],[1,'1',0,0,n.stops[1].lat,n.stops[1].lon]]}],n.stops);
 const access=routeDestinationAccess(graph,[59,18.0005],300);assert.deepEqual(access.walks.map(w=>w.to),[0]);assert.deepEqual(access.walks[0].path,[[59,18],[59,18.0005]]);
});
test('terminal-state pruning matches unpruned candidates over 60 seeded constrained networks',()=>{
 let seed=217741;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
 for(let sample=0;sample<60;sample++){
  const n=network(),s={...defaults(n.stops[0]),date:'2026-10-23',time:'08:00',maxTransfers:2,walkMinutes:[5,15,30][sample%3]},t0=stockholmInstant(s.date,s.time);
  for(let trip=0;trip<12;trip++){const from=Math.floor(random()*4),to=from+1+Math.floor(random()*(4-from)),departure=t0+Math.floor(random()*1800);n.connections.push({from,to,departure,arrival:departure+30+Math.floor(random()*600),trip:'t'+trip,route:0,sequence:0,pickup:true,dropoff:true});}
  for(let i=0;i<4;i++)if(random()<.7)n.walks.push({from:i,to:i+1,seconds:30+Math.floor(random()*400),source:'mapped',metres:100});
  n.transfers.push({from:1,to:2,type:3,seconds:0,fromTrip:'t0',toTrip:'t1'},{from:2,to:2,type:2,seconds:180});
  const optimized=search(n,s,{destinationJourneys:true}),exhaustive=search(n,s,{destinationJourneys:true,prune:false});
  for(let probe=0;probe<5;probe++){
   const access:OriginAccess={lat:59,lon:18,snapMetres:0,walks:n.stops.map((_,to)=>({to,seconds:Math.floor(random()*1200),metres:100,path:[[59,18],[59.001,18]]}))};
   const a=choosePointJourney(optimized,s,n.stops,access),b=choosePointJourney(exhaustive,s,n.stops,access);
   assert.deepEqual(a?{seconds:a.value.seconds,arrival:a.value.arrival,boardings:a.value.boardings}:null,b?{seconds:b.value.seconds,arrival:b.value.arrival,boardings:b.value.boardings}:null,`sample ${sample} point ${probe}`);
   if(a){assert.equal(a.legs.at(-1)!.arrival,a.value.arrival);assert.equal(a.legs.at(-1)!.arrival-a.legs[0].departure,a.value.seconds);}
  }
 }
});

test('nearby point-to-point walks do not detour via a stop, including mid-edge one-way access',()=>{
 const n=network(),graph=graphFromTiles([{schema:1,nodes:[[0,590000000,180000000],[1,590000000,180100000]],edges:[[0,1,570,430,1]],stops:[[1,'1',0,0,n.stops[1].lat,n.stops[1].lon]]}],n.stops);
 const origin={stop:n.stops.length,lat:59,lon:18.002,anchor:{from:0,to:1,t:.2}};
 const access=routeDestinationAccess(graph,[59,18.003],300,origin),walk=access.walks.find(w=>w.to===n.stops.length)!;
 assert.ok(walk);assert.ok(walk.seconds>=43&&walk.seconds<=44);assert.deepEqual(walk.path,[[59,18.002],[59,18.003]]);
 assert.equal(routeDestinationAccess(graph,[59,18.001],300,origin).walks.some(w=>w.to===n.stops.length),false);
 const s={...defaults(n.stops[0]),origin:'point' as const,stop:'@point',lat:origin.lat,lon:origin.lon,date:'2026-10-23',time:'08:00',walkMinutes:5};
 const r=search(n,s,{access:{...origin,snapMetres:0,walks:[{to:1,seconds:344,metres:456,path:[[59,18.002],[59,18.01]]}]},destinationJourneys:true});
 const point=choosePointJourney(r,s,n.stops,access)!;assert.equal(point.value.seconds,walk.seconds);assert.deepEqual(point.legs.map(l=>l.kind),['walk']);assert.equal(point.legs[0].from,n.stops.length);
});
