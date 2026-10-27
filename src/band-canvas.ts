import {WaterMask} from './water-mask';
import type {Manifest} from './core/types';
import {LngLatBounds,type Map as GLMap,type CanvasSource} from 'maplibre-gl';
export class BandCanvas {
  readonly canvas=document.createElement('canvas');
  coverage?:LngLatBounds;
  private readonly waterMask:WaterMask;
  private revision=0;
  constructor(private map:GLMap,private area:LngLatBounds,water?:Manifest['waterMask']){this.waterMask=new WaterMask(water);this.canvas.className='walking-raster';this.canvas.hidden=true;map.getContainer().append(this.canvas);}
  remove(){this.revision++;if(this.map.getLayer('walking-areas'))this.map.removeLayer('walking-areas');if(this.map.getSource('walking-areas'))this.map.removeSource('walking-areas');this.canvas.remove();}
  async image(width:number,height:number,pixels:Uint8ClampedArray,cutoff:number){
    const revision=++this.revision;
    await this.waterMask.apply(pixels,width,height,[this.area.getWest(),this.area.getSouth(),this.area.getEast(),this.area.getNorth()]);
    if(revision!==this.revision)return;
    this.canvas.width=width;this.canvas.height=height;this.canvas.dataset.cutoff=String(cutoff);
    this.canvas.getContext('2d')!.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>,width,height),0,0);
    if(!this.map.getSource('walking-areas')){
      const b=this.area;
      this.map.addSource('walking-areas',{type:'canvas',canvas:this.canvas,animate:false,coordinates:[b.getNorthWest().toArray(),b.getNorthEast().toArray(),b.getSouthEast().toArray(),b.getSouthWest().toArray()]});
      this.map.addLayer({id:'walking-areas',type:'raster',source:'walking-areas',paint:{'raster-opacity':.48,'raster-resampling':'linear','raster-fade-duration':0}},this.map.getLayer('stops')?'stops':undefined);
    }
    const source=this.map.getSource('walking-areas') as CanvasSource;
    source.play();this.map.triggerRepaint();this.map.once('render',()=>{if(this.map.getSource('walking-areas')===source)source.pause();});
  }
}

