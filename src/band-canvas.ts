import {LngLatBounds,type Map as GLMap,type CanvasSource} from 'maplibre-gl';
export class BandCanvas {
  readonly canvas=document.createElement('canvas');
  coverage?:LngLatBounds;
  constructor(private map:GLMap,private area:LngLatBounds){this.canvas.className='walking-raster';this.canvas.hidden=true;map.getContainer().append(this.canvas);}
  remove(){if(this.map.getLayer('walking-areas'))this.map.removeLayer('walking-areas');if(this.map.getSource('walking-areas'))this.map.removeSource('walking-areas');this.canvas.remove();}
  image(width:number,height:number,pixels:Uint8ClampedArray,cutoff:number){
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

