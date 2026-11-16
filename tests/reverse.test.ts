import {test} from 'node:test';
import assert from 'node:assert/strict';
import {searchArriveBy,reverseClosure} from '../src/core/reverse';
import {search} from '../src/core/router';
import {defaults,parseHash,shareHash,validateSettings} from '../src/core/settings';
import {journeyFor} from '../src/core/journey';
import {stockholmInstant} from '../src/core/time';
import {graphFromTiles,routeSourceAccess,routeDestinationAccess,type FootpathGraph} from '../src/core/origin-access';
import {incomingEdges,incomingBudgets,incomingIntervals,strokeIncoming} from '../src/core/incoming-walks';
import {choosePointJourney} from '../src/core/point-journey';
import type {Network,Settings,Connection,Walk,WalkingClosureTable} from '../src/core/types';
const date='2026-10-24',deadline=stockholmInstant(date,'09:00');
function net():Network{return {stops:Array.from({length:5},(_,i)=>({id:String(i),name:`Stop ${i}`,station:`Stop ${i}`,platform:'',lat:59,lon:18+i*.001,walkingArea:true})),routes:[{id:'bus',name:'1',mode:'bus'}],connections:[],walks:[],transfers:[]};}
function settings(n:Network,overrides:Partial<Settings>={}):Settings{return {...defaults(n.stops[4]),direction:'arrive',date,time:'09:00',maxMinutes:60,...overrides};}
function c(from:number,to:number,departure:number,arrival:number,trip:string,sequence=0,extra:Partial<Connection>={}):Connection{return {from,to,departure:deadline+departure*60,arrival:deadline+arrival*60,trip,sequence,route:0,pickup:true,dropoff:true,...extra};}

test('arrive-by chooses latest start, charges deadline margin, and decodes a forward itinerary',()=>{
 const n=net();n.connections=[c(0,4,-40,-30,'fast-but-early'),c(0,1,-25,-15,'a',0),c(1,4,-13,-3,'b')];
 const r=searchArriveBy(n,settings(n));
 assert.equal(r.values[0]!.seconds,25*60);assert.equal(r.values[0]!.arrival,deadline-25*60);
 const legs=journeyFor(r,0,n.stops);assert.deepEqual(legs.map(l=>[l.from,l.to]),[[0,1],[1,4]]);
 assert.equal(legs[0].departure,deadline-25*60);assert.equal(legs[1].arrival,deadline-3*60);
 assert.equal(r.values[4]!.seconds,0);
});

test('reverse transfer restrictions retain stop direction and trip/route specificity',()=>{
 const n=net();n.connections=[c(0,1,-30,-20,'a'),c(1,4,-15,-5,'b'),c(0,4,-50,-10,'fallback')];
 n.transfers=[{from:1,to:1,type:3,seconds:0,fromTrip:'a',toTrip:'b',fromRoute:'bus',toRoute:'bus'}];
 assert.equal(searchArriveBy(n,settings(n)).values[0]!.seconds,50*60);
 n.transfers[0]={from:1,to:1,type:2,seconds:6*60};
 assert.equal(searchArriveBy(n,settings(n)).values[0]!.seconds,50*60);
 n.transfers[0].seconds=5*60;
 assert.equal(searchArriveBy(n,settings(n)).values[0]!.seconds,30*60);
});

test('reverse scan respects pickup, dropoff, staying seated and mode/transfer limits',()=>{
 const n=net();n.connections=[c(0,1,-30,-20,'through',0,{dropoff:false}),c(1,4,-19,-5,'through',1,{pickup:false}),c(2,4,-15,-3,'no-board',0,{pickup:false}),c(3,4,-15,-3,'no-alight',0,{dropoff:false})];
 const r=searchArriveBy(n,settings(n,{maxTransfers:0}));assert.equal(r.values[0]!.seconds,1800);assert.equal(r.values[2],null);assert.equal(r.values[3],null);
 assert.equal(journeyFor(r,0)[0].stops.length,3);
 assert.equal(searchArriveBy(n,settings(n,{modes:[]})).values[0],null);
});

test('directed walking and continuous walking budgets are preserved backwards',()=>{
 const n=net();n.connections=[c(1,3,-30,-10,'bus')];
 n.walks=[{from:0,to:1,seconds:300,source:'mapped'},{from:3,to:4,seconds:240,source:'mapped'},{from:4,to:2,seconds:60,source:'mapped'}];
 const r=searchArriveBy(n,settings(n,{walkMinutes:5}),{destinationJourneys:true});
 assert.equal(r.values[0]!.seconds,35*60);assert.equal(r.values[2],null);
 const legs=journeyFor(r,0,n.stops);assert.deepEqual(legs.map(l=>[l.kind,l.from,l.to]),[['walk',0,1],['transit',1,3],['walk',3,4]]);
 assert.ok(legs.every(l=>l.arrival>=l.departure));assert.ok(legs.every((l,i)=>!i||l.departure>=legs[i-1].arrival));
 n.connections=[];n.walks=[{from:0,to:1,seconds:240,source:'mapped'},{from:1,to:4,seconds:240,source:'mapped'}];
 assert.equal(searchArriveBy(n,settings(n,{walkMinutes:5})).values[0],null);
});

test('reverse closure transposes asymmetric distances and directional witnesses',()=>{
 const w:Walk={from:0,to:4,seconds:120,metres:160,source:'mapped'};
 const table:WalkingClosureTable={maxSeconds:1800,pairs:1,begin:s=>s===0?0:1,end:()=>1,destination:()=>4,seconds:()=>120,path:(from,to)=>{assert.equal(from,0);assert.equal(to,4);return [w];}};
 const reversed=reverseClosure(table,5);assert.equal(reversed.end(0)-reversed.begin(0),0);assert.equal(reversed.destination(reversed.begin(4)),0);
 assert.deepEqual(reversed.path(4,0),[{...w,from:4,to:0}]);
 const n=net();n.walks=[w];n.walkingClosure=table;
 assert.deepEqual(searchArriveBy(n,settings(n)).values,searchArriveBy({...n,walkingClosure:undefined},settings(n)).values);
});

test('arrive-by across midnight uses absolute Stockholm time',()=>{
 const n=net(),t=stockholmInstant(date,'00:10');n.connections=[{...c(0,4,0,0,'night'),departure:t-30*60,arrival:t-5*60}];
 const r=searchArriveBy(n,settings(n,{time:'00:10'}));assert.equal(r.values[0]!.seconds,1800);assert.equal(journeyFor(r,0)[0].departure,t-1800);
});

test('reverse results match repeated forward feasibility scans for every latest departure',()=>{
 const n=net();n.walks=[{from:0,to:1,seconds:120,source:'mapped'},{from:3,to:4,seconds:180,source:'mapped'}];
 n.connections=[c(1,2,-43,-30,'a'),c(2,3,-28,-18,'b'),c(0,4,-50,-8,'direct'),c(1,4,-20,-2,'later'),c(1,4,-5,5,'too-late')];
 n.transfers=[{from:2,to:2,type:2,seconds:180}];
 const reverse=searchArriveBy(n,settings(n));
 for(let stop=0;stop<4;stop++){
  let latest:number|undefined;
  for(let minutes=60;minutes>=0;minutes--){
   const t=deadline-minutes*60,clock=new Date(t*1000+2*3600000).toISOString().slice(11,16);
   const forward=search(n,{...settings(n),direction:undefined,stop:String(stop),time:clock},{fixedAnchor:true});
   if(forward.values[4]&&forward.values[4]!.arrival<=deadline)latest=t;
  }
  assert.equal(reverse.values[stop]?.arrival,latest,`stop ${stop}`);
 }
});

test('arrive-by shares roundtrip and old links retain departure semantics',()=>{
 const s=settings(net());assert.deepEqual(parseHash(shareHash(s)),s);const old={...s};delete old.direction;assert.equal(parseHash(shareHash(old))!.direction,undefined);
 assert.throws(()=>validateSettings({...s,direction:'other' as 'arrive'}),/sökriktning/);
});

function graph():FootpathGraph{return graphFromTiles([{schema:1,nodes:[[1,590000000,180000000],[2,590000000,180010000],[3,590000000,180020000]],edges:[[1,2,80,60,1],[2,3,80,60,1]],stops:[[3,'4',0,0,59,18.004]]}],net().stops);}
test('incoming walking bands and partial segments obey one-way paths and access offsets',()=>{
 const g=graph(),n=net(); // Bind explicitly; physical coordinates were checked by the loader.
 g.stops.set(3,[{stop:4,seconds:10,metres:10}]);
 const b=incomingBudgets(g,incomingEdges(g),[{stop:4,seconds:20,walked:30}],120,120);
 assert.equal(b.get(3),80);assert.equal(b.get(2),20);assert.equal(b.has(1),false);
 assert.deepEqual(incomingIntervals(g.segments[0],b),[[1-20/60,1]]);
 const upstream=incomingBudgets(g,incomingEdges(g),[{stop:0,seconds:0,walked:0}],120,120);assert.equal(upstream.has(3),false);
 const anchor={from:1,to:2,t:.5};assert.deepEqual(incomingIntervals(g.segments[0],new Map(),anchor,15),[[.25,.5]]);
 assert.equal(n.stops.length,5);
});

test('hovered reverse origins use forward mapped paths, including point-to-point on one-way edges',()=>{
 const n=net(),g=graph();g.stops.set(3,[{stop:4,seconds:0,metres:0}]);
 const access=routeSourceAccess(g,[59,18.0005],300,{stop:5,lat:59,lon:18.0015,anchor:{from:2,to:3,t:.5}});
 assert.ok(access.walks.some(w=>w.to===5));
 const forbidden=routeSourceAccess(g,[59,18.0015],300,{stop:5,lat:59,lon:18.0005,anchor:{from:1,to:2,t:.5}});
 assert.equal(forbidden.walks.some(w=>w.to===5),false);
 const r=searchArriveBy(n,settings(n,{origin:'point',stop:'@point'}),{destinationJourneys:true,access:{lat:59,lon:18.0015,snapMetres:0,anchor:{from:2,to:3,t:.5},walks:[]}});
 const journey=choosePointJourney(r,settings(n,{origin:'point',stop:'@point'}),n.stops,access)!;
 assert.equal(journey.legs[0].from,6);assert.equal(journey.legs.at(-1)!.to,5);assert.equal(journey.legs.at(-1)!.arrival,deadline);
 assert.deepEqual(routeDestinationAccess(g,[59,18.0005],300).walks,[]);
});

test('incoming path raster clips long roads, bounds its brush and preserves empty space',()=>{
 const field=new Uint8Array(20*12);
 strokeIncoming(field,20,12,[-1e9,6],[1e9,6],30);
 for(let x=0;x<20;x++)assert.equal(field[6*20+x],30);
 assert.ok(field.subarray(0,3*20).every(n=>n===0));
 const before=field.slice();strokeIncoming(field,20,12,[-100,-100],[-50,-50],10);assert.deepEqual(field,before);
 strokeIncoming(field,20,12,[10,4],[10,8],10);assert.equal(field[6*20+10],10);assert.equal(field[6*20],30);
 const zero={from:1,to:2,seconds:0,metres:0,oneway:true};assert.deepEqual(incomingIntervals(zero,new Map([[2,0]])),[[0,1]]);
 assert.deepEqual(incomingIntervals(zero,new Map([[1,0]])),[]);
});

test('reverse transfers between different stops preserve their directed minimum',()=>{
 const n=net();n.connections=[c(0,1,-30,-20,'a'),c(2,4,-14,-2,'b')];
 n.walks=[{from:1,to:2,seconds:180,source:'mapped'}];
 n.transfers=[{from:1,to:2,type:2,seconds:420,fromTrip:'a',toTrip:'b'}];
 assert.equal(searchArriveBy(n,settings(n)).values[0],null);
 n.transfers[0].seconds=360;assert.equal(searchArriveBy(n,settings(n)).values[0]!.seconds,1800);
});
