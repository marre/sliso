import gzip
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from footpath_tiles import write_tiles
from attach_footpaths import attach
from release_data import validate,pack,install

class FootpathsTests(unittest.TestCase):
    def test_boundary_tiles_keep_global_nodes_direction_and_endpoint_costs(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            metadata=write_tiles({1:(59.049,18.049),2:(59.051,18.051)},[(1,2,250,187.5,True)],{2:[['stop',120,5,59.051,18.051]]},root,'mapped-test')
            self.assertEqual(len(metadata['index']),4)
            for ref in metadata['index'].values():
                raw=(root/ref['url']).read_bytes();self.assertEqual(hashlib.sha256(raw).hexdigest(),ref['sha256'])
                tile=json.loads(gzip.decompress(raw));self.assertEqual(tile['edges'],[[1,2,250,187.5,1]])
                self.assertEqual(tile['stops'][0][:4],[2,'stop',120,5])

    def test_immutable_migration_packages_tiles_and_rejects_corruption(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'data';tiles=Path(temp)/'tiles';old='sl-'+'a'*20
            (root/old).mkdir(parents=True);raw=b'[]';(root/old/'index.json').write_bytes(raw)
            ref=dict(url=f'/data/{old}/index.json',bytes=2,sha256=hashlib.sha256(raw).hexdigest())
            water=b'\x00'*(512*512//8)
            (root/old/'water-0_0.bin').write_bytes(water)
            water_ref=dict(url=f'/data/{old}/water-0_0.bin',bytes=len(water),sha256=hashlib.sha256(water).hexdigest())
            manifest=dict(schema=2,version=old,demo=False,validFrom='2026-10-23',validTo='2026-10-28',days={'2026-10-23':[ref]},waterMask=dict(format='sliso-water-bitmap-v1',tileDegrees=.25,resolution=512,tiles={'0,0':water_ref}),**{k:ref for k in ('stops','walks','routes','transfers','trips')})
            (root/'manifest.json').write_text(json.dumps(manifest));(root/old/'report.json').write_text(json.dumps(dict(generator='sliso-data-v2',version=old)))
            write_tiles({1:(59,18),2:(59.001,18)},[(1,2,111,83.25,False)],{},tiles,'mapped-test')
            new=attach(root,tiles);self.assertNotEqual(new['version'],old);self.assertEqual(new['stops']['sha256'],ref['sha256']);self.assertEqual((root/old/'index.json').read_bytes(),raw)
            self.assertEqual(new['waterMask']['tiles']['0,0']['url'],f"/data/{new['version']}/water-0_0.bin")
            release=pack(root,Path(temp)/'release.zip',Path(temp)/'release.json','marre/sliso');self.assertTrue(release['features']['footpaths'])
            target=Path(temp)/'installed';install(Path(temp)/'release.zip',release,target);self.assertEqual(validate(target),new)
            asset=next(iter(new['footpaths']['index'].values()));(target/asset['url'].removeprefix('/data/')).write_bytes(b'bad')
            with self.assertRaises(ValueError):validate(target)
