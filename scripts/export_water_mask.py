"""Partition validated OSM water/ocean GeoJSON polygons into bounded tiles.

Inputs are pre-extracted OSM polygons (and optional ocean polygons); coastlines
are not polygons. Output tiles are immutable static assets served by Vite.
"""
import argparse
import json
import math
from pathlib import Path

def polygons(path, require_water):
    data=json.loads(Path(path).read_text())
    if data.get('type')!='FeatureCollection':raise ValueError('Expected GeoJSON FeatureCollection')
    for feature in data.get('features',[]):
        geom=feature.get('geometry') or {}
        if geom.get('type') not in ('Polygon','MultiPolygon'):continue
        tags=(feature.get('properties') or {})
        tags=tags.get('tags') or tags
        if require_water and not (tags.get('natural')=='water' or tags.get('waterway')=='riverbank' or tags.get('water') in ('lake','reservoir','pond','river','canal') or tags.get('landuse') in ('reservoir','basin')):continue
        yield geom

def bbox(geometry):
    rings=geometry['coordinates'] if geometry['type']=='Polygon' else [ring for polygon in geometry['coordinates'] for ring in polygon]
    points=[p for ring in rings for p in ring]
    if not points:return None
    return min(p[0] for p in points),min(p[1] for p in points),max(p[0] for p in points),max(p[1] for p in points)

def export(source, destination, ocean=None, tile_degrees=0.25):
    if not 0.01<=tile_degrees<=2:raise ValueError('tile-degrees must be 0.01..2')
    out=Path(destination);out.mkdir(parents=True,exist_ok=True)
    tiles={}
    geometries=list(polygons(source,True))
    if ocean:geometries+=list(polygons(ocean,False))
    if not geometries:raise ValueError('No polygon water features found; refusing empty mask')
    for geometry in geometries:
        bounds=bbox(geometry)
        if bounds is None:continue
        west,south,east,north=bounds
        if not all(math.isfinite(v) for v in bounds) or west < -180 or east > 180 or south < -90 or north > 90:raise ValueError('Invalid water coordinates')
        for x in range(math.floor(west/tile_degrees),math.floor(east/tile_degrees)+1):
            for y in range(math.floor(south/tile_degrees),math.floor(north/tile_degrees)+1):
                tiles.setdefault((x,y),[]).append(geometry)
    index={}
    for (x,y),shapes in sorted(tiles.items()):
        name=f'{x}_{y}.json'
        (out/name).write_text(json.dumps({'type':'FeatureCollection','features':[{'type':'Feature','geometry':g,'properties':{}} for g in shapes]},separators=(',',':')))
        index[f'{x},{y}']=name
    (out/'index.json').write_text(json.dumps({'schema':1,'tileDegrees':tile_degrees,'tiles':index},sort_keys=True,separators=(',',':')))
    print(f'Exported {len(geometries)} polygons to {len(tiles)} tiles in {out}')

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--geojson',required=True);p.add_argument('--ocean-geojson')
    p.add_argument('--output',required=True);p.add_argument('--tile-degrees',type=float,default=0.25)
    a=p.parse_args();export(a.geojson,a.output,a.ocean_geojson,a.tile_degrees)
