import type {DirectWalkingCoverage} from './types';
import type {RasterGrid} from './bands';

const METRES_PER_DEGREE=111195;
const WALK_METRES_PER_SECOND=80/60;
/** Isochrone interpolation distance, not a claim that off-network access exists.
 * The precomputed Valhalla contours also interpolate between mapped paths.
 * A bounded neighbourhood fills ordinary street blocks without turning the
 * walking network into a straight-line or convex-hull routing model. */
export const WALKING_AREA_INTERPOLATION_METRES=120;
const mercator=(latitude:number)=>Math.log(Math.tan(Math.PI/4+latitude*Math.PI/360));

/** Make a local, area-style isochrone from directed mapped walking times.
 *
 * Each reachable edge provides a travel-time boundary condition. For nearby
 * pixels, project onto that edge, add the short off-edge distance at walking
 * speed, and take the smallest cost. Neighbouring streets therefore merge
 * into filled bands like the published stop isochrones, while large gaps and
 * remote disconnected components stay unpainted.
 *
 * Only the perpendicular interpolation is permitted: do not extend past a
 * segment's endpoints, and never propagate backwards along a one-way edge.
 * This is an approximate display surface, not an off-network route; exact
 * point journeys continue to use the actual directed footpath graph.
 */
export function rasterDirectWalking(coverage:DirectWalkingCoverage,grid:RasterGrid):Uint16Array{
 const {width,height,bounds:[west,south,east,north]}=grid;
 const field=new Uint16Array(width*height),top=mercator(north);
 const sx=width/(east-west),sy=height/(top-mercator(south));
 const radius=WALKING_AREA_INTERPOLATION_METRES;
 for(const [latA,lonA,latB,lonB,edgeSeconds,from,to,anchorT,oneway] of coverage.segments){
  const ax=(lonA-west)*sx,ay=(top-mercator(latA))*sy;
  const bx=(lonB-west)*sx,by=(top-mercator(latB))*sy;
  const lat=(latA+latB)/2,cos=Math.max(.01,Math.cos(lat*Math.PI/180));
  const rx=Math.max(.75,radius/METRES_PER_DEGREE/cos*sx);
  const ry=Math.max(.75,radius/METRES_PER_DEGREE*height/(north-south));
  const x0=Math.max(0,Math.floor(Math.min(ax,bx)-rx-1));
  const x1=Math.min(width-1,Math.ceil(Math.max(ax,bx)+rx));
  const y0=Math.max(0,Math.floor(Math.min(ay,by)-ry-1));
  const y1=Math.min(height-1,Math.ceil(Math.max(ay,by)+ry));
  if(x0>x1||y0>y1)continue;
  const dx=(bx-ax)/rx,dy=(by-ay)/ry,length=dx*dx+dy*dy;
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
   const px=(x+.5-ax)/rx,py=(y+.5-ay)/ry;
   // Unlike circular buffering, extending along a forbidden road edge can
   // make a one-way segment behind the origin appear reachable.
   const t=length?(px*dx+py*dy)/length:0;
   if(t<0||t>1)continue;
   const perpendicular=Math.hypot(px-t*dx,py-t*dy);
   if(perpendicular>1)continue;
   let seconds=Infinity;
   if(from>=0)seconds=Math.min(seconds,from+edgeSeconds*t);
   if(to>=0)seconds=Math.min(seconds,to+edgeSeconds*(1-t));
   if(anchorT>=0&&(!oneway||t>=anchorT))seconds=Math.min(seconds,Math.abs(t-anchorT)*edgeSeconds);
   seconds+=perpendicular*radius/WALK_METRES_PER_SECOND;
   if(seconds>coverage.maxSeconds)continue;
   const cost=Math.max(1,Math.ceil(seconds)),offset=y*width+x;
   if(!field[offset]||cost<field[offset])field[offset]=cost;
  }
 }
 return field;
}
