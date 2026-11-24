"""Compact, time-independent boarding options from the selected GTFS feed."""
import re
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
    used_dates = set()

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
            used_dates.update(active_dates)
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
    return dict(
        schema=1, source='GTFS Regional SL', sourceVersion=source_version,
        validFrom=min(used_dates).isoformat(), validTo=max(used_dates).isoformat(),
        routes={rid: dict(line=routes_by_id[rid].get('route_short_name') or '',
                          name=routes_by_id[rid].get('route_long_name') or '',
                          routeType=int(routes_by_id[rid]['route_type']),
                          agencyId=routes_by_id[rid].get('agency_id') or '')
                for rid in sorted(used_routes)},
        areas=result)
