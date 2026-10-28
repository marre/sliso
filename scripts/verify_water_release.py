"""Verify a real water-enabled walking-data release before publication."""
import argparse
import json
import math
from pathlib import Path
from release_data import validate

# Stable, well-separated reference points: avoid coastlines, bridges and beaches.
LANDMARKS=[
    ('Stockholm City',18.0686,59.3293,False),
    ('Djurgarden',18.120,59.325,False),
    ('Sodermalm',18.072,59.312,False),
    ('Saltsjon',18.150,59.318,True),
    ('Riddarfjarden',18.040,59.321,True),
    ('Outer archipelago',18.700,59.350,True),
]

def verify(root):
    root=Path(root)
    manifest=validate(root)
    mask=manifest.get('waterMask')
    if not mask or mask.get('format')!='sliso-water-bitmap-v1':
        raise ValueError('Water bitmap missing from compiled data release')
    n=mask['resolution']
    d=mask['tileDegrees']
    if not 0<d<=2 or n!=512 or not mask['tiles']:
        raise ValueError('Invalid water bitmap geometry')
    source=manifest.get('osmSource')
    if not source or source['sha256'][:20] not in manifest['walkingVersion']:
        raise ValueError('Walking and water source provenance mismatch')
    checked=0
    for label,lon,lat,expect_water in LANDMARKS:
        x,y=math.floor(lon/d),math.floor(lat/d)
        ref=mask['tiles'].get(f'{x},{y}')
        if not ref:
            raise ValueError(f'No water tile covering {label}')
        bits=(root/ref['url'].removeprefix('/data/')).read_bytes()
        cx=max(0,min(n-1,math.floor((lon/d-x)*n)))
        cy=max(0,min(n-1,math.floor((lat/d-y)*n)))
        bit=cy*n+cx
        water=bool(bits[bit//8]&(128>>(bit%8)))
        if water!=expect_water:
            raise ValueError(f'Water classification wrong at {label}: {water}')
        checked+=1
    print(json.dumps({'version':manifest['version'],'waterTiles':len(mask['tiles']),
                      'samplePointsPassed':checked,'sourceSha256':source['sha256']}))
    return mask

if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--root',required=True)
    verify(p.parse_args().root)
