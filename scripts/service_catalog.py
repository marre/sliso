"""Compact, time-independent boarding options from the selected GTFS feed."""
import argparse
import hashlib
import json
import os
import re
import shutil
import tempfile
from pathlib import Path
from collections import defaultdict


def build(raw_stops, routes, trips, stop_times, services, begin, source_version):
    """Use every remaining service date, not just the routing horizon.

    stop_times contains the compiler's validated GTFS tuples, including
    the original stop_headsign. No departure times enter the output.
    """
    dates = defaultdict(list)
    for day, active in services.items():
        if day >= begin:
            for service in active:
                dates[service].append(day)
    stops = {s['stop_id']: s for s in raw_stops}
    routes_by_id = {r['route_id']: r for r in routes}
    areas = {}
    used_routes = set()
    used_services = set()

    def area_for(point_id):
        point = stops[point_id]
        area_id = point.get('parent_station') or point_id
        return area_id, stops[area_id]

    for trip_id, times in stop_times.items():
        trip = trips[trip_id]
        active_dates = dates.get(trip['service_id'])
        if not active_dates or len(times) < 2:
            continue
        # The compiler has already sorted by stop_sequence and validated IDs.
        terminal = area_for(times[-1][0])[1]['stop_name']
        route_id = trip['route_id']
        for point_id, _, _, _, pickup, _, headsign in times[:-1]:
            if not pickup & 1:
                continue
            area_id, area = area_for(point_id)
            destination = (headsign.strip() or
                           (trip.get('trip_headsign') or '').strip() or
                           terminal.strip())
            if not destination:
                raise ValueError('Missing destination for trip ' + trip_id)
            entry = areas.setdefault(area_id, dict(
                name=area['stop_name'], points=set(), services=set()))
            entry['points'].add(point_id)
            entry['services'].add((route_id, destination))
            used_routes.add(route_id)
            used_services.add(trip['service_id'])
    if not areas:
        raise ValueError('No boardable services for traffic catalogue')

    result = {}
    for area_id, entry in sorted(areas.items()):
        item = dict(name=entry['name'], stopPointIds=sorted(entry['points']),
                    services=[dict(routeId=r, destination=d)
                              for r, d in sorted(entry['services'])])
        # SL stop-area GID (not SiteID). Preserve the full identifier and
        # exact stop-point GIDs even where this SL-specific format is absent.
        match = re.fullmatch(r'9021001(\d{6})000', area_id)
        if match:
            item['slStopAreaId'] = str(int(match[1]))
        result[area_id] = item
    used_dates = [day for service in used_services for day in dates[service]]
    return dict(
        schema=1, source='GTFS Regional SL', sourceVersion=source_version,
        validFrom=min(used_dates).isoformat(), validTo=max(used_dates).isoformat(),
        routes={rid: dict(line=routes_by_id[rid].get('route_short_name') or '',
                          name=routes_by_id[rid].get('route_long_name') or '',
                          routeType=int(routes_by_id[rid]['route_type']),
                          agencyId=routes_by_id[rid].get('agency_id') or '')
                for rid in sorted(used_routes)},
        areas=result)


PARTITION_COUNT = 64
PARTITION_METHOD = 'sl-stop-area-modulo-or-sha256-u32be-v1'
FORMAT = 'sliso-service-catalog-v2'
INDEX_NAME = 'service-catalog.json'
PUBLIC_DIR = 'service-catalog'


def partition_id(area_id, count):
    if type(count) is not int or not 1 <= count <= 256:
        raise ValueError('Invalid catalogue partition count')
    match = re.fullmatch(r'9021001(\d{6})000', area_id)
    number = int(match[1]) if match else int.from_bytes(
        hashlib.sha256(area_id.encode('utf-8')).digest()[:4], 'big')
    return number % count


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':')).encode('utf-8')


def partition(catalog, count=PARTITION_COUNT):
    """Each shard is self-contained and independent of feed dates/version."""
    buckets = [{} for _ in range(count)]
    for area_id, area in catalog['areas'].items():
        buckets[partition_id(area_id, count)][area_id] = area
    files, refs = {}, {}
    for number, areas in enumerate(buckets):
        route_ids = {service['routeId'] for area in areas.values()
                     for service in area['services']}
        raw = encode(dict(schema=1, partition=number, areas=areas,
                          routes={rid: catalog['routes'][rid] for rid in route_ids}))
        sha = hashlib.sha256(raw).hexdigest()
        name = f'part-{number}-{sha}.json'
        files[name] = raw
        refs[str(number)] = dict(file=name, sha256=sha, bytes=len(raw))
    index = {key: catalog[key] for key in ('schema', 'source', 'sourceVersion',
                                          'validFrom', 'validTo')}
    index.update(partitionCount=count, partitionMethod=PARTITION_METHOD, partitions=refs)
    files[INDEX_NAME] = encode(index)
    return files


def read_verified(path, ref):
    if (path.is_symlink() or not path.is_file() or path.stat().st_size != ref['bytes']
            or hashlib.sha256(path.read_bytes()).hexdigest() != ref['sha256']):
        raise ValueError('Service catalogue checksum/size mismatch: ' + str(path))
    return path.read_bytes()


def shard_refs(directory, index):
    count = index.get('partitionCount')
    if (index.get('schema') != 1 or index.get('partitionMethod') != PARTITION_METHOD
            or type(count) is not int or not 1 <= count <= 256
            or set(index.get('partitions', {})) != {str(i) for i in range(count)}):
        raise ValueError('Invalid service catalogue index')
    for number, ref in index['partitions'].items():
        sha = ref.get('sha256', '')
        name = f'part-{number}-{sha}.json'
        if not re.fullmatch(r'[0-9a-f]{64}', sha) or ref.get('file') != name:
            raise ValueError('Invalid service catalogue partition filename')
        yield directory / name, ref


def version_refs(root, manifest):
    """References for release validation and immutable-version migrations."""
    ref = manifest.get('serviceCatalog')
    if ref is None:
        return []
    if ref.get('format') != FORMAT or ref.get('url') != f"/data/{manifest['version']}/{INDEX_NAME}":
        raise ValueError('Invalid service catalogue format or URL')
    directory = Path(root) / manifest['version']
    index = json.loads(read_verified(directory / INDEX_NAME, ref))
    return [ref] + [dict(url=f"/data/{manifest['version']}/{path.name}",
                         sha256=part['sha256'], bytes=part['bytes'])
                    for path, part in shard_refs(directory, index)]


def expose(root):
    """Publish stable, content-addressed URLs from the validated release.

    The ZIP and immutable data versions remain the source of truth. Only
    generated public aliases are replaced; old/unrelated data is untouched.
    """
    root = Path(root)
    manifest = json.loads((root / 'manifest.json').read_bytes())
    target = root / PUBLIC_DIR
    if target.is_symlink() or (target.exists() and not target.is_dir()):
        raise ValueError('Invalid catalogue public directory')
    refs = version_refs(root, manifest)
    if not refs:
        if target.exists():
            shutil.rmtree(target)
        return
    # Stage current index and shards, plus shards of any retained data versions.
    # A cached old index may be retried against the current manifest if its
    # version is no longer included in the release.
    with tempfile.TemporaryDirectory(prefix='.catalog-', dir=root) as tmp:
        staging = Path(tmp)
        for ref in refs:
            source = root / ref['url'].removeprefix('/data/')
            raw = read_verified(source, ref)
            name = 'manifest.json' if source.name == INDEX_NAME else source.name
            (staging / name).write_bytes(raw)
        for directory in sorted(root.iterdir()):
            if (directory.is_symlink() or not directory.is_dir()
                    or directory.name == manifest['version']
                    or not re.fullmatch(r'sl-[0-9a-f]{20}', directory.name)
                    or not (directory / INDEX_NAME).is_file()):
                continue
            index = json.loads((directory / INDEX_NAME).read_bytes())
            for source, ref in shard_refs(directory, index):
                if not (staging / source.name).exists():
                    (staging / source.name).write_bytes(read_verified(source, ref))
        # Build-time only; the static deployment switches all files together.
        if target.exists():
            shutil.rmtree(target)
        os.replace(staging, target)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default='public/data')
    expose(parser.parse_args().root)
