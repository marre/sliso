"""Compile a GTFS ZIP + audited walking index into immutable sliso packages.
Mapped walking edges and explicitly labelled same-name access assumptions. Standard library only. See docs/data.md.
"""
from contour_format import delivery_profiles, FORMAT
import argparse
import csv
import hashlib
import io
import json
import os
import re
import shutil
import struct
import tempfile
import zipfile
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo('Europe/Stockholm')
MODE_TYPES = {0: 'tram', 1: 'metro', 2: 'rail', 3: 'bus', 4: 'boat', 100: 'rail', 109: 'rail', 400: 'metro', 401: 'metro', 700: 'bus', 900: 'tram', 1000: 'boat'}

def parse_date(s):
    return datetime.strptime(s.replace('-', ''), '%Y%m%d').date()

def gtfs_seconds(s):
    parts = s.split(':')
    if len(parts) != 3:
        raise ValueError('Invalid GTFS time')
    h, m, sec = map(int, parts)
    if h < 0 or not 0 <= m < 60 or not 0 <= sec < 60:
        raise ValueError('Invalid GTFS time')
    return h * 3600 + m * 60 + sec

def gtfs_epoch(day, seconds):
    # GTFS time is elapsed time from local noon minus 12 h, including DST days.
    noon = datetime.combine(day, datetime.min.time().replace(hour=12), TZ)
    return int(noon.timestamp()) - 43200 + seconds

def boarding_flags(row, kind):
    """GTFS 3 is driver coordination, not advance phone booking (2)."""
    field = 'pickup_type' if kind == 'pickup' else 'drop_off_type'
    booking = 'pickup_booking_rule_id' if kind == 'pickup' else 'drop_off_booking_rule_id'
    value = row.get(field) or '0'
    if value not in ('0','1','2','3'):
        raise ValueError('Unknown ' + field)
    if row.get(booking) or row.get('start_pickup_drop_off_window') or row.get('end_pickup_drop_off_window'):
        return 0
    return 3 if value == '3' else 1 if value == '0' else 0

def rows(z, name, required=False):
    if name not in z.namelist():
        if required:
            raise ValueError('Missing ' + name)
        return []
    return list(csv.DictReader(io.TextIOWrapper(z.open(name), encoding='utf-8-sig', newline='')))

def active_services(calendar, exceptions):
    services = defaultdict(set)
    for c in calendar:
        day, end = parse_date(c['start_date']), parse_date(c['end_date'])
        while day <= end:
            if c[['monday','tuesday','wednesday','thursday','friday','saturday','sunday'][day.weekday()]] == '1':
                services[day].add(c['service_id'])
            day += timedelta(days=1)
    for c in exceptions:
        day = parse_date(c['date'])
        if c['exception_type'] == '1':
            services[day].add(c['service_id'])
        elif c['exception_type'] == '2':
            services[day].discard(c['service_id'])
        else:
            raise ValueError('Invalid calendar exception')
    return services

def validate_walks(data, stops):
    if not data.get('version') or not 5 <= data.get('maxMinutes', 0) <= 30 or data.get('speedKmh') != 4.8:
        raise ValueError('Walking metadata must include version, maxMinutes 5–30 and speedKmh 4.8')
    bindings = {s['id']: s for s in data['stops']}
    ids = {s['id']: i for i, s in enumerate(stops)}
    edges, excluded = [], 0
    for e in data['edges']:
        if e.get('restricted'):
            excluded += 1
            continue
        if not e.get('source') or not isinstance(e['seconds'], (int, float)) or e['seconds'] <= 0 or e['seconds'] > data['maxMinutes'] * 60:
            raise ValueError('Walking edge lacks source or valid physical duration')
        if e.get('metres') is not None and (not isinstance(e['metres'], (int, float)) or not 0 <= e['metres'] < 100_000):
            raise ValueError('Invalid physical walking distance')
        for sid in (e['from'], e['to']):
            if sid not in ids or sid not in bindings:
                raise ValueError('Walking index references missing stop: ' + sid)
            stop, bound = stops[ids[sid]], bindings[sid]
            if abs(stop['lat'] - bound['lat']) > 0.000001 or abs(stop['lon'] - bound['lon']) > 0.000001:
                raise ValueError('Walking index has stale coordinates: ' + sid)
        seconds=e['seconds']
        a,b=bindings[e['from']],bindings[e['to']]
        # The raw station index includes endpoint access allowances. Moving
        # between two positions on the same identified platform uses no lift
        # or station entrance, so retain only its mapped walking cost.
        if not e['source'].startswith('Assumed ') and a.get('platformWay') and a.get('platformWay')==b.get('platformWay') and a.get('binding')==b.get('binding')=='identified-osm-platform':
            allowance=a.get('accessSeconds',0)+b.get('accessSeconds',0)
            if not 0<=allowance<=seconds:raise ValueError('Invalid station access allowance')
            seconds=max(1,seconds-allowance)
        edge = dict(from_=ids[e['from']], to=ids[e['to']], seconds=seconds, source=e['source'])
        if e.get('metres') is not None: edge['metres'] = e['metres']
        edges.append(edge)
    return [{'from': e.pop('from_'), **e} for e in edges], excluded

def compact_walks(walks):
    sources=list(dict.fromkeys(w['source'] for w in walks))
    ids={source:i for i,source in enumerate(sources)}
    return {'schema':1,'sources':sources,'edges':[[w['from'],w['to'],w['seconds'],w.get('metres'),ids[w['source']]] for w in walks]}


def publish(output, stops, routes, walks, transfers, trips, days, meta, report, areas=None, water=None):
    if areas:
        from contour_bundles import bundle
        areas = bundle(areas, stops)
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='.sliso-', dir=output))
    compact = lambda x: json.dumps(x, ensure_ascii=False, separators=(',', ':')).encode()
    try:
        time_files = {}
        day_files = {}
        for day, records in days.items():
            groups = defaultdict(list)
            for r in sorted(records,key=lambda r:r[2]):
                groups[r[2]//3600*3600].append(r)
            day_files[day] = []
            for hour, entries in sorted(groups.items()):
                for part in range(0,len(entries),100_000):
                    name=f"{day}-{(hour%86400)//3600:02d}-{part//100_000}.bin"
                    time_files[name]=b"".join(struct.pack("<9I",*r) for r in entries[part:part+100_000])
                    day_files[day].append((name,hour,hour+3600))
        walk_payload=compact(walks)
        if len(walk_payload)>8*1024*1024:walk_payload=compact(compact_walks(walks))
        files = {'trips.json': compact(trips), 'stops.json': compact(stops), 'routes.json': compact(routes), 'walks.json': walk_payload, 'transfers.json': compact(transfers)}
        from walking_closure import build as build_closure, supported as closure_supported, FORMAT as CLOSURE_FORMAT
        has_closure = closure_supported(stops, walks, meta['walkingMaxMinutes'])
        if has_closure:
            files['walking-closure.bin'], pairs = build_closure(stops, walks, meta['walkingMaxMinutes'], hashlib.sha256(walk_payload).hexdigest(), hashlib.sha256(files['stops.json']).hexdigest())
            report['walkingClosure'] = dict(pairs=pairs, bytes=len(files['walking-closure.bin']), witnessesVerified=True)
        files.update(time_files)
        if areas: files.update(areas['files'])
        if water: files.update(water['files'])
        fingerprint = hashlib.sha256(compact(meta) + (compact({k:v for k,v in areas.items() if k != 'files'}) if areas else b'') + (compact({k:v for k,v in water.items() if k != 'files'}) if water else b'') + b''.join(files[n] for n in sorted(files))).hexdigest()[:20]
        version = ('demo-' if meta['demo'] else 'sl-') + fingerprint
        refs = {}
        for name, raw in files.items():
            if len(raw) >= 25 * 1024 * 1024:
                raise ValueError(name + ' exceeds Cloudflare Pages 25 MiB file limit; partition before publishing')
            (staging / name).write_bytes(raw)
            refs[name] = {'url': '/data/' + version + '/' + name, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}
        report['packageBytes'] = sum(len(x) for x in files.values())
        report['connections'] = sum(len(x) for x in days.values())
        report['version'] = version
        report['generator'] = 'sliso-data-v2'
        (staging / 'report.json').write_bytes(compact(report))
        dest = output / version
        if not dest.exists():
            staging.rename(dest)
        manifest = dict(schema=2, version=version, **meta, trips=refs['trips.json'], days={d:[{**refs[n],'from':a,'until':b} for n,a,b in parts] for d,parts in day_files.items()}, **{k: refs[k + '.json'] for k in ('stops','routes','walks','transfers')})
        if has_closure: manifest['walkingClosure'] = dict(**refs['walking-closure.bin'], format=CLOSURE_FORMAT, maxMinutes=meta['walkingMaxMinutes'])
        if areas:
            from contour_bundles import manifest_fields
            manifest['walkingAreas'] = manifest_fields(areas, refs)
        if water:
            manifest['waterMask'] = dict(format='sliso-water-bitmap-v1',tileDegrees=water['tileDegrees'],resolution=water['resolution'],tiles={key:refs[name] for key,name in water['tiles'].items()})
        pending = output / '.manifest.tmp'
        pending.write_bytes(compact(manifest))
        os.replace(pending, output / 'manifest.json')
        print(json.dumps({k:v for k,v in report.items() if k not in ('routeInventory',)}, ensure_ascii=False, indent=2))
    finally:
        if staging.exists():
            shutil.rmtree(staging)

def compile_feed(feed, walking, output, start=None, scope=None, walking_areas=None, water_mask=None):
    from feed_scope import select_routes
    with zipfile.ZipFile(feed) as z:
        raw_stops = rows(z, 'stops.txt', True)
        all_routes = rows(z, 'routes.txt', True)
        all_trips = rows(z, 'trips.txt', True)
        rules = rows(z, 'transfers.txt')
        calendar, exceptions = rows(z, 'calendar.txt'), rows(z, 'calendar_dates.txt')
        agencies = rows(z, 'agency.txt', True)
        feed_info = rows(z, 'feed_info.txt')
        if any(a['agency_timezone'] != 'Europe/Stockholm' for a in agencies):
            raise ValueError('Only Europe/Stockholm GTFS supported')
        if rows(z, 'frequencies.txt'):
            raise ValueError('Frequency-based trips require expansion before import')
        if not calendar and not exceptions:
            raise ValueError('No actual service dates')
        if isinstance(scope, (str, Path)):
            scope = json.loads(Path(scope).read_text())
        routes_raw, scope_report = select_routes(all_routes, agencies, scope)
        route_ids = {r['route_id']: i for i,r in enumerate(routes_raw)}
        all_trip_ids = {t['trip_id'] for t in all_trips}
        trip_meta = {t['trip_id']: t for t in all_trips if t['route_id'] in route_ids}
        raw_times = defaultdict(list)
        types_by_stop, heads_by_stop = defaultdict(set), defaultdict(set)
        route_types = {r['route_id']: int(r['route_type']) for r in routes_raw}
        used_stops = set()
        max_secs, time_rows = 0, 0
        # Stream 1.6M+ CSV rows; retain compact tuples only for selected services.
        with io.TextIOWrapper(z.open('stop_times.txt'), encoding='utf-8-sig', newline='') as f:
            for st in csv.DictReader(f):
                if st['trip_id'] not in all_trip_ids:
                    raise ValueError('stop_times references unknown trip')
                if st['trip_id'] not in trip_meta:
                    continue
                if not st.get('arrival_time') or not st.get('departure_time'):
                    raise ValueError('Untimed stop requires explicit interpolation policy')
                arr, dep = gtfs_seconds(st['arrival_time']), gtfs_seconds(st['departure_time'])
                raw_times[st['trip_id']].append((st['stop_id'], arr, dep, int(st['stop_sequence']), boarding_flags(st,'pickup'), boarding_flags(st,'dropoff')))
                used_stops.add(st['stop_id'])
                types_by_stop[st['stop_id']].add(route_types[trip_meta[st['trip_id']]['route_id']])
                headsign=st.get('stop_headsign') or trip_meta[st['trip_id']].get('trip_headsign')
                if headsign: heads_by_stop[st['stop_id']].add(headsign)
                max_secs = max(max_secs, arr, dep)
                time_rows += 1
    parents = {s['stop_id']: s for s in raw_stops}
    stops = []
    for s in raw_stops:
        if (len(routes_raw)!=len(all_routes) and s['stop_id'] not in used_stops) or s.get('location_type','0') not in ('','0'):
            continue
        parent = parents.get(s.get('parent_station'), s)
        names={'bus':'Buss','metro':'Tunnelbana','rail':'Tåg','tram':'Spårvagn/lokalbana','boat':'Båt'}
        modes=sorted({MODE_TYPES[t] for t in types_by_stop[s['stop_id']] if t in MODE_TYPES})
        platform=('Läge '+s['platform_code'] if s.get('platform_code') else s['stop_name'])
        if modes: platform+=' · '+', '.join(names[m] for m in modes)
        heads=sorted(heads_by_stop[s['stop_id']])
        if heads: platform+=' mot '+' / '.join(heads[:2])+(' …' if len(heads)>2 else '')
        if not modes and not s.get('platform_code'): platform+=f" ({float(s['stop_lat']):.4f}, {float(s['stop_lon']):.4f})"
        stops.append(dict(id=s['stop_id'], name=s['stop_name'], station=parent['stop_name'], stationId=s.get('parent_station') or s['stop_id'], platform=platform, lat=float(s['stop_lat']), lon=float(s['stop_lon'])))
    if not stops or any(not -90 <= s['lat'] <= 90 or not -180 <= s['lon'] <= 180 for s in stops):
        raise ValueError('Missing or invalid boarding stops')
    stop_ids = {s['id']:i for i,s in enumerate(stops)}
    if len(stop_ids) != len(stops) or used_stops - stop_ids.keys():
        raise ValueError('Duplicate or unknown boarding stop IDs')
    routes = []
    for r in routes_raw:
        rt = int(r['route_type'])
        if rt not in MODE_TYPES:
            raise ValueError('Unmapped route_type ' + str(rt) + '; audit before import')
        short, long = r.get('route_short_name',''), r.get('route_long_name','')
        route=dict(id=r['route_id'], name=(short+' · '+long if short and long else long or short or r['route_id']), mode=MODE_TYPES[rt],shortName=short,description=r.get('route_desc',''),agencyId=r.get('agency_id',''))
        for source,target in [('route_color','color'),('route_text_color','textColor')]:
            if re.fullmatch('[0-9A-Fa-f]{6}',r.get(source,'')):route[target]='#'+r[source].lower()
        routes.append(route)
    trip_times = {}
    for tid, tt in raw_times.items():
        tt.sort(key=lambda s:s[3])
        if len({s[3] for s in tt}) != len(tt):
            raise ValueError('Duplicate stop_sequence')
        prev = -1
        converted = []
        for sid,arr,dep,seq,pick,drop in tt:
            if arr < prev or dep < arr:
                raise ValueError('Non-monotonic trip ' + tid)
            prev = dep
            converted.append((stop_ids[sid],arr,dep,seq,pick,drop))
        trip_times[tid] = converted
    del raw_times
    with open(walking) as f:
        walk_meta = json.load(f)
    from assumed_walks import refresh_assumed_walks
    refresh_assumed_walks(walk_meta,[dict(id=s['stop_id'],name=s['stop_name'],lat=float(s['stop_lat']),lon=float(s['stop_lon'])) for s in raw_stops if s.get('location_type','0') in ('','0')])
    from reviewed_walks import refresh_reviewed_walks
    refresh_reviewed_walks(walk_meta,[dict(id=s['stop_id'],name=s['stop_name'],lat=float(s['stop_lat']),lon=float(s['stop_lon'])) for s in raw_stops if s.get('location_type','0') in ('','0')])
    validate_walks(walk_meta,[dict(id=s['stop_id'],lat=float(s['stop_lat']),lon=float(s['stop_lon'])) for s in raw_stops if s.get('location_type','0') in ('','0')])
    scope_walks = {**walk_meta, 'edges':[e for e in walk_meta['edges'] if e['from'] in stop_ids and e['to'] in stop_ids]}
    walks, excluded = validate_walks(scope_walks, stops)
    areas = None
    if walking_areas:
        area_root = Path(walking_areas)
        area_index = json.loads((area_root/'index.json').read_text())
        if area_index['version'] != walk_meta['version'] or area_index['stepMinutes'] != 1:
            raise ValueError('Walking areas and physical walking index versions differ')
        bindings = {s['id']:s for s in walk_meta['stops']}
        originals = {s['stop_id']:s for s in raw_stops}
        for s in area_index['stops']:
            orig, bound = originals.get(s['id']), bindings.get(s['id'])
            if not orig or not bound or any(abs(float(orig['stop_'+k])-s[k])>1e-6 or abs(bound[k]-s[k])>1e-6 for k in ('lat','lon')):
                raise ValueError('Stale or unbound walking-area endpoint: '+s['id'])
        names = area_index['files']
        if any(Path(n).name != n or not n.startswith('areas-') or not n.endswith('.json') for n in names):
            raise ValueError('Invalid walking-area file name')
        areas = dict(format=FORMAT, files={n.removesuffix('.json')+'.bin':delivery_profiles(json.loads((area_root/n).read_bytes())) for n in names}, index={s['id']:names.index(s['file']) for s in area_index['stops'] if s['id'] in stop_ids})
        for stop in stops: stop['walkingArea'] = stop['id'] in areas['index']
    expanded = []
    child_index = defaultdict(list)
    for s in raw_stops:
        if s['stop_id'] in stop_ids:
            child_index[s.get('parent_station','')].append(stop_ids[s['stop_id']])
    def children(sid):
        if sid in stop_ids:
            return [stop_ids[sid]]
        if sid not in parents:
            raise ValueError('Unknown transfer stop')
        return child_index[sid]
    for r in rules:
        if any(r.get(k) and r[k] not in trip_meta for k in ('from_trip_id','to_trip_id')):
            if any(r.get(k) and r[k] not in all_trip_ids for k in ('from_trip_id','to_trip_id')):
                raise ValueError('Unknown scoped transfer trip')
            continue
        if any(r.get(k) and r[k] not in route_ids for k in ('from_route_id','to_route_id')):
            continue
        typ = int(r.get('transfer_type') or 0)
        if typ not in (0,1,2,3):
            raise ValueError('In-seat transfer types 4/5 require explicit vehicle-continuity support')
        for a in children(r['from_stop_id']):
            for b in children(r['to_stop_id']):
                rule = {'from':a,'to':b,'type':typ,'seconds':int(r.get('min_transfer_time') or 0)}
                if rule['seconds'] < 0:
                    raise ValueError('Negative transfer time')
                for src,dst in [('from_trip_id','fromTrip'),('to_trip_id','toTrip'),('from_route_id','fromRoute'),('to_route_id','toRoute')]:
                    if r.get(src):
                        rule[dst] = r[src]
                expanded.append(rule)
    # Rules reference GTFS base trip IDs, not a Cartesian product of service-day instances.
    used_services = {t['service_id'] for t in trip_meta.values()}
    services = {d:ids & used_services for d,ids in active_services(calendar,exceptions).items()}
    active_days = [d for d,ids in services.items() if ids]
    if not active_days:
        raise ValueError('No active services')
    first, last = min(active_days),max(active_days)
    begin = max(first,start or datetime.now(TZ).date())
    end = min(last,begin+timedelta(days=8))
    if begin >= end:
        raise ValueError('Feed does not cover an upcoming search day plus following traffic day')
    if max_secs > 7*86400:
        raise ValueError('Unsupported GTFS time beyond seven days')
    days = {}
    bucket = datetime.combine(begin,datetime.min.time(),TZ).astimezone(timezone.utc).date()
    bucket_end = datetime.combine(end+timedelta(days=1),datetime.min.time(),TZ).astimezone(timezone.utc).date()
    while bucket <= bucket_end:
        days[bucket.isoformat()] = []
        bucket += timedelta(days=1)
    trip_keys = []
    trips_by_service = defaultdict(list)
    for tid,t in trip_meta.items():
        trips_by_service[t['service_id']].append((tid,t))
    lookback = max_secs//86400+2
    for day,active in sorted(services.items()):
        if not begin-timedelta(days=lookback) <= day <= end:
            continue
        origin = gtfs_epoch(day,0)
        for service in sorted(active):
            for tid,t in trips_by_service[service]:
                tt = trip_times.get(tid,[])
                legs = []
                for a,b in zip(tt,tt[1:]):
                    dep,arr = origin+a[2],origin+b[1]
                    bucket = datetime.fromtimestamp(dep,timezone.utc).date().isoformat()
                    if bucket in days:
                        legs.append((bucket,(a[0],b[0],dep,arr,0,route_ids[t['route_id']],a[3],a[4],b[5])))
                if legs:
                    idx = len(trip_keys);trip_keys.append(day.isoformat()+':'+tid)
                    for bucket,record in legs:
                        days[bucket].append((*record[:4],idx,*record[5:]))
    # Keep every routing node and edge. Retirement affects presentation only,
    # and an OLD code with service in the published interval remains selectable.
    scheduled_stops={index for records in days.values() for record in records for index,flags in [(record[0],record[7]),(record[1],record[8])] if flags&1}
    platform_codes={s['stop_id']:s.get('platform_code','').strip() for s in raw_stops}
    for i,stop in enumerate(stops):
        stop['scheduled']=i in scheduled_stops
        if re.fullmatch(r'OLD\S*',platform_codes[stop['id']],re.IGNORECASE):
            stop['retired']=i not in scheduled_stops
    from transfer_walks import add_transfer_walks,update_walking_status,WARNING as TRANSFER_WARNING,POLICY as TRANSFER_POLICY
    walks,transfer_access=add_transfer_walks(stops,walks,expanded,walk_meta['maxMinutes'])
    update_walking_status(stops,walks)
    boarding_by_route=Counter(r[5] for records in days.values() for r in records if r[7]&1)
    unsupported_routes=[r['id'] for i,r in enumerate(routes) if not boarding_by_route[i]]
    gaps = len(stops)-len({w['from'] for w in walks})
    warnings = list(walk_meta.get('warnings',[]))
    if transfer_access['addedLinks']:warnings.append(TRANSFER_WARNING)
    if gaps:
        warnings.append(f'{gaps} hållplatslägen saknar utgående gånganslutning i underlaget.')
    if unsupported_routes: warnings.append(f'{len(unsupported_routes)} linjeposter saknar stödd påstigning inom det byggda tidsintervallet. Kalender- och bokningsvillkor redovisas i byggrapporten.')
    warnings.append('Trafikurval: '+scope_report['description'])
    warnings.append('Olika trip_id räknas konservativt som olika fordon. Telefonbokning (typ 2) och bokningsregler används inte. Typ 3 ingår: samordna med föraren/signalera för på- och avstigning.')
    source_version=feed_info[0].get('feed_version','') if feed_info else ''
    try: source_updated=parse_date(source_version).isoformat()
    except ValueError: source_updated=None
    meta = dict(demo=False,sourceVersion=source_version,sourceUpdated=source_updated,updated=datetime.now(timezone.utc).isoformat(),validFrom=begin.isoformat(),validTo=(end-timedelta(days=1)).isoformat(),walkingMaxMinutes=walk_meta['maxMinutes'],walkingSpeedKmh=4.8,walkingVersion=walk_meta['version']+'+'+TRANSFER_POLICY,transferWalking=transfer_access,walkingCoverage={'totalStops':len(stops),'boundStops':len({s['id'] for s in walk_meta['stops'] if s['id'] in stop_ids and not s.get('binding','').startswith('assumed-')}),'pairs':len(walks),'reviewed':walk_meta.get('reviewed',False)},warnings=warnings,attribution=['Planerad trafik: Trafiklab / Samtrafiken / SL']+walk_meta.get('attribution',[]))
    report = dict(transferWalking=transfer_access,stops=len(stops),retiredPlatforms=sum(s.get('retired',False) for s in stops),routes=len(routes),routeInventory=routes,scope=scope_report,modes=dict(Counter(r['mode'] for r in routes)),transferRows=len(rules),expandedRules=len(expanded),walkingEdges=len(walks),excludedRestricted=excluded,stopsWithoutOutgoingWalk=gaps,stopTimeRows=time_rows,routesWithoutSupportedBoarding=unsupported_routes,review='Not manually verified. Complete docs/review-cases.csv before pilot.')
    water=None
    if water_mask:
        root=Path(water_mask)
        index=json.loads((root/'index.json').read_text())
        if index.get('format')!='sliso-water-bitmap-v1' or index.get('schema')!=1 or index.get('resolution')!=512 or not 0.01<=index.get('tileDegrees',0)<=2:
            raise ValueError('Invalid generated water bitmap index')
        tiles=index.get('tiles')
        if not isinstance(tiles,dict) or not tiles:raise ValueError('Empty water bitmap tiles')
        water_files={}
        for key,name in tiles.items():
            x,y=map(int,key.split(','))
            if key!=f'{x},{y}' or name!=f'water-{x}_{y}.bin':raise ValueError('Invalid water bitmap tile name')
            raw=(root/name).read_bytes()
            if len(raw)!=512*512//8:raise ValueError('Invalid water bitmap tile size')
            water_files[name]=raw
        water=dict(files=water_files,tiles=tiles,tileDegrees=index['tileDegrees'],resolution=512)
    publish(output,stops,routes,walks,expanded,trip_keys,days,meta,report,areas,water)

if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--gtfs',required=True)
    p.add_argument('--walks',required=True)
    p.add_argument('--scope')
    p.add_argument('--walking-areas')
    p.add_argument('--footpaths')
    p.add_argument('--water-mask',help='Precomputed bitmaps from the same walking OSM source')
    p.add_argument('--output',default='public/data')
    p.add_argument('--from-date',type=parse_date)
    a=p.parse_args()
    compile_feed(a.gtfs,a.walks,a.output,a.from_date,a.scope,a.walking_areas,a.water_mask)

    if a.footpaths:
        from attach_footpaths import attach
        attach(a.output,a.footpaths)
