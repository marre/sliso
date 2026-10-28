"""Build compact, offline land/water bitmaps from clipped geographic water tiles.

Each bitmap is 512 x 512, one packed bit per WGS84 pixel centre.
"""
import argparse
import json
from pathlib import Path

RESOLUTION=512

def build(source, destination):
    import numpy as np
    from shapely import contains_xy
    from shapely.geometry import shape
    from shapely.ops import unary_union

    source,destination=Path(source),Path(destination)
    destination.mkdir(parents=True,exist_ok=True)
    index=json.loads((source/'index.json').read_text())
    if index.get('schema')!=1 or not 0.01<=index.get('tileDegrees',0)<=2:
        raise ValueError('Invalid water tile index')
    degrees=index['tileDegrees']
    output={}
    for key,name in sorted(index['tiles'].items()):
        x,y=map(int,key.split(','))
        if Path(name).name!=name:raise ValueError('Invalid water tile file name')
        collection=json.loads((source/name).read_text())
        geometries=[shape(f['geometry']) for f in collection['features'] if f.get('geometry')]
        if not geometries:continue
        water=unary_union(geometries)
        lons=(x+(np.arange(RESOLUTION)+0.5)/RESOLUTION)*degrees
        lats=(y+(np.arange(RESOLUTION)+0.5)/RESOLUTION)*degrees
        mask=np.empty((RESOLUTION,RESOLUTION),dtype=np.uint8)
        for row,latitude in enumerate(lats):
            mask[row,:]=contains_xy(water,lons,np.full(RESOLUTION,latitude))
        name=f'water-{x}_{y}.bin'
        raw=np.packbits(mask.reshape(-1),bitorder='big').tobytes()
        if len(raw)!=RESOLUTION*RESOLUTION//8:raise AssertionError('Invalid bitmap size')
        (destination/name).write_bytes(raw)
        output[key]=name
    if not output:raise ValueError('No water bitmap tiles produced')
    manifest={'schema':1,'format':'sliso-water-bitmap-v1','tileDegrees':degrees,'resolution':RESOLUTION,'tiles':output}
    (destination/'index.json').write_text(json.dumps(manifest,sort_keys=True,separators=(',',':')))
    return manifest

if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--source',required=True)
    p.add_argument('--output',required=True)
    a=p.parse_args()
    build(a.source,a.output)
