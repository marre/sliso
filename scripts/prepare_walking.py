"""Reproducible CI rebuild with a verified, immutable OSM download cache."""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def fetch_osm(provenance, cache):
    """Bound the entire transfer, verify bytes, and atomically cache by SHA-256."""
    cache=Path(cache);cache.mkdir(parents=True,exist_ok=True)
    checksum=provenance['sha256'];target=cache/(checksum+'.osm.pbf')
    def verified(path):
        with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()==checksum
    if target.exists():
        if verified(target):
            print('Reusing checksum-verified OSM extract: '+checksum[:20],flush=True);return target
        target.unlink()
    part=target.with_suffix('.part')
    if part.exists() and verified(part):
        part.replace(target);return target
    for attempt in range(1,4):
        print(f'Fetching pinned OSM extract: attempt {attempt}/3 (180 second transfer limit)',flush=True)
        try:
            subprocess.run(['curl','--fail','--location','--show-error','--connect-timeout','20',
                '--max-time','180','--continue-at','-','--speed-time','30','--speed-limit','1048576',
                '--user-agent','sliso-walking-build/1','--output',str(part),provenance['source']],check=True)
        except subprocess.CalledProcessError as error:
            if part.exists() and verified(part):
                part.replace(target);return target
            # Keep partial bytes separate from the usable cache. The immutable
            # source can resume next attempt; the final SHA still verifies all bytes.
            if error.returncode==33:part.unlink(missing_ok=True)
            if attempt==3:raise
            continue
        if not verified(part):
            part.unlink(missing_ok=True)
            raise ValueError('OSM source checksum mismatch')
        part.replace(target)
        print(f'OSM extract verified and cached: {target.stat().st_size} bytes',flush=True)
        return target
    raise RuntimeError('OSM download attempts exhausted')


def fetch_current_osm(cache, *, latest='https://download.geofabrik.de/europe/sweden-latest.osm.pbf'):
    """Verify latest Geofabrik against its MD5 and record immutable provenance."""
    import re
    import urllib.request
    from urllib.parse import urlparse
    if latest != 'https://download.geofabrik.de/europe/sweden-latest.osm.pbf':
        raise ValueError('Unexpected OSM source')
    cache=Path(cache); cache.mkdir(parents=True,exist_ok=True)
    request=urllib.request.Request(latest+'.md5',headers={'User-Agent':'sliso-osm-build/1'})
    with urllib.request.urlopen(request,timeout=90) as response:
        sidecar_url=response.geturl()
        raw=response.read(4096).decode('ascii')
    match=re.match(r'^([0-9a-fA-F]{32})(?:\s|$)',raw)
    if not match: raise ValueError('Invalid Geofabrik checksum sidecar')
    md5=match.group(1).lower()
    # Prefer the dated snapshot resolved by the checksum redirect.
    source=sidecar_url[:-4] if sidecar_url.endswith('.md5') else latest
    if urlparse(source).hostname != 'download.geofabrik.de' or not source.endswith('.osm.pbf'):
        raise ValueError('Untrusted Geofabrik redirect')
    target=cache/(md5+'.osm.pbf')
    def matches(path):
        if not path.is_file(): return False
        with path.open('rb') as stream:
            return hashlib.file_digest(stream,'md5').hexdigest()==md5
    if not matches(target):
        target.unlink(missing_ok=True)
        part=cache/(md5+'.part')
        for attempt in range(3):
            result=subprocess.run(['curl','--fail','--location','--show-error',
                '--connect-timeout','30','--max-time','1800','--continue-at','-',
                '--output',str(part),source],check=False)
            if matches(part):
                part.replace(target)
                break
            if result.returncode==0:
                part.unlink(missing_ok=True)
                raise ValueError('Geofabrik snapshot changed or checksum mismatch')
            if result.returncode==33:part.unlink(missing_ok=True)
        else: raise RuntimeError('Could not download verified current OSM')
    with target.open('rb') as stream:
        sha256=hashlib.file_digest(stream,'sha256').hexdigest()
    provenance={'source':source,'md5':md5,'sha256':sha256,'bytes':target.stat().st_size,'license':'ODbL-1.0'}
    (cache/'current-source.json').write_text(json.dumps(provenance,indent=2)+'\n')
    print('Verified current OSM:',json.dumps(provenance),flush=True)
    return target


def prepare(gtfs, output, water_output=None, water_bounds=None, ocean_archive=None, current_osm=False):
    provenance = json.loads(Path('data/walking-index.source.json').read_text())['osm']
    output = Path(output); output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='sliso-walking-build-') as temp:
        root = Path(temp); pbf = (fetch_current_osm(output.parent/'osm-cache') if current_osm else fetch_osm(provenance,output.parent/'osm-cache'))
        if current_osm:
            shutil.copyfile(output.parent/'osm-cache'/'current-source.json',output/'osm-source.json')
        if water_output is not None:
            from prepare_water_mask import build as build_water
            build_water(water_output,output.parent/'water-cache',water_bounds or [17.2,58.7,19.8,60.4],ocean_archive,pbf)
        def run(script, *args): subprocess.run([sys.executable, 'scripts/'+script, *map(str, args)], check=True)
        graph = root/'graph.json.gz'; tiles = root/'valhalla'; station_tiles=root/'station-valhalla'; walks = output/'walks.json'
        run('osm_walks.py', '--pbf', pbf, '--gtfs', gtfs, '--output', graph)
        run('prepare_pedestrian_tiles.py', '--graph', graph, '--pbf', pbf, '--directory', tiles)
        run('prepare_pedestrian_tiles.py', '--graph', graph, '--pbf', pbf, '--directory', station_tiles,'--station-access')
        run('valhalla_walks.py', '--config', tiles/'config.json', '--gtfs', gtfs, '--graph-report', str(graph)+'.report.json', '--stop-features', str(graph)+'.bus-stops.json', '--output', walks,'--station-config',station_tiles/'config.json')
        run('footpath_tiles.py','--pbf',station_tiles/'pedestrian.osm.pbf','--surface-pbf',tiles/'pedestrian.osm.pbf','--anchors',str(walks)+'.anchors.json','--output',output/'footpaths')
        run('walking_areas.py', '--config', tiles/'config.json', '--anchors', str(walks)+'.anchors.json', '--walks', walks, '--output', output/'areas','--station-config',station_tiles/'config.json')
        for name, path in [('osm-report.json', Path(str(graph)+'.report.json')), ('tiles-report.json', tiles/'report.json')]:
            shutil.copyfile(path, output/name)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__); p.add_argument('--gtfs', required=True); p.add_argument('--output', required=True)
    p.add_argument('--current-osm',action='store_true',help='Use latest verified Geofabrik extract for a new full walking build')
    p.add_argument('--water-output',help='Generate water tiles from the same verified OSM extract')
    p.add_argument('--water-bounds',nargs=4,type=float,metavar=('WEST','SOUTH','EAST','NORTH'))
    p.add_argument('--ocean-archive')
    a = p.parse_args(); prepare(a.gtfs, a.output,a.water_output,a.water_bounds,a.ocean_archive,a.current_osm)
