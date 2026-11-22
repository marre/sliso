"""Exercise the nightly walking rebuild's real shell logic without downloading OSM."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

WORKFLOW=Path(__file__).resolve().parents[1]/'.github/workflows/data.yml'


class WalkingRebuildFallbackTests(unittest.TestCase):
    def script(self):
        workflow=WORKFLOW.read_text()
        text=workflow.split('      - name: Rebuild optional walking distances and network areas\n',1)[1]
        block=text.split('        run: |\n',1)[1].split('      - name:',1)[0]
        script='\n'.join(line[10:] for line in block.splitlines() if line.startswith('          '))
        for original in (
            'python -m venv /tmp/sliso-walking-venv || return 1',
            '/tmp/sliso-walking-venv/bin/pip install -r scripts/requirements-walking.txt || return 1',
            "sudo apt-get update || return 1",
            "sudo apt-get install -y osmium-tool gdal-bin || return 1",
            "/tmp/sliso-walking-venv/bin/pip install 'shapely>=2,<3' || return 1",
        ):
            self.assertIn(original,script)
            script=script.replace(original,'true')
        script,count=re.subn(
            r'/tmp/sliso-walking-venv/bin/python scripts/prepare_walking.py[^\n]*\|\| return 1',
            'fake_walking || return 1',script)
        self.assertEqual(count,1)
        return r'''
fake_walking() {
  if test "$WALK_SUCCESS" != true; then return 22; fi
  mkdir -p "$next"
  printf 'new walking data\n' > "$next/walks.json"
  if test "$WATER" = true; then
    mkdir -p "$next/water-bitmap"
    printf '{}\n' > "$next/water-bitmap/index.json"
  fi
}
''' + script

    def run_case(self, *, event='schedule', good_cache=True,
                 cached_water=True, water=True, build_success=False):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            cache=root/'.data-build/prepared-walking'
            cache.mkdir(parents=True)
            if good_cache:
                (cache/'.complete').touch()
                (cache/'walks.json').write_text('old walking data\n')
            if cached_water:
                (cache/'water-bitmap').mkdir()
                (cache/'water-bitmap/index.json').write_text('{}\n')
            output=root/'github-output'
            env={**os.environ,'EVENT':event,'WATER':str(water).lower(),
                 'WALK_SUCCESS':str(build_success).lower(),
                 'GITHUB_OUTPUT':str(output)}
            result=subprocess.run(['bash','-e','-o','pipefail','-c',self.script()],
                                  cwd=root,env=env,capture_output=True,text=True)
            marker=output.read_text() if output.exists() else ''
            data=(cache/'walks.json').read_text() if (cache/'walks.json').exists() else None
            return result,marker,data,(cache/'.complete').exists(),(root/'.data-build/prepared-walking-next').exists()

    def test_sunday_download_failure_reuses_verified_cache(self):
        result,marker,data,complete,next_exists=self.run_case()
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('::warning::Weekly OSM rebuild failed',result.stdout)
        self.assertEqual(marker,'updated=false\n')
        self.assertEqual(data,'old walking data\n')
        self.assertTrue(complete)
        self.assertFalse(next_exists)

    def test_completed_sunday_rebuild_replaces_cache(self):
        result,marker,data,complete,next_exists=self.run_case(build_success=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(marker,'updated=true\n')
        self.assertEqual(data,'new walking data\n')
        self.assertTrue(complete)
        self.assertFalse(next_exists)

    def test_manual_rebuild_failure_does_not_silently_succeed(self):
        result,_,data,complete,_=self.run_case(event='workflow_dispatch')
        self.assertNotEqual(result.returncode,0)
        self.assertIn('::error::Walking rebuild failed',result.stdout)
        self.assertEqual(data,'old walking data\n')
        self.assertTrue(complete)

    def test_missing_or_incompatible_cache_cannot_fall_back(self):
        for config in ({'good_cache':False},{'cached_water':False}):
            with self.subTest(config=config):
                result,_,_,_,_=self.run_case(**config)
                self.assertNotEqual(result.returncode,0)
                self.assertIn('::error::Walking rebuild failed',result.stdout)

    def test_fallback_does_not_save_new_cache_or_provenance(self):
        workflow=WORKFLOW.read_text()
        for name in ('Cache completed walking inputs for nightly reuse',
                     'Save OSM source provenance'):
            step=workflow.split('      - name: '+name+'\n',1)[1].split('\n',2)
            self.assertEqual(step[0].strip(),"if: steps.walking-build.outputs.updated == 'true'")
