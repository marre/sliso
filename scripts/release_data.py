"""Package generated data for GitHub Releases, or verify/install a pinned release.

Only the small release descriptor belongs in Git. No GitHub/Trafiklab token is
needed when downloading the public release in a Cloudflare build.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

MAX_FILE = 25 * 1024 * 1024
# Both retained versions can contain physical footpath tiles. Browser requests
# still fetch only the nearby tiles; this limit applies to build-time archives.
MAX_ARCHIVE = 896 * 1024 * 1024
MAX_UNPACKED = 3 * 1024 * 1024 * 1024
VERSION = re.compile(r'sl-[0-9a-f]{20}')


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def member_path(name):
    parts = PurePosixPath(name).parts
    if name == 'manifest.json':
        return Path(name)
    if (len(parts) != 2 or not VERSION.fullmatch(parts[0])
            or not re.fullmatch(r'[A-Za-z0-9_-]+\.(json|bin)', parts[1])
            or str(PurePosixPath(name)) != name):
        raise ValueError('Unexpected data archive path: ' + name)
    return Path(*parts)


def validate(root):
    root = Path(root)
    manifest = json.loads((root / 'manifest.json').read_text())
    if manifest.get('schema') != 2 or manifest.get('demo') is not False or not VERSION.fullmatch(manifest['version']):
        raise ValueError('A real schema-2 dataset is required for publication')
    refs = [manifest[k] for k in ('stops', 'walks', 'routes', 'transfers', 'trips')]
    refs += [ref for entries in manifest['days'].values() for ref in entries]
    paths=manifest.get('footpaths')
    if paths:
        if paths.get('format')!='sliso-footpaths-v1' or paths.get('tileDegrees')!=.05 or not isinstance(paths.get('index'),dict):raise ValueError('Invalid footpath metadata')
        refs += list(paths['index'].values())
    water=manifest.get('waterMask')
    if water:
        if water.get('format')!='sliso-water-bitmap-v1' or water.get('resolution')!=512 or not 0.01<=water.get('tileDegrees',0)<=2 or not water.get('tiles'):
            raise ValueError('Invalid water mask metadata')
        refs+=list(water['tiles'].values())
        if any(ref.get('bytes') != 512*512//8 for ref in water['tiles'].values()):
            raise ValueError('Invalid water mask tile size')
    areas = manifest.get('walkingAreas', {})
    refs += areas.get('files', [])
    refs += areas.get('overview', {}).get('files', [])
    if manifest.get('walkingClosure'):
        refs.append(manifest['walkingClosure'])
    for ref in refs:
        prefix = '/data/' + manifest['version'] + '/'
        if not ref['url'].startswith(prefix):
            raise ValueError('Data reference does not belong to this manifest version')
        path = root / member_path(ref['url'].removeprefix('/data/'))
        if path.is_symlink() or not path.is_file() or path.stat().st_size != ref['bytes'] or digest(path) != ref['sha256']:
            raise ValueError('Data file missing or checksum/size mismatch: ' + ref['url'])
    if 'sources' in areas:
        sources = areas['sources']
        if set(sources) != set(areas['index']):
            raise ValueError('Contour source index mismatch')
        for layer in [areas] + ([areas['overview']] if 'overview' in areas else []):
            if set(layer['index']) != set(sources):
                raise ValueError('Contour layer coverage mismatch')
            groups = {}
            for sid, file in layer['index'].items():
                source = sources[sid]
                if type(source) is not int or source < 0 or type(file) is not int or not 0 <= file < len(layer['files']):
                    raise ValueError('Invalid contour index')
                if source in groups and groups[source] != file:
                    raise ValueError('Logical contour source split between files')
                groups[source] = file
    closure = manifest.get('walkingClosure')
    if closure:
        from walking_closure import validate as validate_closure, decode_walks, FORMAT
        if closure.get('format') != FORMAT or closure.get('maxMinutes') != manifest['walkingMaxMinutes']:
            raise ValueError('Unsupported walking closure metadata')
        validate_closure((root/member_path(closure['url'].removeprefix('/data/'))).read_bytes(),
                         json.loads((root/member_path(manifest['stops']['url'].removeprefix('/data/'))).read_bytes()),
                         decode_walks(json.loads((root/member_path(manifest['walks']['url'].removeprefix('/data/'))).read_bytes())),
                         manifest['walks']['sha256'], manifest['stops']['sha256'], closure['maxMinutes']*60)
    return manifest


def pack(root, output, descriptor, repository):
    root, output = Path(root), Path(output)
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ValueError('Invalid GitHub repository')
    manifest = validate(root)
    files = [root / 'manifest.json']
    # Include retained immutable versions for clients still using an old manifest.
    for directory in sorted(root.iterdir()):
        if directory.is_symlink() or not directory.is_dir() or not VERSION.fullmatch(directory.name):
            continue
        report = directory / 'report.json'
        if directory.name != manifest['version']:
            if not report.is_file():
                continue
            metadata = json.loads(report.read_text())
            if metadata.get('generator') != 'sliso-data-v2' or metadata.get('version') != directory.name:
                continue
        for path in sorted(directory.iterdir()):
            member_path(path.relative_to(root).as_posix())
            if path.is_symlink() or not path.is_file():
                raise ValueError('Unexpected non-file in generated data')
            files.append(path)
    total = sum(path.stat().st_size for path in files)
    if len(files) > 20000 or total > MAX_UNPACKED or any(path.stat().st_size >= MAX_FILE for path in files):
        raise ValueError('Generated data exceeds static asset budget')
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in files:
            # Stable ZIP metadata makes retries reproduce the same archive bytes.
            info = zipfile.ZipInfo(path.relative_to(root).as_posix(), date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(info, path.read_bytes())
    if output.stat().st_size > MAX_ARCHIVE:
        raise ValueError('Data archive exceeds download budget')
    release = dict(schema=1, version=manifest['version'], sourceVersion=manifest.get('sourceVersion'),
                   validFrom=manifest['validFrom'], validTo=manifest['validTo'],
                   url=f"https://github.com/{repository}/releases/download/data-{manifest['version']}/sliso-data.zip",
                   sha256=digest(output), bytes=output.stat().st_size, unpackedBytes=total, features={'footpaths':bool(manifest.get('footpaths')), 'walkingAreas':bool(manifest.get('walkingAreas')), 'walkingClosure':bool(manifest.get('walkingClosure'))})
    Path(descriptor).parent.mkdir(parents=True, exist_ok=True)
    Path(descriptor).write_text(json.dumps(release, indent=2) + '\n')
    return release


def install(archive_path, release, output):
    archive_path, output = Path(archive_path), Path(output)
    if (archive_path.stat().st_size != release['bytes'] or digest(archive_path) != release['sha256']):
        raise ValueError('Release archive checksum/size mismatch; existing data retained')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.sliso-release-', dir=output.parent) as temp:
        staging = Path(temp)
        with zipfile.ZipFile(archive_path) as archive:
            entries = archive.infolist()
            if (len(entries) > 20000 or len({e.filename for e in entries}) != len(entries)
                    or sum(e.file_size for e in entries) > MAX_UNPACKED):
                raise ValueError('Invalid archive size or duplicate entries')
            for entry in entries:
                path = staging / member_path(entry.filename)
                if entry.file_size >= MAX_FILE or stat.S_ISLNK(entry.external_attr >> 16):
                    raise ValueError('Invalid archive entry')
                path.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(entry) as source, path.open('wb') as target:
                    shutil.copyfileobj(source, target)
        manifest = validate(staging)
        if manifest['version'] != release['version']:
            raise ValueError('Release descriptor and manifest versions differ')
        output.mkdir(parents=True, exist_ok=True)
        # Check existing immutable directories before making any changes.
        directories = [p for p in staging.iterdir() if p.is_dir()]
        for directory in directories:
            existing = output / directory.name
            if existing.exists() or existing.is_symlink():
                if existing.is_symlink() or not existing.is_dir():
                    raise ValueError('Refusing to replace an unexpected data path')
                for path in directory.iterdir():
                    old = existing / path.name
                    if old.is_symlink() or not old.is_file() or digest(old) != digest(path):
                        raise ValueError('Existing immutable version differs; refusing replacement')
        for directory in directories:
            if not (output / directory.name).exists():
                directory.rename(output / directory.name)
        # Manifest switches only after all immutable files are present and verified.
        os.replace(staging / 'manifest.json', output / 'manifest.json')
    return manifest


def fetch(descriptor, output, force=False):
    output = Path(output)
    if (output / 'manifest.json').is_file() and not force:
        print('Existing local dataset retained. Use npm run data:pull to fetch the pinned release.')
        return
    if not Path(descriptor).is_file():
        raise ValueError('No pinned data release. Run Prepare SL data with publish_release=true, or explicitly generate local demo data.')
    release = json.loads(Path(descriptor).read_text())
    if (release.get('schema') != 1 or not VERSION.fullmatch(release['version'])
            or not re.fullmatch(r'https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/releases/download/data-' + release['version'] + r'/sliso-data\.zip', release['url'])
            or not re.fullmatch(r'[0-9a-f]{64}', release['sha256'])
            or not 0 < release['bytes'] <= MAX_ARCHIVE):
        raise ValueError('Invalid pinned release descriptor')
    print('Downloading verified data release ' + release['version'], flush=True)
    with tempfile.TemporaryDirectory(prefix='sliso-download-') as temp:
        archive = Path(temp) / 'sliso-data.zip'
        request = urllib.request.Request(release['url'], headers={'User-Agent': 'sliso-data-build/1'})
        with urllib.request.urlopen(request, timeout=90) as response, archive.open('wb') as target:
            downloaded = 0
            while chunk := response.read(1024 * 1024):
                downloaded += len(chunk)
                if downloaded > release['bytes']:
                    raise ValueError('Download exceeds expected release size')
                target.write(chunk)
        manifest = install(archive, release, output)
    print('Installed real data ' + manifest['version'] + ' (SHA-256 verified).')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    package = commands.add_parser('pack')
    package.add_argument('--root', required=True)
    package.add_argument('--output', required=True)
    package.add_argument('--descriptor', required=True)
    package.add_argument('--repository', required=True)
    download = commands.add_parser('fetch')
    download.add_argument('--descriptor', default='data/release.json')
    download.add_argument('--output', default='public/data')
    download.add_argument('--force', action='store_true')
    args = parser.parse_args()
    if args.command == 'pack':
        print(json.dumps(pack(args.root, args.output, args.descriptor, args.repository), indent=2))
    else:
        fetch(args.descriptor, args.output, args.force)
