"""Repackage a pinned release without GTFS/OSM requests; retain old client assets.

Use release_data.py pack to publish the new immutable version after validation.
"""
import argparse
import copy
import hashlib
import json
import os
import tempfile
from pathlib import Path
from contour_bundles import bundle, manifest_fields
from contour_format import compact, FORMAT
from release_data import validate


def migrate(root):
    root = Path(root)
    source = validate(root)
    areas = source.get('walkingAreas', {})
    if areas.get('format') != FORMAT or areas.get('sources') is not None:
        raise ValueError('Requires unbundled native contours')
    old = source['version']
    stops = json.loads((root/source['stops']['url'].removeprefix('/data/')).read_bytes())
    native = dict(format=FORMAT, index=areas['index'], files={Path(r['url']).name:(root/r['url'].removeprefix('/data/')).read_bytes() for r in areas['files']})
    packed = bundle(native, stops)
    del native
    with tempfile.TemporaryDirectory(prefix='.bundles-', dir=root) as tmp:
        staging = Path(tmp)
        refs = {}
        for name, raw in packed['files'].items():
            (staging/name).write_bytes(raw)
            refs[name] = dict(url=name, bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
        fields = manifest_fields(packed, refs)
        version = 'sl-' + hashlib.sha256(compact([old, 'contour-spatial-v1', fields])).hexdigest()[:20]
        migrated = copy.deepcopy(source)
        migrated['version'] = version
        migrated['walkingAreas'] = fields
        core = [migrated[k] for k in ('stops','walks','routes','transfers','trips')]
        if 'serviceCatalog' in migrated:
            core.append(migrated['serviceCatalog'])
        core += [r for entries in migrated['days'].values() for r in entries]
        if migrated.get('walkingClosure'):
            core.append(migrated['walkingClosure'])
        for ref in core:
            path = root/ref['url'].removeprefix('/data/')
            target = staging/path.name
            if not target.exists():
                os.link(path, target)
            ref['url'] = '/data/'+version+'/'+path.name
        for ref in refs.values():
            ref['url'] = '/data/'+version+'/'+ref['url']
        report = json.loads((root/old/'report.json').read_bytes())
        report.update(version=version, packageBytes=sum(p.stat().st_size for p in staging.iterdir()),
                      contourBundles=dict(sourceVersion=old, targetBytes=256*1024, sourceFiles=len(areas['files']),
                                          detailFiles=len(fields['files']), overviewFiles=len(fields['overview']['files']),
                                          detailBytes=sum(r['bytes'] for r in fields['files']),
                                          overviewBytes=sum(r['bytes'] for r in fields['overview']['files']), losslessVerified=True))
        (staging/'report.json').write_bytes(compact(report))
        destination = root/version
        if destination.exists():
            raise ValueError('Immutable destination already exists')
        staging.rename(destination)
        # All assets now exist; roll the local manifest back on validation failure.
        pending = root/'.manifest.tmp'
        pending.write_bytes(compact(migrated))
        original = (root/'manifest.json').read_bytes()
        os.replace(pending, root/'manifest.json')
        try:
            validate(root)
        except Exception:
            pending.write_bytes(original); os.replace(pending, root/'manifest.json'); raise
    print(json.dumps(report['contourBundles'], indent=2), flush=True)
    return migrated


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    migrate(parser.parse_args().root)
