"""Regression tests for geographic water tile clipping and polygon holes."""
import json
import tempfile
import unittest
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from export_water_mask import export

class WaterMaskTests(unittest.TestCase):
    def test_polygon_is_clipped_to_tiles_and_holes_preserved(self):
        outer=[[0,0],[0.4,0],[0.4,0.4],[0,0.4],[0,0]]
        hole=[[0.1,0.1],[0.1,0.2],[0.2,0.2],[0.2,0.1],[0.1,0.1]]
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);source=root/'water.json'
            source.write_text(json.dumps({'type':'FeatureCollection','features':[{'type':'Feature','properties':{'natural':'water'},'geometry':{'type':'Polygon','coordinates':[outer,hole]}}]}))
            export(source,root/'tiles',tile_degrees=0.25)
            manifest=json.loads((root/'tiles/index.json').read_text())
            self.assertGreaterEqual(len(manifest['tiles']),4)
            from shapely.geometry import shape,Point
            for key,name in manifest['tiles'].items():
                x,y=map(int,key.split(','))
                data=json.loads((root/'tiles'/name).read_text())
                for feature in data['features']:
                    geom=shape(feature['geometry'])
                    a,b,c,d=geom.bounds
                    self.assertGreaterEqual(a,x*.25-1e-9)
                    self.assertGreaterEqual(b,y*.25-1e-9)
                    self.assertLessEqual(c,(x+1)*.25+1e-9)
                    self.assertLessEqual(d,(y+1)*.25+1e-9)
            first=json.loads((root/'tiles'/manifest['tiles']['0,0']).read_text())
            self.assertFalse(any(shape(f['geometry']).covers(Point(.15,.15)) for f in first['features']))
            self.assertTrue(any(shape(f['geometry']).covers(Point(.05,.05)) for f in first['features']))

if __name__=='__main__':unittest.main()
