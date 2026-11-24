import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from service_catalog import build, partition, partition_id, INDEX_NAME
from build_data import active_services


class CatalogTests(unittest.TestCase):
    def test_rare_future_services_and_stop_specific_signs(self):
        area = '9021001001234000'
        stops = [
            dict(stop_id=area, stop_name='Start'),
            dict(stop_id='p1', stop_name='Platform 1', parent_station=area),
            dict(stop_id='p2', stop_name='Platform 2', parent_station=area),
            dict(stop_id='o', stop_name='Ormsta'),
            dict(stop_id='k', stop_name='Kårsta'),
            dict(stop_id='x', stop_name='Elsewhere'),
        ]
        routes = [dict(route_id='r', route_short_name='27', route_type='109'),
                  dict(route_id='other', route_short_name='27', route_type='700')]
        def trip(service, sign='', route='r'):
            return dict(service_id=service, trip_headsign=sign, route_id=route)
        trips = {'normal':trip('daily', 'Kårsta'),
                 'rare':trip('rare'), 'duplicate':trip('daily', 'Kårsta'),
                 'override':trip('daily', 'Ignored'),
                 'expired':trip('past', 'Expired'),
                 'removed':trip('cancelled', 'Cancelled'),
                 'restricted':trip('daily', 'Restricted'),
                 'bus':trip('daily', 'Bus', 'other')}
        def row(point, seq, pickup=1, sign=''):
            return point, 0, 0, seq, pickup, 1, sign
        times = {'normal':[row('p1',1),row('k',2)],
                 'rare':[row('p2',1),row('o',2)],
                 'duplicate':[row('p1',1),row('k',2)],
                 'override':[row('p1',1,sign='Special'),row('x',2)],
                 'expired':[row('p1',1),row('x',2)],
                 'removed':[row('p1',1),row('x',2)],
                 'restricted':[row('p1',1,0),row('x',2)],
                 'bus':[row('p2',1),row('x',2)]}
        services = active_services([], [
            dict(service_id=s,date=d,exception_type=t) for s,d,t in [
                ('daily','20261124','1'),('rare','20261224','1'),
                ('past','20261123','1'),('cancelled','20261124','1'),
                ('cancelled','20261124','2')]])
        result = build(stops,routes,trips,times,services,date(2026,11,24),'v1')
        self.assertEqual(result['validTo'],'2026-12-24')
        self.assertEqual(set(result['areas']),{area})
        entry = result['areas'][area]
        self.assertEqual(entry['slStopAreaId'],'1234')
        self.assertEqual(entry['stopPointIds'],['p1','p2'])
        self.assertEqual(entry['services'],[
            dict(routeId='other',destination='Bus'),
            dict(routeId='r',destination='Kårsta'),
            dict(routeId='r',destination='Ormsta'),
            dict(routeId='r',destination='Special')])
        self.assertEqual(result['routes']['r']['routeType'],109)
        self.assertEqual(result['routes']['other']['routeType'],700)
        self.assertEqual(result,build(stops,routes,trips,dict(reversed(list(times.items()))),services,date(2026,11,24),'v1'))


    def test_partition_paths_are_stable_and_self_contained(self):
        import json
        import hashlib
        area = '9021001001234000'
        catalog = dict(schema=1, source='GTFS Regional SL', sourceVersion='old',
                       validFrom='2026-11-24', validTo='2026-12-24',
                       routes={'r':dict(line='27'), 'b':dict(line='1')},
                       areas={area:dict(services=[dict(routeId='r',destination='Ormsta')]),
                              'other':dict(services=[dict(routeId='b',destination='Other')])})
        self.assertEqual(partition_id(area,64),18)
        self.assertEqual(partition_id('other',64),
                         int(hashlib.sha256(b'other').hexdigest()[:8],16)%64)
        first=partition(catalog)
        index=json.loads(first[INDEX_NAME])
        self.assertEqual(len(index['partitions']),64)
        ref=index['partitions']['18']
        shard=json.loads(first[ref['file']])
        self.assertEqual(shard['areas'][area]['services'][0]['destination'],'Ormsta')
        self.assertEqual(shard['routes']['r']['line'],'27')
        second=partition(dict(catalog,sourceVersion='new',validFrom='2026-11-25'))
        self.assertNotEqual(first[INDEX_NAME],second[INDEX_NAME])
        self.assertEqual({k:v for k,v in first.items() if k!=INDEX_NAME},
                         {k:v for k,v in second.items() if k!=INDEX_NAME})
        catalog['areas'][area]['services'][0]['destination']='Kårsta'
        changed=json.loads(partition(catalog)[INDEX_NAME])
        self.assertEqual([n for n in index['partitions']
                          if index['partitions'][n]!=changed['partitions'][n]],['18'])
