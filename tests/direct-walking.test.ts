import {test} from 'node:test';
import assert from 'node:assert/strict';
import {graphFromTiles,routeOrigin,type FootpathTile} from '../src/core/origin-access';
import {rasterDirectWalking} from '../src/core/direct-walking';
import {paintBands,type RasterGrid} from '../src/core/bands';
import {colorFor} from '../src/core/settings';

// The second segment is geographically close but disconnected; there are
// deliberately no transit-stop bindings anywhere in this walking component.
const tile:FootpathTile={
 schema:1,
 nodes:[[1,590000000,180000000],[2,590000000,180010000],[3,590040000,180000000],[4,590040000,180010000]],
 edges:[[1,2,60,100,0],[3,4,60,100,0]],
 stops:[]
};
const grid:RasterGrid={width:180,height:240,bounds:[17.999,58.999,18.002,59.006]};
const mercator=(lat:number)=>Math.log(Math.tan(Math.PI/4+lat*Math.PI/360));
function index(lat:number,lon:number) {
 const [west,south,east,north]=grid.bounds;
 const x=Math.floor((lon-west)*grid.width/(east-west));
 const y=Math.floor((mercator(north)-mercator(lat))*grid.height/(mercator(north)-mercator(south)));
 return y*grid.width+x;
}
function get(field:Uint16Array,lat:number,lon:number) {return field[index(lat,lon)];}
function rgba(field:Uint8ClampedArray,lat:number,lon:number) {return [...field.slice(index(lat,lon)*4,index(lat,lon)*4+4)];}

test('direct walking is available without any reachable transit stop and never jumps to disconnected segments',()=>{
 const graph=graphFromTiles([tile],[]);
 const origin=routeOrigin(graph,[59,18.0005],120);
 assert.deepEqual(origin.walks,[]);
 assert.ok(origin.directWalking);
 const field=rasterDirectWalking(origin.directWalking!,grid);
 assert.ok(get(field,59,18.00025)>0);
 assert.ok(get(field,59,18.00075)>0);
 assert.ok(get(field,59.0005,18.0005)>0,'walking area fills nearby land, not only thin path strokes');
 assert.equal(get(field,59.004,18.0005),0,'a disconnected road far outside interpolation cannot be reached');
 assert.equal(get(field,59.002,18.0005),0,'large gaps between roads must remain unpainted');
});

test('origin mid-edge respects oneway restrictions and the precise walking cutoff',()=>{
 const directed:FootpathTile={...tile,edges:[[1,2,60,100,1]]};
 const origin=routeOrigin(graphFromTiles([directed],[]),[59,18.0005],40);
 const field=rasterDirectWalking(origin.directWalking!,grid);
 assert.ok(get(field,59,18.0007)>0,'forward along the same edge is reachable');
 assert.equal(get(field,59,18.0003),0,'reverse movement on a one-way footpath is forbidden');
 assert.equal(get(field,59,18.00098),0,'the forward endpoint is over the walking limit');
});

test('direct walking improves transit contours and respects partial cutoff rendering',()=>{
 const slow:FootpathTile={...tile,edges:[[1,2,60,1000,0]]};
 const origin=routeOrigin(graphFromTiles([slow],[]),[59,18.0005],150);
 const field=rasterDirectWalking(origin.directWalking!,grid);
 const contours=new Uint8Array(grid.width*grid.height).fill(20);
 const combined=paintBands(contours,grid,30,30,undefined,field);
 const sample=rgba(combined,59,18.0005);
 assert.deepEqual(sample.slice(0,3),colorFor(600,30).slice(1).match(/../g)!.map(x=>parseInt(x,16)),'faster direct route must win over a 20-minute stop contour');
 assert.equal(combined[index(59.004,18.0005)*4+3],255,'stop contour stays reachable where direct walking does not');
 const walkOnly=new Uint8Array(grid.width*grid.height);
 const cutoff=paintBands(walkOnly,grid,30,1,undefined,field);
 assert.equal(cutoff[index(59,18.0005)*4+3],255,'origin remains visible at a one-minute cutoff');
 assert.equal(cutoff[index(59,18.00095)*4+3],0,'far edge portion is excluded by the exact cutoff');
});

test('reachable parallel streets merge into a filled isochrone without filling distant land',()=>{
 const blocks:FootpathTile={schema:1,nodes:[
  [1,590000000,180000000],[2,590000000,180010000],
  [3,590010000,180000000],[4,590010000,180010000]
 ],edges:[[1,2,60,100,0],[1,3,111,85,0],[3,4,60,100,0]],stops:[]};
 const origin=routeOrigin(graphFromTiles([blocks],[]),[59,18.0001],300);
 const field=rasterDirectWalking(origin.directWalking!,grid);
 assert.ok(get(field,59.0005,18.0005)>0,'the interior of a street block is covered by the walking area');
 assert.ok(get(field,59.0005,18.0005)>get(field,59,18.0001),'interpolated off-road pixels include extra time');
 assert.equal(get(field,59.003,18.0005),0,'far-away land remains outside the area');
});

test('an interpolated area cannot spend more than the selected walking cutoff',()=>{
 const origin=routeOrigin(graphFromTiles([tile],[]),[59,18.0005],120);
 const field=rasterDirectWalking(origin.directWalking!,grid);
 const empty=new Uint8Array(grid.width*grid.height);
 const oneMinute=paintBands(empty,grid,30,1,undefined,field);
 assert.equal(oneMinute[index(59.00025,18.0005)*4+3],255,'nearby block interior is within one minute');
 assert.equal(oneMinute[index(59.0009,18.0005)*4+3],0,'farther land costs more than one minute');
 assert.ok(get(field,59.0009,18.0005)>60,'interpolation is charged rather than free buffering');
});
