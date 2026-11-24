"""Recompute station access/closure from the pinned release's GTFS transfer table.

No GTFS/OSM download or contour rebuild. Footpath tiles and native contours stay
byte-identical and never gain invented geometry from published transfer times.
"""
import argparse
import copy
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from transfer_walks import add_transfer_walks,update_walking_status,WARNING,POLICY
from walking_closure import build,decode_walks,FORMAT
from release_data import validate
from build_data import compact_walks


def compact(value):return json.dumps(value,ensure_ascii=False,separators=(',',':')).encode()

def migrate(root):
    root=Path(root);source=validate(root);previous=source['version']
    if source.get('transferWalking',{}).get('policy')==POLICY:return source
    read=lambda ref:json.loads((root/ref['url'].removeprefix('/data/')).read_bytes())
    stops=read(source['stops']);walks,stats=add_transfer_walks(stops,decode_walks(read(source['walks'])),read(source['transfers']),source['walkingMaxMinutes'])
    update_walking_status(stops,walks)
    payload={'walks.json':compact(compact_walks(walks)),'stops.json':compact(stops)}
    payload['walking-closure.bin'],pairs=build(stops,walks,source['walkingMaxMinutes'],hashlib.sha256(payload['walks.json']).hexdigest(),hashlib.sha256(payload['stops.json']).hexdigest())
    version='sl-'+hashlib.sha256(compact([previous,POLICY])+b''.join(payload[n] for n in sorted(payload))).hexdigest()[:20]
    migrated=copy.deepcopy(source);migrated.update(version=version,transferWalking=stats)
    migrated['walkingVersion']=source['walkingVersion'].removesuffix('+'+POLICY)+'+'+POLICY
    migrated['walkingCoverage']['pairs']=len(walks)
    gaps=len(stops)-len({w['from'] for w in walks})
    migrated['warnings']=[w for w in source['warnings'] if not w.startswith('Publicerade stationsbyten:') and not re.match(r'^\d+ hållplatslägen saknar utgående',w)]+[WARNING]
    if gaps:migrated['warnings'].append(f'{gaps} hållplatslägen saknar utgående gånganslutning i underlaget.')
    refs=[migrated[k] for k in ('stops','walks','routes','transfers','trips')]
    if 'serviceCatalog' in migrated:refs.append(migrated['serviceCatalog'])
    refs.extend(r for parts in migrated['days'].values() for r in parts)
    refs.extend(migrated.get('walkingAreas',{}).get('files',[]));refs.extend(migrated.get('walkingAreas',{}).get('overview',{}).get('files',[]))
    refs.extend(migrated.get('footpaths',{}).get('index',{}).values())
    if migrated.get('walkingClosure'):refs.append(migrated['walkingClosure'])
    with tempfile.TemporaryDirectory(prefix='.transfer-walks-',dir=root) as temp:
        staging=Path(temp)
        for ref in refs:
            path=root/ref['url'].removeprefix('/data/');name=path.name
            if name not in payload and not (staging/name).exists():os.link(path,staging/name)
            ref['url']=f'/data/{version}/{name}'
        for name,raw in payload.items():
            (staging/name).write_bytes(raw)
            ref=dict(url=f'/data/{version}/{name}',sha256=hashlib.sha256(raw).hexdigest(),bytes=len(raw))
            if name=='walking-closure.bin':migrated['walkingClosure']=dict(**ref,format=FORMAT,maxMinutes=source['walkingMaxMinutes'])
            else:migrated[name.removesuffix('.json')]=ref
        report=read(dict(url='/data/'+previous+'/report.json'))
        report.update(version=version,walkingEdges=len(walks),stopsWithoutOutgoingWalk=gaps,transferWalking=stats,walkingClosure=dict(sourceVersion=previous,pairs=pairs,bytes=len(payload['walking-closure.bin']),witnessesVerified=True),packageBytes=sum(p.stat().st_size for p in staging.iterdir()))
        (staging/'report.json').write_bytes(compact(report))
        if (root/version).exists():raise ValueError('Immutable destination already exists')
        staging.rename(root/version)
    original=(root/'manifest.json').read_bytes();pending=root/'.manifest.tmp';pending.write_bytes(compact(migrated));os.replace(pending,root/'manifest.json')
    try:validate(root)
    except Exception:
        pending.write_bytes(original);os.replace(pending,root/'manifest.json');raise
    os.utime(root/previous,None)
    print(json.dumps(dict(**stats,closurePairs=pairs,version=version)),flush=True)
    return migrated

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--root',required=True);a=p.parse_args();migrate(a.root)
