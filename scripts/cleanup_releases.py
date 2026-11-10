"""Prune old data archives after publication; default to a read-only dry run."""
import argparse
import base64
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import subprocess

TAG = re.compile(r'data-sl-[0-9a-f]{20}')


def api(endpoint, method='GET', missing_ok=False):
    result = subprocess.run(['gh', 'api', '--method', method, endpoint],
                            capture_output=True, text=True)
    if result.returncode:
        if missing_ok and '(HTTP 404)' in result.stderr:
            return None
        raise RuntimeError(f'GitHub API failed for {endpoint}: {result.stderr}')
    return json.loads(result.stdout) if result.stdout.strip() else None


def pages(endpoint):
    result = []
    page = 1
    while True:
        batch = api(f'{endpoint}?per_page=100&page={page}')
        result.extend(batch)
        if len(batch) < 100:
            return result
        page += 1


def descriptor_tag(descriptor, repository):
    tag = 'data-' + descriptor['version']
    if (not TAG.fullmatch(tag) or descriptor.get('schema') != 1
            or descriptor['url'] != f'https://github.com/{repository}/releases/download/{tag}/sliso-data.zip'):
        raise ValueError('Invalid protected release descriptor; refusing cleanup')
    return tag


def candidates(releases, protected, now):
    managed = [r for r in releases if TAG.fullmatch(r['tag_name'])
               and not r['draft'] and not r['prerelease']
               and any(a['name'] == 'sliso-data.zip' and a['state'] == 'uploaded'
                       for a in r['assets'])]
    # Parse all dates before deleting anything, and sort by publication, not tag/commit date.
    dated = sorted([(datetime.fromisoformat(r['published_at'].replace('Z', '+00:00')), r)
                    for r in managed], key=lambda item: item[0], reverse=True)
    keep = protected | {r['tag_name'] for _, r in dated[:3]}
    return [r for published, r in dated
            if published < now - timedelta(days=14) and r['tag_name'] not in keep
            and '[keep-data]' not in (r.get('body') or '')]


def cleanup(repository, descriptors, apply=False):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ValueError('Invalid repository')
    prefix = f'repos/{repository}'
    protected = {descriptor_tag(json.loads(Path(p).read_text()), repository) for p in descriptors}
    # Protect all branch tips (including open work), not only the runner's checkout.
    # A branch without this file is normal (e.g. data-state); all other errors abort.
    for branch in pages(f'{prefix}/branches'):
        descriptor = api(f"{prefix}/contents/data/release.json?ref={branch['commit']['sha']}",
                         missing_ok=True)
        if descriptor is not None:
            protected.add(descriptor_tag(json.loads(base64.b64decode(descriptor['content'])), repository))
        elif branch['name'] == 'main':
            raise ValueError('Main release descriptor missing; refusing cleanup')
    releases = pages(f'{prefix}/releases')
    published = {r['tag_name'] for r in releases if not r['draft'] and not r['prerelease']}
    if not protected <= published:
        raise ValueError('Protected release missing; refusing cleanup')
    selected = candidates(releases, protected, datetime.now(timezone.utc))
    total = sum(a['size'] for r in selected for a in r['assets'])
    print(f'{len(selected)} old data releases eligible ({total} bytes); apply={apply}', flush=True)
    for release in selected:
        print(f"{'Deleting' if apply else 'Would delete'} {release['tag_name']}", flush=True)
        if apply:
            # Keep Git tags: deleting an archive must not remove source history references.
            api(f"{prefix}/releases/{release['id']}", method='DELETE')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--protect-descriptor', action='append', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    cleanup(args.repository, args.protect_descriptor, args.apply)
