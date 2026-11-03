"""Reconcile cached physical walking inputs with current GTFS stop positions.

Moved/removed endpoints lose their old physical bindings. Newly introduced
stops are handled by the compiler's explicit estimates until the next OSM build.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import zipfile
from build_data import rows


def refresh(root, gtfs):
    root = Path(root)
    with zipfile.ZipFile(gtfs) as archive:
        current = {s['stop_id']: s for s in rows(archive, 'stops.txt', True)
                   if s.get('location_type', '0') in ('', '0')}
    def unchanged(s):
        return s['id'] in current and all(
            abs(s[k]-float(current[s['id']]['stop_'+k])) <= 1e-6 for k in ('lat','lon'))
    def read(path): return json.loads(path.read_text())
    def write(path, data): path.write_text(json.dumps(data,ensure_ascii=False,separators=(',', ':')))
    walks = read(root/'walks.json')
    retained = {s['id'] for s in walks['stops'] if unchanged(s)}
    removed = len(walks['stops'])-len(retained)
    walks['stops'] = [s for s in walks['stops'] if s['id'] in retained]
    walks['edges'] = [e for e in walks['edges'] if e['from'] in retained and e['to'] in retained]
    if removed:
        walks.setdefault('warnings', []).append(
            f'{removed} borttagna eller flyttade hållplatslägen har kopplats bort från det återanvända gångunderlaget i väntan på nästa gångkartsbygge.')
    write(root/'walks.json',walks)
    area_path = root/'areas/index.json'
    if area_path.exists():
        areas = read(area_path)
        areas['stops'] = [s for s in areas['stops'] if s['id'] in retained and unchanged(s)]
        write(area_path,areas)
    path_index = root/'footpaths/index.json'
    if path_index.exists():
        paths = read(path_index)
        for ref in paths['index'].values():
            name = ref['url']
            if Path(name).name != name or not name.startswith('footpaths-'):
                raise ValueError('Unsafe cached footpath filename')
            path = root/'footpaths'/name
            raw = path.read_bytes()
            if len(raw) != ref['bytes'] or hashlib.sha256(raw).hexdigest() != ref['sha256']:
                raise ValueError('Cached footpath checksum mismatch')
            tile = json.loads(gzip.decompress(raw))
            kept = [s for s in tile['stops'] if unchanged(dict(id=s[1],lat=s[4],lon=s[5]))]
            if kept != tile['stops']:
                tile['stops'] = kept
                raw = gzip.compress(json.dumps(tile,separators=(',', ':')).encode(),mtime=0)
                path.write_bytes(raw)
                ref.update(bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest())
        write(path_index,paths)
    print(f'Reused walking network {walks["version"]}; excluded {removed} moved/removed bindings')


if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root',required=True);p.add_argument('--gtfs',required=True)
    a=p.parse_args();refresh(a.root,a.gtfs)
