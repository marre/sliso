"""Build geographically clipped water-mask tiles from pinned OSM and OSMCoastline.

Requires osmium-tool, GDAL/ogr2ogr, shapely and an OSM extract already pinned
in data/walking-index.source.json. Ocean download is opt-in and cacheable.
"""
import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

# The walking index remains pinned separately; the water pipeline tracks current OSM.
WATER_PBF_URL='https://download.geofabrik.de/europe/sweden-latest.osm.pbf'
OCEAN_URL='https://osmdata.openstreetmap.de/download/water-polygons-split-4326.zip'

def run(*args):
    subprocess.run([str(a) for a in args],check=True)

def fetch_water_osm(cache):
    """Download Geofabrik's current extract and verify it against its MD5 sidecar.

    Cache by checksum to avoid treating a changing latest URL as immutable.
    """
    cache=Path(cache)
    cache.mkdir(parents=True,exist_ok=True)
    filename=WATER_PBF_URL.rsplit('/',1)[-1]
    checksum_file=cache/(filename+'.md5')
    run('curl','--fail','--location','--show-error','--retry','3',
        '--connect-timeout','30','--max-time','120',
        '--output',checksum_file,WATER_PBF_URL+'.md5')
    checksum=checksum_file.read_text().split()[0].lower()
    if len(checksum)!=32 or any(c not in '0123456789abcdef' for c in checksum):
        raise ValueError('Invalid Geofabrik MD5 sidecar')
    target=cache/(checksum+'.osm.pbf')
    def matches(path):
        if not path.exists():return False
        with path.open('rb') as stream:
            return hashlib.file_digest(stream,'md5').hexdigest()==checksum
    if matches(target):
        print('Reusing verified water OSM snapshot:',filename,flush=True)
        return target
    target.unlink(missing_ok=True)
    part=cache/(checksum+'.part')
    for attempt in range(3):
        print(f'Downloading water OSM snapshot {filename}, attempt {attempt+1}/3',flush=True)
        result=subprocess.run(['curl','--fail','--location','--show-error',
            '--connect-timeout','30','--max-time','1800','--continue-at','-',
            '--output',str(part),WATER_PBF_URL],check=False)
        if matches(part):
            part.replace(target)
            print('Verified Geofabrik snapshot:',filename,flush=True)
            return target
        if result.returncode==0:
            part.unlink(missing_ok=True)
            raise ValueError('Water OSM checksum mismatch (latest may have changed during transfer)')
        if result.returncode==33:part.unlink(missing_ok=True)
    raise RuntimeError('Failed to download verified water OSM snapshot')

def build(output,cache,bounds,ocean_archive=None):
    west,south,east,north=bounds
    if not (-180<=west<east<=180 and -90<=south<north<=90):
        raise ValueError('Invalid bounding box')
    pbf=fetch_water_osm(Path(cache)/'osm')
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
    p.add_argument('--ocean-archive',help='Pre-downloaded OSMCoastline WGS84 water polygon ZIP')
    a=p.parse_args()
    Path(a.cache).mkdir(parents=True,exist_ok=True)
    build(a.output,a.cache,a.bounds,a.ocean_archive)
