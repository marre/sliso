"""Attach physical footpath tiles to a new immutable static-data version.

Existing GTFS, closure and contours are retained byte for byte. Only manifest
references change; old clients can keep using the preceding version.
"""
import argparse
import copy
import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path
from footpath_tiles import FORMAT,compact
from release_data import validate


def attach(root,tiles):
    root,tiles=Path(root),Path(tiles)
    source=json.loads((root/'manifest.json').read_bytes());old=source['version']
    paths=json.loads((tiles/'index.json').read_bytes())
    if paths['format']!=FORMAT or paths['tileDegrees']!=.05:raise ValueError('Unsupported footpaths')
    version=('demo-' if source['demo'] else 'sl-')+hashlib.sha256(compact([old,paths])).hexdigest()[:20]
    migrated=copy.deepcopy(source);migrated['version']=version;migrated['footpaths']=paths
    refs=[migrated[k] for k in ('stops','walks','routes','transfers','trips')]
    refs.extend(r for parts in migrated['days'].values() for r in parts)
    for layer in [migrated.get('walkingAreas',{}),migrated.get('walkingAreas',{}).get('overview',{})]:refs.extend(layer.get('files',[]))
    if migrated.get('walkingClosure'):refs.append(migrated['walkingClosure'])
    if migrated.get('waterMask'):refs.extend(migrated['waterMask']['tiles'].values())
    with tempfile.TemporaryDirectory(prefix='.footpaths-',dir=root) as temp:
        staging=Path(temp)
        for ref in refs:
            path=root/ref['url'].removeprefix('/data/');target=staging/path.name
            if not target.exists():os.link(path,target)
            ref['url']=f'/data/{version}/{path.name}'
        for ref in paths['index'].values():
            name=ref['url']
            if Path(name).name!=name or not name.startswith('footpaths-'):raise ValueError('Unsafe footpath name')
            path=tiles/name
            if path.stat().st_size!=ref['bytes'] or hashlib.sha256(path.read_bytes()).hexdigest()!=ref['sha256']:raise ValueError('Footpath checksum mismatch')
            try:os.link(path,staging/name)
            except OSError:shutil.copyfile(path,staging/name)
            ref['url']=f'/data/{version}/{name}'
        report=json.loads((root/old/'report.json').read_bytes());report.update(version=version,footpaths=dict(tiles=len(paths['index']),bytes=sum(r['bytes'] for r in paths['index'].values()),sourceVersion=paths['sourceVersion']),packageBytes=sum(p.stat().st_size for p in staging.iterdir()))
        (staging/'report.json').write_bytes(compact(report));destination=root/version
        if destination.exists():raise ValueError('Immutable version already exists')
        staging.rename(destination)
    pending=root/'.manifest.tmp';pending.write_bytes(compact(migrated));original=(root/'manifest.json').read_bytes();os.replace(pending,root/'manifest.json')
    try:
        if not source['demo']:validate(root)
    except Exception:
        pending.write_bytes(original);os.replace(pending,root/'manifest.json');raise
    os.utime(root/old,None)  # Keep the actual preceding manifest when pruning by recency.
    print(json.dumps(report['footpaths']),flush=True)
    return migrated

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--root',required=True);p.add_argument('--tiles',required=True);a=p.parse_args();attach(a.root,a.tiles)
