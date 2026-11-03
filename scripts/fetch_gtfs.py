"""Fetch Trafiklab GTFS with verified TLS, no credential logging, and a persistent quota ledger.
Ledger initialization is explicit: --init-ledger. Restore it on every CI run. No retry loop.
A missing ledger stops automated downloads rather than resetting the quota silently.
"""
import argparse
import contextlib
import gzip
import hashlib
import json
import os
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import zlib
from datetime import datetime, timezone
from pathlib import Path


def fetch(output, ledger, initialize=False, persist=None):
    output, ledger = Path(output), Path(ledger)
    now = datetime.now(timezone.utc)
    day, month = now.date().isoformat(), now.strftime('%Y-%m')
    if not ledger.exists():
        if not initialize:
            raise ValueError('Quota ledger missing. Initialize explicitly after verifying remaining Trafiklab quota; never auto-reset in CI.')
        ledger.parent.mkdir(parents=True,exist_ok=True)
        ledger.write_text(json.dumps({'month':month,'attempts':0}))
    state=json.loads(ledger.read_text())
    if state.get('month') != month:
        state={'month':month,'attempts':0}
    if state.get('successDate') == day and output.exists() and hashlib.sha256(output.read_bytes()).hexdigest() == state.get('sha256'):
        if persist:
            persist(ledger)  # Also migrate a legacy journal on a source-cache hit.
        print('Reusing validated source from today; no download.')
        return
    if state['attempts'] >= 45:
        raise ValueError('Local monthly limit 45 reached (Bronze: 50 shared across all clients). Pausing; no paid fallback.')
    key=os.environ.get('TRAFIKLAB_GTFS_KEY')
    if not key:
        raise ValueError('TRAFIKLAB_GTFS_KEY missing; configure a CI secret, not a VITE_ variable.')
    state['attempts'] += 1
    ledger.write_text(json.dumps(state))  # Count failed attempts too, before network access.
    if persist:
        persist(ledger)  # A failed durable reservation MUST prevent the download.
    url='https://opendata.samtrafiken.se/gtfs/sl/sl.zip?' + urllib.parse.urlencode({'key':key})
    # Trafiklab requires client-side gzip support (GTFS Regional OpenAPI).
    # urllib otherwise sends Accept-Encoding: identity, which can cause HTTP 406.
    request = urllib.request.Request(url, headers={
        'Accept-Encoding': 'gzip',
        'Accept': 'application/zip',
        'User-Agent': 'sliso/0.1 GTFS data builder',
    })
    output.parent.mkdir(parents=True,exist_ok=True)
    temp = None
    try:
        with urllib.request.urlopen(request,timeout=120) as response:
            encoding = response.headers.get('Content-Encoding', '').strip().lower()
            if encoding not in ('', 'identity', 'gzip', 'x-gzip'):
                raise ValueError('Unsupported HTTP content encoding; archive was not used.')
            stream = gzip.GzipFile(fileobj=response) if encoding in ('gzip', 'x-gzip') else contextlib.nullcontext(response)
            with stream as body:
                with tempfile.NamedTemporaryFile(dir=output.parent,delete=False) as f:
                    temp=Path(f.name)
                    while chunk:=body.read(1024*1024):f.write(chunk)
        with zipfile.ZipFile(temp) as z:
            if z.testzip() or 'stops.txt' not in z.namelist():
                raise ValueError('GTFS archive failed integrity check')
        os.replace(temp,output)
        state.update(successDate=day,sha256=hashlib.sha256(output.read_bytes()).hexdigest())
        ledger.write_text(json.dumps(state))
        if persist:
            persist(ledger)
        print('GTFS downloaded and ZIP integrity verified.')
    except (gzip.BadGzipFile, EOFError, zlib.error):
        raise ValueError('GTFS HTTP gzip integrity check failed; archive was not used.') from None
    except urllib.error.HTTPError as e:
        raise ValueError(f'Trafiklab HTTP {e.code}; credentials and request URL withheld.') from None
    except urllib.error.URLError:
        raise ValueError('GTFS network/TLS failure; no retry or verification bypass.') from None
    finally:
        if temp and temp.exists():temp.unlink()

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',required=True);p.add_argument('--ledger',required=True);p.add_argument('--init-ledger',action='store_true');p.add_argument('--persist-ledger',action='store_true');a=p.parse_args()
    from persist_quota import persist
    try:fetch(a.output,a.ledger,a.init_ledger,persist if a.persist_ledger else None)
    except (ValueError,zipfile.BadZipFile) as e:
        print(str(e));raise SystemExit(1)
