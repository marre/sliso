"""Verify offline water bitmaps respect polygon holes and tile placement."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
try:
    import numpy
    import shapely
except ImportError:
    shapely=None
from water_bitmap import build, RESOLUTION

@unittest.skipUnless(shapely is not None,'Shapely required for bitmap tests')
class WaterBitmapTests(unittest.TestCase):
    def test_water_and_island_hole(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            source=root/'polygons'
            source.mkdir()
            feature={'type':'Feature','properties':{},'geometry':{'type':'Polygon','coordinates':[
                [[0,0],[.25,0],[.25,.25],[0,.25],[0,0]],
                [[.1,.1],[.15,.1],[.15,.15],[.1,.15],[.1,.1]]
            ]}}
            (source/'0_0.json').write_text(json.dumps({'type':'FeatureCollection','features':[feature]}))
            (source/'index.json').write_text(json.dumps({'schema':1,'tileDegrees':.25,'tiles':{'0,0':'0_0.json'}}))
            manifest=build(source,root/'bitmap')
            self.assertEqual(manifest['format'],'sliso-water-bitmap-v1')
            raw=(root/'bitmap'/'water-0_0.bin').read_bytes()
            self.assertEqual(len(raw),RESOLUTION*RESOLUTION//8)
            def at(lon,lat):
                col=int(lon/.25*RESOLUTION)
                row=int(lat/.25*RESOLUTION)
                bit=row*RESOLUTION+col
                return bool(raw[bit//8]&(128>>(bit%8)))
            self.assertTrue(at(.05,.05))
            self.assertFalse(at(.125,.125))

if __name__=='__main__': unittest.main()
