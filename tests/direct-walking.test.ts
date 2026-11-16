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
 nodes:[[1,590000000,180000000],[2,590000000,180010000],[3,590010000,180000000],[4,590010000,180010000]],
 edges:[[1,2,60,100,0],[3,4,60,100,0]],
 stops:[]
};
const grid:RasterGrid={width:180,height:140,bounds:[17.999,58.9995,18.002,59.0015]};
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
 assert.equal(get(field,59.001,18.0005),0,'parallel disconnected road is not reachable');
 assert.equal(get(field,59.0005,18.0005),0,'areas far from mapped walking path remain transparent');
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
 assert.equal(combined[index(59.001,18.0005)*4+3],255,'stop contour stays reachable where direct walking does not');
 const walkOnly=new Uint8Array(grid.width*grid.height);
 const cutoff=paintBands(walkOnly,grid,30,1,undefined,field);
 assert.equal(cutoff[index(59,18.0005)*4+3],255,'origin remains visible at a one-minute cutoff');
 assert.equal(cutoff[index(59,18.00095)*4+3],0,'far edge portion is excluded by the exact cutoff');
});
