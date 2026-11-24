"""Migrate a verified compiled release to lossless contours without any GTFS/OSM request.

Retains the previous immutable version for already-open clients. Use release_data.py
pack afterwards; this command does not upload or change the pinned release.
"""
import argparse
import copy
import gzip
import hashlib
import json
import os
import tempfile
from pathlib import Path
from contour_format import delivery_profiles, decode_profiles, equivalent, FORMAT, compact
from release_data import validate


def convert(root):
    root = Path(root)
    manifest = validate(root)
    source_format=manifest['walkingAreas'].get('format')
    if source_format not in (None, FORMAT):
        raise ValueError('Unsupported contour format')
    previous = manifest['version']
    raw_before = raw_after = count = 0
    with tempfile.TemporaryDirectory(prefix='.contours-', dir=root) as tmp:
        staging = Path(tmp)
        refs = []
        for ref in manifest['walkingAreas']['files']:
            raw = (root / ref['url'].removeprefix('/data/')).read_bytes()
            if source_format == FORMAT:
                if raw[:2] == b'\x1f\x8b':
                    raise ValueError('Already compressed')
                native = decode_profiles(raw)
                packed = gzip.compress(raw, compresslevel=6, mtime=0)
            else:
                native = json.loads(raw)
                packed = delivery_profiles(native)
            if not equivalent(native, decode_profiles(packed)):
                raise ValueError('Lossless verification failed: ' + ref['url'])
            name = Path(ref['url']).stem + '.bin'
            (staging/name).write_bytes(packed)
            refs.append(dict(url=name, bytes=len(packed), sha256=hashlib.sha256(packed).hexdigest()))
            raw_before += len(raw);raw_after += len(packed);count += 1
            if count % 500 == 0:
                print(f'Losslessly verified {count} shards', flush=True)
        version = 'sl-' + hashlib.sha256(compact([previous, FORMAT, refs])).hexdigest()[:20]
        migrated = copy.deepcopy(manifest)
        migrated['version'] = version
        migrated['walkingAreas']['format'] = FORMAT
        migrated['walkingAreas']['files'] = refs
        for ref in refs:
            ref['url'] = '/data/' + version + '/' + ref['url']
        core = [migrated[k] for k in ('stops','walks','routes','transfers','trips')]
        if 'serviceCatalog' in migrated:
            core.append(migrated['serviceCatalog'])
        core += [r for entries in migrated['days'].values() for r in entries]
        for ref in core:
            source = root / ref['url'].removeprefix('/data/')
            target = staging / source.name
            if not target.exists():
                os.link(source, target)
            ref['url'] = '/data/' + version + '/' + source.name
        report = json.loads((root/previous/'report.json').read_bytes())
        report.update(version=version, packageBytes=sum(p.stat().st_size for p in staging.iterdir()), contourMigration=dict(sourceVersion=previous, format=FORMAT, shards=count, rawBefore=raw_before, rawAfter=raw_after, losslessVerified=True))
        (staging/'report.json').write_bytes(compact(report))
        destination = root/version
        if destination.exists():
            raise ValueError('Destination already exists')
        staging.rename(destination)
        # The renamed temporary directory is no longer present at its old path.
        pending = root/'.manifest.tmp'
        pending.write_bytes(compact(migrated))
        os.replace(pending, root/'manifest.json')
    validate(root)
    print(json.dumps(report['contourMigration'], indent=2), flush=True)
    return migrated

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    args = parser.parse_args()
    convert(args.root)
