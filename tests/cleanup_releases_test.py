import base64
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import cleanup_releases as cleanup

NOW = datetime(2026, 11, 10, tzinfo=timezone.utc)


def release(number, days=20, **changes):
    value = dict(id=number, tag_name=f'data-sl-{number:020x}', draft=False,
                 prerelease=False, published_at=(NOW - timedelta(days=days)).isoformat(),
                 body='', assets=[dict(name='sliso-data.zip', state='uploaded', size=10)])
    value.update(changes)
    return value


def descriptor(number):
    version = f'sl-{number:020x}'
    return dict(schema=1, version=version,
                url=f'https://github.com/marre/sliso/releases/download/data-{version}/sliso-data.zip')


class CleanupTests(unittest.TestCase):
    def test_age_boundary_and_latest_three_during_outage(self):
        releases = [release(1, 14), release(2, 20), release(3, 21), release(4, 22)]
        self.assertEqual([r['id'] for r in cleanup.candidates(releases[::-1], set(), NOW)], [4])
        recent = [release(5, 1), release(6, 2), release(7, 3)]
        self.assertEqual([r['id'] for r in cleanup.candidates(recent + releases, set(), NOW)], [2, 3, 4])

    def test_protected_marker_and_unmanaged_releases(self):
        releases = [release(i, i) for i in range(1, 4)] + [
            release(4), release(5, body='Rollback [keep-data]'),
            release(6, draft=True), release(7, prerelease=True),
            release(8, tag_name='v1.0.0'), release(9, assets=[]), release(10)]
        selected = cleanup.candidates(releases, {release(4)['tag_name']}, NOW)
        self.assertEqual([r['id'] for r in selected], [10])

    def test_pagination(self):
        with patch.object(cleanup, 'api', side_effect=[list(range(100)), [100]]) as api:
            self.assertEqual(cleanup.pages('releases'), list(range(101)))
            self.assertEqual(api.call_args.args[0], 'releases?per_page=100&page=2')

    def run_cleanup(self, apply=False, broken=False, missing=False):
        branches = [dict(name='main', commit=dict(sha='a')), dict(name='feature', commit=dict(sha='b')),
                    dict(name='data-state', commit=dict(sha='c'))]
        releases = [release(i, i) for i in range(1, 4)] + [release(i, 30) for i in range(4, 8)]
        if missing:
            releases = [r for r in releases if r['id'] != 5]

        def api(endpoint, method='GET', missing_ok=False):
            if method == 'DELETE':
                return None
            if endpoint.endswith('ref=c'):
                if broken:
                    raise RuntimeError('API unavailable')
                return None
            value = descriptor(1 if endpoint.endswith('ref=a') else 5)
            return dict(content=base64.b64encode(json.dumps(value).encode()).decode())

        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'previous.json'
            p.write_text(json.dumps(descriptor(4)))
            with patch.object(cleanup, 'pages', side_effect=[branches, releases]), \
                    patch.object(cleanup, 'api', side_effect=api) as calls:
                if broken or missing:
                    with self.assertRaises((RuntimeError, ValueError)):
                        cleanup.cleanup('marre/sliso', [p], apply)
                else:
                    cleanup.cleanup('marre/sliso', [p], apply)
                return [c.args[0] for c in calls.call_args_list if c.kwargs.get('method') == 'DELETE']

    def test_branch_and_previous_protection_and_apply(self):
        self.assertEqual(self.run_cleanup(apply=True),
                         ['repos/marre/sliso/releases/6', 'repos/marre/sliso/releases/7'])

    def test_dry_run_never_deletes(self):
        self.assertEqual(self.run_cleanup(), [])

    def test_fail_closed_before_deletion(self):
        self.assertEqual(self.run_cleanup(apply=True, broken=True), [])
        self.assertEqual(self.run_cleanup(apply=True, missing=True), [])

    def test_descriptor_rejects_wrong_repository(self):
        with self.assertRaises(ValueError):
            cleanup.descriptor_tag(descriptor(1), 'someone/else')

    def test_workflow_cleanup_follows_pointer_push(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/data.yml').read_text()
        save = workflow.index('cp data/release.json .data-build/previous-release.json')
        push = workflow.index('git push origin HEAD:main', save)
        prune = workflow.index('python scripts/cleanup_releases.py', push)
        self.assertLess(save, push)
        self.assertLess(push, prune)
        self.assertIn('--protect-descriptor .data-build/previous-release.json --apply', workflow)


if __name__ == '__main__':
    unittest.main()
