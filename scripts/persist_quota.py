"""Commit quota reservations before network access, independent of Actions cache."""
import subprocess
import sys
from pathlib import Path


def persist(ledger):
    root = Path(ledger).resolve().parent
    def git(*args):
        return subprocess.run(['git', '-C', str(root), *args], check=True, capture_output=True)
    git('add', 'quota.json')
    if git('diff', '--cached', '--numstat').stdout:
        git('commit', '-m', 'Persist Trafiklab download reservation [skip ci]')
    git('push', 'origin', 'HEAD:refs/heads/data-state')


if __name__ == '__main__':
    persist(sys.argv[1])
