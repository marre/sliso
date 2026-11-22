"""Tests for current-source download validation without network access."""
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from prepare_walking import fetch_current_osm

URL='https://download.geofabrik.de/europe/sweden-latest.osm.pbf'

class Response:
    def __init__(self, body, url):
        self.body=body
        self.url=url
    def __enter__(self): return self
    def __exit__(self,*args): return False
    def geturl(self): return self.url
    def read(self, limit): return self.body[:limit]

class CurrentOSMTest(unittest.TestCase):
    def test_verified_cache_and_provenance(self):
        payload=b'tiny-test-osm'
        md5=hashlib.md5(payload).hexdigest()
        sha=hashlib.sha256(payload).hexdigest()
        with tempfile.TemporaryDirectory() as temp:
            target=Path(temp)/(md5+'.osm.pbf')
            target.write_bytes(payload)
            dated='https://download.geofabrik.de/europe/sweden-261027.osm.pbf'
            with patch('urllib.request.urlopen',return_value=Response((md5+'  sweden.osm.pbf\n').encode(),dated+'.md5')):
                with patch('subprocess.run',side_effect=AssertionError('cached extract should not download')):
                    self.assertEqual(fetch_current_osm(temp),target)
            metadata=json.loads((Path(temp)/'current-source.json').read_text())
            self.assertEqual(metadata['sha256'],sha)
            self.assertEqual(metadata['source'],dated)
            self.assertEqual(metadata['bytes'],len(payload))

    def test_dated_snapshot_404_falls_back_to_checksum_verified_latest(self):
        payload=b'verified osm bytes'
        md5=hashlib.md5(payload).hexdigest()
        dated='https://download.geofabrik.de/europe/sweden-261122.osm.pbf'
        calls=[]
        def download(args, **kwargs):
            url=args[-1]
            calls.append(url)
            if url==URL:
                Path(args[args.index('--output')+1]).write_bytes(payload)
                return subprocess.CompletedProcess(args,0)
            return subprocess.CompletedProcess(args,22)
        with tempfile.TemporaryDirectory() as temp:
            with patch('urllib.request.urlopen',return_value=Response((md5+'  sweden.osm.pbf\\n').encode(),dated+'.md5')):
                with patch('subprocess.run',side_effect=download):
                    result=fetch_current_osm(temp)
            self.assertEqual(result.read_bytes(),payload)
            self.assertEqual(calls,[dated]*3+[URL])
            provenance=json.loads((Path(temp)/'current-source.json').read_text())
            self.assertEqual(provenance['source'],URL)
            self.assertEqual(provenance['md5'],md5)

    def test_repeated_404_never_publishes_an_unverified_extract(self):
        payload=b'expected OSM'
        md5=hashlib.md5(payload).hexdigest()
        dated='https://download.geofabrik.de/europe/sweden-261122.osm.pbf'
        with tempfile.TemporaryDirectory() as temp:
            with patch('urllib.request.urlopen',return_value=Response((md5+'  sweden.osm.pbf\\n').encode(),dated+'.md5')):
                with patch('subprocess.run',return_value=subprocess.CompletedProcess(['curl'],22)) as run:
                    with self.assertRaisesRegex(RuntimeError,'verified current OSM'):
                        fetch_current_osm(temp)
            self.assertEqual(run.call_count,6)
            self.assertFalse(list(Path(temp).glob('*.osm.pbf')))
            self.assertFalse((Path(temp)/'current-source.json').exists())

    def test_alias_checksum_mismatch_is_not_accepted(self):
        payload=b'expected OSM'
        md5=hashlib.md5(payload).hexdigest()
        dated='https://download.geofabrik.de/europe/sweden-261122.osm.pbf'
        def download(args,**kwargs):
            if args[-1]==URL:
                Path(args[args.index('--output')+1]).write_bytes(b'different OSM')
                return subprocess.CompletedProcess(args,0)
            return subprocess.CompletedProcess(args,22)
        with tempfile.TemporaryDirectory() as temp:
            with patch('urllib.request.urlopen',return_value=Response((md5+'  sweden.osm.pbf\\n').encode(),dated+'.md5')):
                with patch('subprocess.run',side_effect=download):
                    with self.assertRaisesRegex(ValueError,'checksum mismatch'):
                        fetch_current_osm(temp)
            self.assertFalse(list(Path(temp).glob('*.osm.pbf')))
            self.assertFalse((Path(temp)/'current-source.json').exists())

    def test_rejects_bad_sidecar(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch('urllib.request.urlopen',return_value=Response(b'invalid','https://download.geofabrik.de/europe/sweden-261027.osm.pbf.md5')):
                with self.assertRaisesRegex(ValueError,'sidecar'):
                    fetch_current_osm(temp)

    def test_rejects_bad_redirect(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch('urllib.request.urlopen',return_value=Response(b'0'*32+b'  sweden.osm.pbf\n','https://other.example/sweden.osm.pbf.md5')):
                with self.assertRaisesRegex(ValueError,'redirect'):
                    fetch_current_osm(temp)

if __name__=='__main__':
    unittest.main()
