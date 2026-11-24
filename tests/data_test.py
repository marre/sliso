import csv
import io
import json
import struct
import sys
import tempfile
import unittest
import zipfile
from datetime import date, datetime, timezone
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from build_data import active_services, compile_feed, gtfs_epoch, gtfs_seconds, validate_walks, compact_walks

class DataTests(unittest.TestCase):
    def test_compact_walks_preserves_costs_and_distinct_provenance(self):
        walks=[dict(from_=1,to=2,seconds=60.5,metres=80,source='OSM'),dict(from_=2,to=1,seconds=70,source='station')]
        walks=[{'from':w.pop('from_'),**w} for w in walks]
        packed=compact_walks(walks)
        self.assertEqual(packed,{'schema':1,'sources':['OSM','station'],'edges':[[1,2,60.5,80,0],[2,1,70,None,1]]})
    def test_calendar_exception(self):
        calendar=[dict(service_id='a',start_date='20261019',end_date='20261020',monday='1',tuesday='1',wednesday='0',thursday='0',friday='0',saturday='0',sunday='0')]
        services=active_services(calendar,[dict(service_id='a',date='20261019',exception_type='2'),dict(service_id='b',date='20261019',exception_type='1')])
        self.assertEqual(services[date(2026,10,19)],{'b'})
        self.assertEqual(services[date(2026,10,20)],{'a'})
    def test_gtfs_dst_and_over_24(self):
        self.assertEqual(gtfs_seconds('25:30:00'),91800)
        self.assertEqual(gtfs_epoch(date(2026,10,19),90000),int(datetime(2026,10,19,23,tzinfo=timezone.utc).timestamp()))
        # Noon-minus-12h per GTFS, not naive local midnight on transition dates.
        self.assertEqual(gtfs_epoch(date(2026,3,29),3*3600),int(datetime(2026,3,29,1,tzinfo=timezone.utc).timestamp()))
        self.assertEqual(gtfs_epoch(date(2026,10,25),3*3600),int(datetime(2026,10,25,2,tzinfo=timezone.utc).timestamp()))
        with self.assertRaises(ValueError):gtfs_seconds('00:70:00')
    def walks(self):
        return dict(version='v1',maxMinutes=30,speedKmh=4.8,stops=[dict(id='a',lat=59,lon=18),dict(id='b',lat=59.1,lon=18)],edges=[{'from':'a','to':'b','seconds':240,'source':'audited fixture'}])
    def test_same_platform_walk_does_not_pay_station_entrance_allowances(self):
        data=self.walks();data['edges'][0]['seconds']=264
        for s in data['stops']:s.update(platformWay=42,binding='identified-osm-platform',accessSeconds=120)
        self.assertEqual(validate_walks(data,self.stops())[0][0]['seconds'],24)
        data['stops'][1]['platformWay']=43
        self.assertEqual(validate_walks(data,self.stops())[0][0]['seconds'],264)
        data['stops'][1]['platformWay']=42;data['edges'][0]['seconds']=240
        self.assertEqual(validate_walks(data,self.stops())[0][0]['seconds'],1)
        data['edges'][0]['seconds']=239
        with self.assertRaisesRegex(ValueError,'station access'):validate_walks(data,self.stops())
    def test_assumed_walk_never_refunds_a_mapped_platform_allowance(self):
        from assumed_walks import SOURCE
        data=self.walks();data['edges'][0].update(seconds=60,source=SOURCE)
        for s in data['stops']:s.update(platformWay=42,binding='identified-osm-platform',accessSeconds=120)
        self.assertEqual(validate_walks(data,self.stops())[0][0]['seconds'],60)
    def stops(self):
        return self.walks()['stops']
    def test_A20_known_time_restrictions_excluded(self):
        w=self.walks();w['edges'][0]['restricted']=True
        edges,excluded=validate_walks(w,self.stops());self.assertEqual(edges,[]);self.assertEqual(excluded,1)
    def test_A22_stale_walking_binding_rejected(self):
        stops=self.stops();stops[1]['lat']+=.001
        with self.assertRaisesRegex(ValueError,'stale'):validate_walks(self.walks(),stops)
        w=self.walks();w['edges'][0]['to']='missing'
        with self.assertRaisesRegex(ValueError,'missing'):validate_walks(w,self.stops())
    def test_walking_time_is_not_transfer_minimum(self):
        w=self.walks();edges,_=validate_walks(w,self.stops());self.assertEqual(edges[0]['seconds'],240)
        w['edges'][0]['source']=''
        with self.assertRaises(ValueError):validate_walks(w,self.stops())
    def fixture(self, root, broken=False, route_type='3'):
        tables={
        'agency.txt':[['agency_id','agency_name','agency_url','agency_timezone'],['sl','SL','https://sl.se','Europe/Stockholm']],
        'stops.txt':[['stop_id','stop_name','stop_lat','stop_lon','location_type','parent_station'],['a','Start','59','18','0',''],['b','Mål','59.1','18','0','']],
        'routes.txt':[['route_id','route_short_name','route_type','agency_id'],['r','1',route_type,'sl']],
        'trips.txt':[['route_id','service_id','trip_id'],['r','s','t']],
        'stop_times.txt':[['trip_id','arrival_time','departure_time','stop_id','stop_sequence'],['t','25:00:00','25:00:00','a','1'],['t','25:10:00','25:10:00','b','2']],
        'calendar_dates.txt':[['service_id','date','exception_type'],['s','20261019','1'],['s','20261020','1']],
        'transfers.txt':[['from_stop_id','to_stop_id','transfer_type','min_transfer_time'],['a','b','2','420']]}
        if broken:tables['routes.txt'][1][2]='9999'
        path=root/'feed.zip'
        with zipfile.ZipFile(path,'w') as z:
            for name,rows in tables.items():
                b=io.StringIO();csv.writer(b).writerows(rows);z.writestr(name,b.getvalue())
        walkfile=root/'walk.json';walkfile.write_text(json.dumps(self.walks()))
        return path,walkfile
    def test_compile_refreshes_cached_estimates_against_current_feed_names_and_coordinates(self):
        from assumed_walks import extend_index
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);feed,w=self.fixture(root);out=root/'out'
            old=[dict(id=i,name='Old common name',lat=59.,lon=18.) for i in ('a','b')]
            cached=extend_index(dict(version='v9',maxMinutes=30,speedKmh=4.8,stops=[],edges=[],warnings=[]),old)
            w.write_text(json.dumps(cached))
            compile_feed(feed,w,out,date(2026,10,19))
            m=json.loads((out/'manifest.json').read_text())
            walks=json.loads((out/m['walks']['url'].removeprefix('/data/')).read_text())
            self.assertEqual(walks,[])
    def test_service_catalog_is_published_and_verified(self):
        from release_data import validate
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);feed,w=self.fixture(root);out=root/'out'
            compile_feed(feed,w,out,date(2026,10,19))
            manifest=validate(out)
            ref=manifest['serviceCatalog']
            path=out/ref['url'].removeprefix('/data/')
            from service_catalog import partition_id, expose
            index=json.loads(path.read_text())
            shard=index['partitions'][str(partition_id('a',index['partitionCount']))]
            shard_path=path.parent/shard['file']
            catalog=json.loads(shard_path.read_text())
            self.assertEqual(catalog['areas']['a']['services'],[dict(routeId='r',destination='Mål')])
            self.assertNotIn('b',catalog['areas'])
            expose(out)
            public=out/'service-catalog'
            self.assertEqual(json.loads((public/'manifest.json').read_text()),index)
            self.assertEqual((public/shard['file']).read_bytes(),shard_path.read_bytes())
            shard_path.write_text('{}')
            with self.assertRaisesRegex(ValueError,'checksum'):
                validate(out)

    def test_route_branding_metadata_survives_gtfs_import(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);feed,w=self.fixture(root);out=root/'out'
            with zipfile.ZipFile(feed) as z:contents={name:z.read(name) for name in z.namelist()}
            table=list(csv.reader(io.StringIO(contents['routes.txt'].decode())))
            table[0].extend(['route_desc','route_color','route_text_color'])
            table[1].extend(['blåbuss','007DB8','FFFFFF'])
            text=io.StringIO();csv.writer(text).writerows(table);contents['routes.txt']=text.getvalue().encode()
            with zipfile.ZipFile(feed,'w') as z:
                for name,raw in contents.items():z.writestr(name,raw)
            compile_feed(feed,w,out,date(2026,10,19))
            m=json.loads((out/'manifest.json').read_text())
            route=json.loads((out/m['routes']['url'].removeprefix('/data/')).read_text())[0]
            self.assertEqual((route['shortName'],route['description'],route['agencyId']),('1','blåbuss','sl'))
            self.assertEqual((route['color'],route['textColor']),('#007db8','#ffffff'))

    def test_old_platform_metadata_uses_published_service_without_deleting_nodes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);feed,w=self.fixture(root);out=root/'out'
            with zipfile.ZipFile(feed) as z:
                contents={name:z.read(name) for name in z.namelist()}
            table=list(csv.reader(io.StringIO(contents['stops.txt'].decode())))
            table[0].append('platform_code');table[1].append('OLD');table[2].append('A')
            table.extend([['c','Utgången','59.0003','18','0','','OLD2'],['d','Koldalsvägen','59.0005','18','0','','A']])
            text=io.StringIO();csv.writer(text).writerows(table);contents['stops.txt']=text.getvalue().encode()
            with zipfile.ZipFile(feed,'w') as z:
                for name,raw in contents.items():z.writestr(name,raw)
            compile_feed(feed,w,out,date(2026,10,19))
            manifest=json.loads((out/'manifest.json').read_text())
            stops=json.loads((out/manifest['stops']['url'].removeprefix('/data/')).read_bytes())
            self.assertEqual([s['id'] for s in stops],['a','b','c','d'])
            self.assertIs(stops[0]['retired'],False)  # OLD platform has actual published service.
            self.assertIs(stops[2]['retired'],True)
            self.assertNotIn('retired',stops[3])  # A real name containing "old".
            self.assertIs(stops[3]['scheduled'],False)  # Non-OLD, but no published boarding/alighting.
            self.assertIs(stops[0]['scheduled'],True)
            walks=json.loads((out/manifest['walks']['url'].removeprefix('/data/')).read_bytes())
            self.assertEqual((walks[0]['from'],walks[0]['to']),(0,1))
            report=json.loads((out/manifest['version']/'report.json').read_text())
            self.assertEqual(report['retiredPlatforms'],1)

    def test_sl_metro_401_compiles_as_metro(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);feed,w=self.fixture(root,route_type='401');out=root/'out'
            compile_feed(feed,w,out,date(2026,10,19))
            manifest=json.loads((out/'manifest.json').read_text())
            routes=json.loads((out/manifest['routes']['url'].removeprefix('/data/')).read_text())
            self.assertEqual(routes[0]['mode'],'metro')
    def test_area_publication_checks_bindings_and_keeps_network_distances(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);feed,w=self.fixture(root);out=root/'out';area=root/'areas';area.mkdir()
            walks=json.loads(w.read_text());walks['edges'][0]['metres']=300;w.write_text(json.dumps(walks))
            (area/'areas-0000.json').write_text(json.dumps({'a':[{'minutes':1,'geometry':{'type':'Polygon','coordinates':[[[18,59],[18.001,59],[18,59.001],[18,59]]]}}]}))
            index=dict(version='v1',stepMinutes=1,files=['areas-0000.json'],stops=[dict(id='a',lat=59,lon=18,file='areas-0000.json')])
            (area/'index.json').write_text(json.dumps(index))
            compile_feed(feed,w,out,date(2026,10,19),walking_areas=area)
            m=json.loads((out/'manifest.json').read_text());self.assertEqual(m['walkingAreas']['index'],{'a':0})
            self.assertEqual(m['walkingAreas']['format'],'sliso-contours-v1')
            self.assertTrue(m['walkingAreas']['files'][0]['url'].endswith('.bin'))
            self.assertTrue((out/m['walkingAreas']['files'][0]['url'].removeprefix('/data/')).exists())
            edges=json.loads((out/m['walks']['url'].removeprefix('/data/')).read_text());self.assertEqual(edges[0]['metres'],300)
            previous=(out/'manifest.json').read_bytes();index['stops'][0]['lat']+=.001;(area/'index.json').write_text(json.dumps(index))
            with self.assertRaisesRegex(ValueError,'Stale'):compile_feed(feed,w,out,date(2026,10,19),walking_areas=area)
            self.assertEqual((out/'manifest.json').read_bytes(),previous)

    def test_complete_compile_checksum_midnight_and_atomic_failure(self):
        import hashlib
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);feed,w=self.fixture(root);out=root/'out'
            compile_feed(feed,w,out,date(2026,10,19))
            m=json.loads((out/'manifest.json').read_text());self.assertFalse(m['demo'])
            ref=m['days']['2026-10-19'][0];raw=(out/ref['url'].removeprefix('/data/')).read_bytes()
            self.assertEqual(hashlib.sha256(raw).hexdigest(),ref['sha256'])
            self.assertEqual(struct.unpack('<9I',raw)[2],gtfs_epoch(date(2026,10,19),90000))
            walkref=out/m['walks']['url'].removeprefix('/data/')
            self.assertEqual(json.loads(walkref.read_text())[0]['seconds'],240)
            before=(out/'manifest.json').read_bytes();feed,w=self.fixture(root,broken=True)
            with self.assertRaises(ValueError):compile_feed(feed,w,out,date(2026,10,19))
            self.assertEqual((out/'manifest.json').read_bytes(),before)


class WalkGraphTests(unittest.TestCase):
    def test_network_paths_and_closed_passage(self):
        from build_walks import build
        graph={'version':'test-osm','attribution':['fixture'], 'nodes':['a','b','c','d'], 'stops':[dict(id=x,node=x,lat=59,lon=18,source='survey',verified=True) for x in ['a','c','d']], 'edges':[{'from':'a','to':'b','metres':400,'source':'osm/1'},{'from':'b','to':'c','metres':400,'source':'osm/2'},{'from':'c','to':'d','metres':10,'source':'osm/3','openingHours':'06:00-23:00'}]}
        data=build(graph,15)
        self.assertEqual(len(data['edges']),2)
        self.assertEqual(data['edges'][0]['seconds'],600)
        self.assertFalse(any(e['to']=='d' for e in data['edges']))
        self.assertEqual(build(graph,5)['edges'],[])
        graph['stops'][0]['verified']=False
        with self.assertRaises(ValueError):build(graph)


class BoardingTests(unittest.TestCase):
    def test_driver_coordination_is_distinct_from_phone_booking(self):
        from build_data import boarding_flags
        self.assertEqual(boarding_flags({'pickup_type':'3'},'pickup'),3)
        self.assertEqual(boarding_flags({'drop_off_type':'3'},'dropoff'),3)
        self.assertEqual(boarding_flags({'pickup_type':'2'},'pickup'),0)
        self.assertEqual(boarding_flags({'pickup_type':'1'},'pickup'),0)
        self.assertEqual(boarding_flags({'pickup_type':'3','pickup_booking_rule_id':'advance'},'pickup'),0)
        self.assertEqual(boarding_flags({'pickup_type':'0'},'pickup'),1)

if __name__=='__main__':unittest.main()
