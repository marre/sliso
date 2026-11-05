import copy
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from reviewed_walks import refresh_reviewed_walks, PREFIX
from build_data import validate_walks


class ReviewedAccessTests(unittest.TestCase):
    def setUp(self):
        self.stops = [dict(id='a', name='Terminal', lat=59., lon=18.), dict(id='b', name='Station', lat=59.001, lon=18.)]
        self.link = dict(id='terminal-station', reviewedOn='2026-10-21', source='https://example.org/operator-map', via='Public terminal corridor', estimate='Includes entrance access', seconds=180, metres=150, bidirectional=True, **{'from':self.stops[0], 'to':self.stops[1]})
        self.document = dict(schema=1, links=[self.link])
        self.data = dict(version='native-v1', maxMinutes=30, speedKmh=4.8, stops=[self.stops[1]], edges=[], warnings=[])

    def test_reviewed_access_is_timed_estimated_bidirectional_and_idempotent(self):
        refresh_reviewed_walks(self.data, self.stops, self.document)
        self.assertEqual([(e['from'],e['to'],e['seconds']) for e in self.data['edges']], [('a','b',180),('b','a',180)])
        self.assertTrue(all(e['source'].startswith(PREFIX) for e in self.data['edges']))
        self.assertEqual(self.data['version'], 'native-v1') # Existing OSM contours remain reusable.
        self.assertEqual(next(s for s in self.data['stops'] if s['id']=='a')['binding'], 'assumed-reviewed-access')
        self.assertEqual(len(validate_walks(self.data, self.stops)[0]),2)
        before=copy.deepcopy(self.data)
        refresh_reviewed_walks(self.data, self.stops, self.document)
        self.assertEqual(self.data, before)
        refresh_reviewed_walks(self.data, self.stops, dict(schema=1, links=[]))
        self.assertEqual(self.data['edges'], [])
        self.assertEqual(self.data['stops'], [self.stops[1]])

    def test_moved_or_renamed_stops_require_review_but_retired_stops_stay_removed(self):
        for key, value in [('lat',59.0001), ('name','Other terminal')]:
            stops=copy.deepcopy(self.stops);stops[0][key]=value
            with self.assertRaisesRegex(ValueError,'Stale'):refresh_reviewed_walks(self.data, stops, self.document)
        refresh_reviewed_walks(self.data, self.stops[1:], self.document)
        self.assertEqual(self.data['edges'],[])
        self.assertEqual(self.data['reviewedAccess']['retired'],['terminal-station'])

    def test_unrealistic_costs_or_missing_provenance_fail_closed(self):
        for key, value in [('seconds',0),('seconds',30),('seconds',1801),('seconds',float('nan')),('metres',10),('source',''),('via',''),('bidirectional',None)]:
            doc=copy.deepcopy(self.document);doc['links'][0][key]=value
            with self.assertRaises(ValueError):refresh_reviewed_walks(copy.deepcopy(self.data), self.stops, doc)

    def test_physical_edges_survive_and_one_way_access_stays_one_way(self):
        original=dict(self.link, source='mapped', **{'from':'a','to':'b'});self.data['edges']=[original]
        self.link['bidirectional']=False
        refresh_reviewed_walks(self.data,self.stops,self.document)
        self.assertEqual(self.data['edges'][0],original)
        self.assertEqual(len(self.data['edges']),2)
        self.assertEqual(self.data['edges'][1]['from'],'a')

    def test_reviewed_sodermalm_connections_keep_costs_identity_and_staleness_guards(self):
        import json
        from reviewed_walks import FILE
        document=json.loads(FILE.read_text())
        links=[l for l in document['links'] if l['id'] in {'zinkensdamm-east-ringvagen','zinkensdamm-west-ringvagen','medborgarplatsen-b-bjorns-tradgard-b'}]
        self.assertEqual(len(links),3)
        stops=list({s['id']:s for l in links for s in (l['from'],l['to'])}.values())
        data=dict(version='fixture',maxMinutes=30,speedKmh=4.8,stops=[],edges=[])
        refresh_reviewed_walks(data,stops,dict(schema=1,links=links))
        self.assertEqual(len(validate_walks(data,stops)[0]),6)
        self.assertEqual(sorted(e['seconds'] for e in data['edges']),[30,30,165,165,210,210])
        self.assertTrue(all(e['source'].startswith(PREFIX) for e in data['edges']))
        moved=copy.deepcopy(stops);moved[0]['lat']+=.0001
        with self.assertRaisesRegex(ValueError,'Stale'):
            refresh_reviewed_walks(data,moved,dict(schema=1,links=links))
