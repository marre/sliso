"""Execute the workflow's real selection script against old and current caches."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

WORKFLOW=Path(__file__).resolve().parents[1]/'.github/workflows/data.yml'

class WalkingCacheSelectionTests(unittest.TestCase):
    def select(self, *, complete=True, cached_water=False, required_water=True,
               request_water=False, request_walking=False, event='schedule', weekday=4):
        text=WORKFLOW.read_text().split('      - name: Select weekly walking rebuild or recover a missing cache\n',1)[1]
        block=text.split('        run: |\n',1)[1].split('      - name:',1)[0]
        script='\n'.join(line[10:] for line in block.splitlines() if line.startswith('          '))
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);cache=root/'.data-build/prepared-walking';cache.mkdir(parents=True)
            if complete:(cache/'.complete').touch()
            if cached_water:
                (cache/'water-bitmap').mkdir();(cache/'water-bitmap/index.json').write_text('{}')
            (root/'data').mkdir();(root/'data/release.json').write_text(json.dumps({'features':{'waterMask':required_water}}))
            binary=root/'bin';binary.mkdir();date=binary/'date'
            date.write_text('#!/bin/sh\nprintf "%s\\n" '+str(weekday)+'\n');date.chmod(0o755)
            output=root/'outputs'
            env={**os.environ,'PATH':str(binary)+os.pathsep+os.environ['PATH'],
                 'EVENT':event,'REQUEST_WATER':str(request_water).lower(),
                 'REQUEST_WALKING':str(request_walking).lower(),'GITHUB_OUTPUT':str(output)}
            subprocess.run(['bash','-e','-c',script],cwd=root,env=env,check=True,capture_output=True,text=True)
            return dict(line.split('=',1) for line in output.read_text().splitlines())

    def test_complete_pre_water_cache_is_rebuilt_when_release_requires_water(self):
        self.assertEqual(self.select(),{'rebuild':'true','water':'true'})

    def test_complete_water_cache_is_reused_on_weekdays(self):
        self.assertEqual(self.select(cached_water=True),{'rebuild':'false','water':'true'})

    def test_old_release_without_water_can_reuse_its_complete_cache(self):
        self.assertEqual(self.select(required_water=False),{'rebuild':'false','water':'false'})

    def test_missing_cache_weekly_and_manual_rebuilds_are_preserved(self):
        for kwargs in ({'complete':False},{'weekday':7},{'request_walking':True,'event':'workflow_dispatch'}):
            with self.subTest(kwargs=kwargs):self.assertEqual(self.select(cached_water=True,**kwargs),{'rebuild':'true','water':'true'})

    def test_cached_water_is_preserved_even_with_an_older_release_pointer(self):
        self.assertEqual(self.select(cached_water=True,required_water=False),{'rebuild':'false','water':'true'})

    def test_explicit_water_request_rebuilds_an_incompatible_cache(self):
        self.assertEqual(self.select(required_water=False,request_water=True,request_walking=True,event='workflow_dispatch'),{'rebuild':'true','water':'true'})
