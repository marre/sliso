import mapWorkerURL from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import {Map,setWorkerUrl,NavigationControl,ScaleControl,LngLatBounds,MercatorCoordinate,type LngLatLike,type StyleSpecification} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
setWorkerUrl(mapWorkerURL);
export const MAP_STYLE='https://tiles.openfreemap.org/styles/liberty';
export const blankStyle:StyleSpecification={version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#e8eee4'}}]};
export const lngLat=(p:{lat:number;lon:number}|readonly number[]):[number,number]=>Array.isArray(p)?[p[1],p[0]]:[(p as {lon:number}).lon,(p as {lat:number}).lat];
export function boundsOf(points:readonly (readonly number[])[]){return points.reduce((b,p)=>b.extend(lngLat(p)),new LngLatBounds());}
export function padBounds(b:LngLatBounds,fraction:number){const x=(b.getEast()-b.getWest())*fraction,y=(b.getNorth()-b.getSouth())*fraction;return new LngLatBounds([b.getWest()-x,b.getSouth()-y],[b.getEast()+x,b.getNorth()+y]);}
export function containsBounds(a:LngLatBounds,b:LngLatBounds){return a.contains(b.getSouthWest())&&a.contains(b.getNorthEast());}
export function worldProject(p:LngLatLike,zoom:number){const c=MercatorCoordinate.fromLngLat(p),scale=512*2**zoom;return {x:c.x*scale,y:c.y*scale};}
export function worldUnproject(p:{x:number;y:number},zoom:number){const scale=512*2**zoom;return new MercatorCoordinate(p.x/scale,p.y/scale).toLngLat();}
export const size=(map:Map)=>({x:map.getContainer().clientWidth,y:map.getContainer().clientHeight});
export const distance=(a:LngLatLike,b:LngLatLike)=>MercatorCoordinate.fromLngLat(a).toLngLat().distanceTo(MercatorCoordinate.fromLngLat(b).toLngLat());
/** Explicitly retain Mercator/2D: contour grids and geographic canvas corners share this projection. */
export async function createMap(container:string|HTMLElement,center:[number,number]=[18.065,59.345],zoom=10,styleURL=import.meta.env.VITE_MAP_STYLE_URL??MAP_STYLE){
 let style=blankStyle,failed=false;
 if(styleURL!=='none')try{
  const response=await fetch(styleURL,{signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('Basemap unavailable');style=await response.json();
 }catch{failed=true;}
 const map=new Map({container,style,center,zoom,maxZoom:19,renderWorldCopies:false,dragRotate:false,pitchWithRotate:false,maxPitch:0,attributionControl:styleURL==='none'?false:{customAttribution:''}});
 map.touchZoomRotate.disableRotation();
 map.addControl(new NavigationControl({showCompass:false}),'top-right');
 map.addControl(new ScaleControl({unit:'metric'}),'bottom-right');
 await map.once('style.load');
 map.getContainer().dataset.basemap=failed?'unavailable':styleURL==='none'?'none':styleURL===MAP_STYLE?'openfreemap':'custom';
 map.getContainer().tabIndex=0;map.getCanvas().tabIndex=-1;
 map.getContainer().dispatchEvent(new CustomEvent('sliso:map-ready',{bubbles:true,detail:map}));
 if(failed)map.getContainer().dispatchEvent(new CustomEvent('basemaperror',{bubbles:true}));
 return map;
}
