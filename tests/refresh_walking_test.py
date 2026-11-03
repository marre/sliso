import csv
import gzip
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
from datetime import date
import data_test
from build_data import compile_feed
from refresh_walking import refresh
from release_data import validate


class RefreshTests(unittest.TestCase):
    def test_reordered_stops_preserve_costs_and_moved_stops_lose_all_bindings(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);feed,walks=data_test.DataTests().fixture(root)
            prepared=root/'prepared';prepared.mkdir()
            (prepared/'walks.json').write_bytes(walks.read_bytes())
            geom=dict(type='Polygon',coordinates=[[[18,59],[18.01,59],[18.01,59.01],[18,59]]])
            profiles={sid:[dict(minutes=n,geometry=geom) for n in (1,2,30)] for sid in ('a','b')}
            (prepared/'areas').mkdir()
            (prepared/'areas/areas-0.json').write_text(json.dumps(profiles))
            area=dict(version='v1',stepMinutes=1,files=['areas-0.json'],stops=[{**s,'file':'areas-0.json'} for s in data_test.DataTests().stops()])
            (prepared/'areas/index.json').write_text(json.dumps(area))
            (prepared/'footpaths').mkdir()
            tile=dict(schema=1,nodes=[[1,59,18]],edges=[],stops=[[1,'a',0,0,59,18],[1,'b',0,0,59.1,18]])
            raw=gzip.compress(json.dumps(tile).encode())
            path=prepared/'footpaths/footpaths-1_1.bin';path.write_bytes(raw)
            index=dict(format='sliso-footpaths-v1',tileDegrees=.05,sourceVersion='osm',index={'1,1':dict(url=path.name,bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest())})
            (prepared/'footpaths/index.json').write_text(json.dumps(index))
            (prepared/'osm-source.json').write_text('{"fixture":"preserved"}')
            with zipfile.ZipFile(feed) as archive:tables={n:archive.read(n) for n in archive.namelist()}
            stops=list(csv.reader(io.StringIO(tables['stops.txt'].decode())))
            out=io.StringIO();csv.writer(out).writerows([stops[0],stops[2],stops[1]])
            tables['stops.txt']=out.getvalue().encode()
            def save():
                with zipfile.ZipFile(feed,'w') as archive:
                    for name,raw in tables.items():archive.writestr(name,raw)
            save();refresh(prepared,feed)
            self.assertEqual(path.read_bytes(),raw)
            output=root/'published'
            compile_feed(feed,prepared/'walks.json',output,date(2026,10,19),walking_areas=prepared/'areas')
            from attach_footpaths import attach
            attach(output,prepared/'footpaths');m=validate(output)
            edges=json.loads((output/m['walks']['url'].removeprefix('/data/')).read_text())
            self.assertEqual((edges[0]['from'],edges[0]['to'],edges[0]['seconds']),(1,0,240))
            tables['stops.txt']=tables['stops.txt'].replace(b'59.1',b'59.2');save();refresh(prepared,feed)
            self.assertEqual(json.loads((prepared/'walks.json').read_text())['edges'],[])
            self.assertEqual([s['id'] for s in json.loads((prepared/'areas/index.json').read_text())['stops']],['a'])
            self.assertEqual([s[1] for s in json.loads(gzip.decompress(path.read_bytes()))['stops']],['a'])
            self.assertEqual((prepared/'osm-source.json').read_text(),'{"fixture":"preserved"}')
            # The compiler can still publish current traffic with reduced walking coverage.
            compile_feed(feed,prepared/'walks.json',root/'changed',date(2026,10,19),walking_areas=prepared/'areas')
            attach(root/'changed',prepared/'footpaths');validate(root/'changed')
