"""Build geographically clipped water-mask tiles from pinned OSM and OSMCoastline.

Requires osmium-tool, GDAL/ogr2ogr, shapely and an OSM extract already pinned
in data/walking-index.source.json. Ocean download is opt-in and cacheable.
"""
import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

OCEAN_URL='https://osmdata.openstreetmap.de/download/water-polygons-split-4326.zip'

def run(*args):
    subprocess.run([str(a) for a in args],check=True)

def build(output,cache,bounds,ocean_archive=None,pbf=None):
    west,south,east,north=bounds
    if not (-180<=west<east<=180 and -90<=south<north<=90):
        raise ValueError('Invalid bounding box')
    if pbf is None:
        raise ValueError('Provide --pbf from the walking build; water tiles must use the same verified OSM source')
    pbf=Path(pbf)
    if not pbf.is_file():
        raise FileNotFoundError(pbf)
    with tempfile.TemporaryDirectory(prefix='sliso-water-') as temp:
        root=Path(temp)
        filtered=root/'water.osm.pbf'
        run('osmium','tags-filter',pbf,'wr/natural=water','wr/waterway=riverbank','wr/landuse=reservoir,basin','-o',filtered)
        raw=root/'water-all.geojson'
        run('osmium','export',filtered,'-f','geojson','-o',raw)
        inland=root/'water.geojson'
        run('ogr2ogr','-f','GeoJSON',inland,raw,'-spat',west,south,east,north,'-clipsrc',west,south,east,north,'-nlt','PROMOTE_TO_MULTI')
        if ocean_archive is None:
            ocean_archive=Path(cache)/'water-polygons-split-4326.zip'
            if not ocean_archive.exists():
                print('Downloading OSMCoastline ocean polygons (may be large)',flush=True)
                run('curl','--fail','--location','--retry','3','--connect-timeout','30','--output',ocean_archive,OCEAN_URL)
        ocean=root/'ocean.geojson'
        # GDAL can read shapefiles inside ZIP archives directly.
        archive='/vsizip/'+str(Path(ocean_archive).resolve())
        run('ogr2ogr','-f','GeoJSON',ocean,archive,'-spat',west,south,east,north,'-clipsrc',west,south,east,north,'-nlt','PROMOTE_TO_MULTI')
        run(sys.executable,'scripts/export_water_mask.py','--geojson',inland,'--ocean-geojson',ocean,'--output',output)
        print('Water tiles prepared. Set VITE_WATER_TILES_URL=/water-tiles when deploying.',flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output',default='public/water-tiles')
    p.add_argument('--cache',default='.data-build/water-cache')
    p.add_argument('--bounds',nargs=4,type=float,default=[17.2,58.7,19.8,60.4],metavar=('WEST','SOUTH','EAST','NORTH'))
    p.add_argument('--pbf',required=True,help='Verified OSM extract shared with walking build')
    p.add_argument('--ocean-archive',help='Pre-downloaded OSMCoastline WGS84 water polygon ZIP')
    a=p.parse_args()
    Path(a.cache).mkdir(parents=True,exist_ok=True)
    build(a.output,a.cache,a.bounds,a.ocean_archive,a.pbf)
