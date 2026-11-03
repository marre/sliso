import io
import gzip
import json
import os
import sys
import tempfile
import unittest
import urllib.error
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from fetch_gtfs import fetch

class Response(io.BytesIO):
    def __init__(self, content, encoding=''):
        super().__init__(content)
        self.headers = {'Content-Encoding': encoding}

class QuotaTests(unittest.TestCase):
    def test_missing_ledger_and_quota_block_before_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);ledger=root/'quota.json'
            with patch('urllib.request.urlopen') as req:
                with self.assertRaisesRegex(ValueError,'ledger missing'):fetch(root/'sl.zip',ledger)
                ledger.write_text(json.dumps({'month':datetime.now(timezone.utc).strftime('%Y-%m'),'attempts':45}))
                with self.assertRaisesRegex(ValueError,'limit 45'):fetch(root/'sl.zip',ledger)
                req.assert_not_called()
    def test_failed_request_counts_and_does_not_expose_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);ledger=root/'quota.json'
            with patch.dict(os.environ,{'TRAFIKLAB_GTFS_KEY':'NOT-A-REAL-KEY'}),patch('urllib.request.urlopen',side_effect=urllib.error.URLError('secret URL')):
                with self.assertRaisesRegex(ValueError,'network/TLS failure') as error:fetch(root/'sl.zip',ledger,True)
                self.assertNotIn('secret URL',str(error.exception))
                self.assertEqual(json.loads(ledger.read_text())['attempts'],1)
    def test_durable_reservation_failure_prevents_network_access(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            def fail(ledger):
                self.assertEqual(json.loads(ledger.read_text())['attempts'],1)
                raise RuntimeError('push failed')
            with patch.dict(os.environ,{'TRAFIKLAB_GTFS_KEY':'fake'}),patch('urllib.request.urlopen') as req:
                with self.assertRaisesRegex(RuntimeError,'push failed'):
                    fetch(root/'sl.zip',root/'quota.json',True,fail)
                req.assert_not_called()

    def test_same_day_reuses_verified_zip(self):
        raw=io.BytesIO()
        with zipfile.ZipFile(raw,'w') as z:z.writestr('stops.txt','stop_id\na')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);ledger=root/'quota.json';out=root/'sl.zip'
            with patch.dict(os.environ,{'TRAFIKLAB_GTFS_KEY':'NOT-A-REAL-KEY'}),patch('urllib.request.urlopen',return_value=Response(raw.getvalue())) as req:
                fetch(out,ledger,True)
                saved=[]
                fetch(out,ledger,persist=lambda p:saved.append(json.loads(p.read_text())))
                self.assertEqual(saved[0]['attempts'],1)
                self.assertEqual(req.call_count,1)
                self.assertEqual(json.loads(ledger.read_text())['attempts'],1)

    def test_required_gzip_header_and_http_decompression_before_zip_validation(self):
        raw=io.BytesIO()
        with zipfile.ZipFile(raw,'w') as z:z.writestr('stops.txt','stop_id\na')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);ledger=root/'quota.json';out=root/'sl.zip'
            with patch.dict(os.environ,{'TRAFIKLAB_GTFS_KEY':'NOT-A-REAL-KEY'}),patch('urllib.request.urlopen',return_value=Response(gzip.compress(raw.getvalue()),'gzip')) as req:
                fetch(out,ledger,True)
                request=req.call_args.args[0]
                self.assertEqual(request.get_header('Accept-encoding'),'gzip')
                self.assertEqual(request.get_header('Accept'),'application/zip')
                self.assertEqual(out.read_bytes(),raw.getvalue())
                with zipfile.ZipFile(out) as z:self.assertIsNone(z.testzip())
                self.assertEqual(json.loads(ledger.read_text())['attempts'],1)

    def test_corrupt_http_gzip_does_not_replace_existing_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);out=root/'sl.zip';out.write_bytes(b'previous valid source')
            with patch.dict(os.environ,{'TRAFIKLAB_GTFS_KEY':'NOT-A-REAL-KEY'}),patch('urllib.request.urlopen',return_value=Response(b'not gzip','gzip')):
                with self.assertRaisesRegex(ValueError,'gzip integrity'):
                    fetch(out,root/'quota.json',True)
            self.assertEqual(out.read_bytes(),b'previous valid source')
            self.assertEqual(sorted(p.name for p in root.iterdir()),['quota.json','sl.zip'])

    def test_http_error_never_prints_provider_body_or_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            error=urllib.error.HTTPError('secret request URL',406,'Not Acceptable',{},io.BytesIO(b'{"errorMessage":"Key NOT-A-REAL-KEY is invalid"}'))
            with patch.dict(os.environ,{'TRAFIKLAB_GTFS_KEY':'NOT-A-REAL-KEY'}),patch('urllib.request.urlopen',side_effect=error):
                with self.assertRaisesRegex(ValueError,'HTTP 406') as caught:
                    fetch(root/'sl.zip',root/'quota.json',True)
            self.assertNotIn('NOT-A-REAL-KEY',str(caught.exception))
            self.assertNotIn('secret request URL',str(caught.exception))
