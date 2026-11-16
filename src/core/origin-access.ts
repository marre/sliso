import {verified} from './data';
import {isPublicStop} from './stops';
import type {DirectWalkingCoverage,DirectWalkingSegment,FileRef,Manifest,OriginAccess,Settings,Stop} from './types';

type Point=[number,number]; // latitude, longitude
export interface FootpathTile {schema:1;nodes:number[][];edges:number[][];stops:(number|string)[][]}
export interface FootpathGraph {nodes:Map<number,Point>;edges:Map<number,{to:number;seconds:number;metres:number}[]>;stops:Map<number,{stop:number;seconds:number;metres:number}[]>;segments:{from:number;to:number;seconds:number;metres:number;oneway:boolean}[]}
const SPEED=80/60, METRES=111195;
export function project(point:Point,a:Point,b:Point) {
  const scale=Math.cos(point[0]*Math.PI/180),x=(b[1]-a[1])*scale,y=b[0]-a[0];
  const t=x*x+y*y?Math.max(0,Math.min(1,((point[1]-a[1])*scale*x+(point[0]-a[0])*y)/(x*x+y*y))):0;
  const p:Point=[a[0]+t*y,a[1]+t*(b[1]-a[1])];
  return {t,point:p,metres:Math.hypot((p[1]-point[1])*scale,p[0]-point[0])*METRES};
}
export function graphFromTiles(tiles:FootpathTile[],stops:Stop[]):FootpathGraph {
  const graph:FootpathGraph={nodes:new Map(),edges:new Map(),stops:new Map(),segments:[]};
  const ids=new Map(stops.map((s,i)=>[s.id,i])),seen=new Set<string>(),bound=new Set<string>();
  for(const tile of tiles){
    if(tile.schema!==1)throw new Error('Gångnätets format stöds inte.');
    for(const [id,lat,lon] of tile.nodes)graph.nodes.set(id,[lat/1e7,lon/1e7]);
    for(const [from,to,metres,seconds,oneway] of tile.edges){
      const key=`${from}:${to}:${oneway}`;if(seen.has(key))continue;seen.add(key);
      if(!Number.isFinite(seconds)||seconds<0||!Number.isFinite(metres)||metres<0)throw new Error('Gångnätet är skadat.');
      graph.segments.push({from,to,seconds,metres,oneway:!!oneway});
      const add=(a:number,b:number)=>{const row=graph.edges.get(a)??[];row.push({to:b,seconds,metres});graph.edges.set(a,row);};
      add(from,to);if(!oneway)add(to,from);
    }
    for(const [node,sid,seconds,metres,lat,lon] of tile.stops){
      const stop=ids.get(String(sid));if(stop===undefined||!isPublicStop(stops[stop])||bound.has(String(sid)))continue;
      // Refuse stale stop bindings after a timetable changes its coordinates.
      if(Math.abs(stops[stop].lat-Number(lat))>1e-6||Math.abs(stops[stop].lon-Number(lon))>1e-6)continue;
      const row=graph.stops.get(Number(node))??[];row.push({stop,seconds:Number(seconds),metres:Number(metres)});graph.stops.set(Number(node),row);bound.add(String(sid));
    }
  }
  for(const edge of graph.segments)if(!graph.nodes.has(edge.from)||!graph.nodes.has(edge.to))throw new Error('Gångnätet saknar en vägpunkt.');
  return graph;
}

/** Bounded Dijkstra on mapped edges. Projection chooses a path start, never an off-network link. */
export function routeOrigin(graph:FootpathGraph,point:Point,maxSeconds:number):OriginAccess {return routeAccess(graph,point,maxSeconds,false,undefined,true);}
export function routeDestinationAccess(graph:FootpathGraph,point:Point,maxSeconds:number,origin?:{stop:number;lat:number;lon:number;anchor?:OriginAccess['anchor']}):OriginAccess {return routeAccess(graph,point,maxSeconds,true,origin);}
export function routeSourceAccess(graph:FootpathGraph,point:Point,maxSeconds:number,destination?:{stop:number;lat:number;lon:number;anchor?:OriginAccess['anchor']}):OriginAccess {return routeAccess(graph,point,maxSeconds,false,destination);}
function routeAccess(graph:FootpathGraph,point:Point,maxSeconds:number,reverse:boolean,origin?:{stop:number;lat:number;lon:number;anchor?:OriginAccess['anchor']},includeDirect=false):OriginAccess {
  let nearest:{edge:FootpathGraph['segments'][number];t:number;point:Point;metres:number}|undefined;
  for(const edge of graph.segments){const snap=project(point,graph.nodes.get(edge.from)!,graph.nodes.get(edge.to)!);if(!nearest||snap.metres<nearest.metres)nearest={edge,...snap};}
  if(!nearest||nearest.metres>25)throw new Error('Ingen kartlagd gångväg inom 25 meter. Välj en punkt på en gångväg eller gata i kartan.');
  const snap=nearest,dist=new Map<number,number>(),length=new Map<number,number>(),prev=new Map<number,number>(),heap:{node:number;cost:number}[]=[];
  function push(node:number,cost:number,metres:number,previous?:number){
    if(cost>maxSeconds||cost>=(dist.get(node)??Infinity))return;
    dist.set(node,cost);length.set(node,metres);if(previous!==undefined)prev.set(node,previous);
    const item={node,cost};let i=heap.length;heap.push(item);
    while(i){const p=(i-1)>>1;if(heap[p].cost<=cost)break;heap[i]=heap[p];i=p;}heap[i]=item;
  }
  function pop(){const first=heap[0],last=heap.pop()!;if(heap.length){let i=0;while(i*2+1<heap.length){let c=i*2+1;if(c+1<heap.length&&heap[c+1].cost<heap[c].cost)c++;if(heap[c].cost>=last.cost)break;heap[i]=heap[c];i=c;}heap[i]=last;}return first;}
  let adjacency=graph.edges;
  if(reverse){adjacency=new Map();for(const [from,edges] of graph.edges)for(const edge of edges){const row=adjacency.get(edge.to)??[];row.push({...edge,to:from});adjacency.set(edge.to,row);}}
  // Reverse routing reaches the target along the permitted forward direction.
  if(reverse||!snap.edge.oneway||snap.t===0)push(snap.edge.from,snap.edge.seconds*snap.t,snap.edge.metres*snap.t);
  if(!reverse||!snap.edge.oneway||snap.t===1)push(snap.edge.to,snap.edge.seconds*(1-snap.t),snap.edge.metres*(1-snap.t));
  while(heap.length){const {node,cost}=pop();if(cost!==dist.get(node))continue;for(const edge of adjacency.get(node)??[])push(edge.to,cost+edge.seconds,length.get(node)!+edge.metres,node);}
  const reached=new Map<number,OriginAccess['walks'][number]>();
  for(const [node,bindings] of graph.stops){
    const cost=dist.get(node);if(cost===undefined)continue;
    for(const binding of bindings){
      const seconds=Math.ceil(cost+binding.seconds);if(seconds>maxSeconds||seconds>=(reached.get(binding.stop)?.seconds??Infinity))continue;
      const path:Point[]=[];let n:number|undefined=node;while(n!==undefined){path.push(graph.nodes.get(n)!);n=prev.get(n);}path.push(snap.point);if(!reverse)path.reverse();
      reached.set(binding.stop,{to:binding.stop,seconds,metres:length.get(node)!+binding.metres,path});
    }
  }
  if(origin){
    const edge=origin.anchor?graph.segments.find(e=>e.from===origin.anchor!.from&&e.to===origin.anchor!.to):undefined;
    if(edge){
      const start=project([origin.lat,origin.lon],graph.nodes.get(edge.from)!,graph.nodes.get(edge.to)!);
      if(start.metres<=1){
        let direct:{seconds:number;metres:number;path:Point[]}|undefined;
        const candidate=(node:number,fraction:number)=>{
          const d=dist.get(node);if(d===undefined)return;
          const seconds=Math.ceil(d+edge.seconds*fraction);if(seconds>maxSeconds||seconds>=(direct?.seconds??Infinity))return;
          const path:Point[]=[start.point];let n:number|undefined=node;while(n!==undefined){path.push(graph.nodes.get(n)!);n=prev.get(n);}path.push(snap.point);if(!reverse)path.reverse();
          direct={seconds,metres:length.get(node)!+edge.metres*fraction,path};
        };
        if(reverse){candidate(edge.to,1-start.t);if(!edge.oneway||start.t===0)candidate(edge.from,start.t);}
        else {candidate(edge.from,start.t);if(!edge.oneway||start.t===1)candidate(edge.to,1-start.t);}
        if(edge.from===snap.edge.from&&edge.to===snap.edge.to&&(!edge.oneway||(reverse?snap.t>=start.t:snap.t<=start.t))){
          const fraction=Math.abs(snap.t-start.t),seconds=Math.ceil(edge.seconds*fraction);
          if(seconds<=maxSeconds&&seconds<=(direct?.seconds??Infinity))direct={seconds,metres:edge.metres*fraction,path:reverse?[start.point,snap.point]:[snap.point,start.point]};
        }
        if(direct)reached.set(origin.stop,{to:origin.stop,...direct});
      }
    }
  }
  // A valid mapped pedestrian origin is useful even without any bound stops.
  // The point-to-point destination worker can still route directly to this anchor.
  // Keep the empty access set rather than misreporting a disconnected transit stop
  // as an unmapped pedestrian origin.

  // Reuse the bounded routing distances for the direct-walking map overlay.
  // Unreachable endpoints stay -1; a one-way edge may only be entered from
  // its from-node, except for the origin's permitted partial edge.
  let directWalking:DirectWalkingCoverage|undefined;
  if(includeDirect){
    const segments:DirectWalkingSegment[]=[];
    for(const edge of graph.segments){
      const from=dist.get(edge.from)??-1,to=edge.oneway?-1:dist.get(edge.to)??-1;
      const anchorT=edge===snap.edge?snap.t:-1;
      if(from<0&&to<0&&anchorT<0)continue;
      const a=graph.nodes.get(edge.from)!,b=graph.nodes.get(edge.to)!;
      segments.push([a[0],a[1],b[0],b[1],edge.seconds,from,to,anchorT,edge.oneway?1:0]);
    }
    directWalking={maxSeconds,segments};
  }
  return {anchor:{from:snap.edge.from,to:snap.edge.to,t:snap.t},lat:snap.point[0],lon:snap.point[1],snapMetres:snap.metres,walks:[...reached.values()],...(directWalking?{directWalking}:{})};
}
export function originTileRefs(m:Manifest,point:Point,minutes:number):FileRef[] {
  const meta=m.footpaths;
  if(!meta||meta.format!=='sliso-footpaths-v1'||meta.tileDegrees!==.05)throw new Error('Denna dataversion saknar gångnät för start på kartan. Välj en hållplats tills datan har uppdaterats.');
  const radius=(minutes*60*SPEED+26)/METRES,longitude=radius/Math.cos(point[0]*Math.PI/180),refs:FileRef[]=[];
  const minY=Math.floor((point[0]-radius)/meta.tileDegrees),maxY=Math.floor((point[0]+radius)/meta.tileDegrees),minX=Math.floor((point[1]-longitude)/meta.tileDegrees),maxX=Math.floor((point[1]+longitude)/meta.tileDegrees);
  for(const [key,ref] of Object.entries(meta.index)){const [y,x]=key.split('_').map(Number);if(y>=minY&&y<=maxY&&x>=minX&&x<=maxX)refs.push(ref);}
  return refs;
}
export async function loadFootpathGraph(m:Manifest,point:Point,minutes:number,stops:Stop[],onProgress?:(done:number,total:number)=>void,signal?:AbortSignal):Promise<FootpathGraph>{
  const refs=originTileRefs(m,point,minutes);let done=0;onProgress?.(0,refs.length);
  const tiles:FootpathTile[]=[];
  let next=0;
  await Promise.all(Array.from({length:Math.min(4,refs.length)},async()=>{while(next<refs.length){const ref=refs[next++],bytes=await verified(ref,signal);const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));tiles.push(JSON.parse(await new Response(stream).text()) as FootpathTile);onProgress?.(++done,refs.length);}}));
  return graphFromTiles(tiles,stops);
}
export async function loadOriginAccess(m:Manifest,s:Settings,stops:Stop[],onProgress?:(done:number,total:number)=>void):Promise<OriginAccess>{
  const graph=await loadFootpathGraph(m,[s.lat,s.lon],Math.min(s.walkMinutes,s.maxMinutes),stops,onProgress);
  const access=(s.direction==='arrive'?routeDestinationAccess:routeOrigin)(graph,[s.lat,s.lon],Math.min(s.walkMinutes,s.maxMinutes)*60);
  // The reverse scanner expands outward in mirrored time.
  return s.direction==='arrive'?{...access,walks:access.walks.map(w=>({...w,path:[...w.path].reverse()}))}:access;
}
