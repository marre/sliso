import type {DirectWalkingCoverage} from './types';
import type {RasterGrid} from './bands';

const METRES=111195;
const mercator=(latitude:number)=>Math.log(Math.tan(Math.PI/4+latitude*Math.PI/360));

/** Rasterize ONLY mapped, directed pedestrian edges. A 25 m corridor matches
 * the point router's snapping tolerance; it is a display approximation, not
 * a claim of access to every location inside a polygon. Never use convex
 * hulls, straight-line reachability or connections between disconnected edges.
 *
 * The routing worker already ran bounded Dijkstra; this function interpolates
 * its times on each reachable edge and handles the origin's partial edge.
 * A zero field value means unreachable; positive values are walking seconds.
 */
export function rasterDirectWalking(coverage:DirectWalkingCoverage,grid:RasterGrid):Uint16Array {
 const {width,height,bounds:[west,south,east,north]}=grid;
 const field=new Uint16Array(width*height),top=mercator(north);
 const sx=width/(east-west),sy=height/(top-mercator(south));
 for(const [latA,lonA,latB,lonB,edgeSeconds,from,to,anchorT,oneway] of coverage.segments){
  const ax=(lonA-west)*sx,ay=(top-mercator(latA))*sy;
  const bx=(lonB-west)*sx,by=(top-mercator(latB))*sy;
  const lat=(latA+latB)/2,cos=Math.max(.01,Math.cos(lat*Math.PI/180));
  // At low zoom preserve at least a subpixel trace of a valid path.
  const rx=Math.max(.75,25/METRES/cos*sx);
  const ry=Math.max(.75,25/METRES*height/(north-south));
  const x0=Math.max(0,Math.floor(Math.min(ax,bx)-rx-1));
  const x1=Math.min(width-1,Math.ceil(Math.max(ax,bx)+rx));
  const y0=Math.max(0,Math.floor(Math.min(ay,by)-ry-1));
  const y1=Math.min(height-1,Math.ceil(Math.max(ay,by)+ry));
  if(x0>x1||y0>y1)continue;
  const dx=(bx-ax)/rx,dy=(by-ay)/ry,length=dx*dx+dy*dy;
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
   const px=(x+.5-ax)/rx,py=(y+.5-ay)/ry;
   const t=length?Math.max(0,Math.min(1,(px*dx+py*dy)/length)):0;
   if((px-t*dx)**2+(py-t*dy)**2>1)continue;
   let seconds=Infinity;
   if(from>=0)seconds=Math.min(seconds,from+edgeSeconds*t);
   if(to>=0)seconds=Math.min(seconds,to+edgeSeconds*(1-t));
   if(anchorT>=0&&(!oneway||t>=anchorT))seconds=Math.min(seconds,Math.abs(t-anchorT)*edgeSeconds);
   if(seconds>coverage.maxSeconds)continue;
   const cost=Math.max(1,Math.ceil(seconds));
   const offset=y*width+x;
   if(!field[offset]||cost<field[offset])field[offset]=cost;
  }
 }
 return field;
}
