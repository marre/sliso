"""Export OSM natural=water polygons from a local GeoJSON FeatureCollection.

Input must contain polygonal OSM features (for example from a PBF export).
Include coastal ocean polygons separately; OSM natural=coastline lines are not
water polygons and must not be treated as filled areas.
"""
import argparse
import json
from pathlib import Path

def export(source, destination):
    data=json.loads(Path(source).read_text())
    if data.get('type')!='FeatureCollection':raise ValueError('Expected GeoJSON FeatureCollection')
    features=[]
    for feature in data.get('features',[]):
        geometry=feature.get('geometry') or {}
        properties=feature.get('properties') or {}
        tags=properties.get('tags') or properties
        if geometry.get('type') not in ('Polygon','MultiPolygon'):continue
        if not (tags.get('natural')=='water' or tags.get('waterway')=='riverbank' or tags.get('water') in ('lake','reservoir','pond','river','canal') or tags.get('landuse') in ('reservoir','basin')):continue
        features.append({'type':'Feature','properties':{},'geometry':geometry})
    if not features:raise ValueError('No polygon water features found; refusing empty mask')
    output=Path(destination);output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps({'type':'FeatureCollection','features':features},separators=(',',':')))
    print(f'Exported {len(features)} water polygons to {output}')

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--geojson',required=True);p.add_argument('--output',required=True)
    a=p.parse_args();export(a.geojson,a.output)
