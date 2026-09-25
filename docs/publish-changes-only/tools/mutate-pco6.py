#!/usr/bin/env python3
"""One browser mutation: exact-request review must receive keyboard focus, then restore and recheck."""
import json
from pathlib import Path
import runpy
import signal
import subprocess
import tempfile

h = runpy.run_path(str(Path(__file__).with_name('mutate-pco0.py')), run_name='pco_helpers')
root, sha, wait = h['ROOT'], h['sha'], h['wait_for_push']
signal.signal(signal.SIGTERM, h['interrupted'])
source = root / 'apps/web/src/app/products/[id]/edit/_studio/publication/PublishDialog.tsx'
report_file = root / 'docs/publish-changes-only/records/pco6-browser.json'
record = root / 'docs/publish-changes-only/records/pco6-focus-mutation.json'
backup = Path(tempfile.mkdtemp(prefix='pco6-focus-', dir='/private/tmp'))
original = source.read_bytes()
(backup / source.name).write_bytes(original)
assert sha((backup / source.name).read_bytes()) == sha(original)
anchor = 'selectionPreview.current?.focus({ preventScroll: true })'
assert original.decode().count(anchor) == 1
mutated = original.decode().replace(anchor, 'void selectionPreview.current // intentional focus omission').encode()
results = []
def run(label):
    print(json.dumps({'prediction': label, 'expected': 'focus assertion fails' if label == 'mutant' else 'browser checks pass'}), flush=True)
    with (backup / f'{label}.log').open('w') as log:
        command = subprocess.Popen(['node', 'docs/publish-changes-only/tools/pco6-browser.mjs'], cwd=root, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try: command.wait(timeout=180)
        finally: h['stop_child'](command)
    report = json.loads(report_file.read_text())
    results.append({'label': label, 'exitCode': command.returncode, 'report': report})
    return command.returncode, report

outcome, error = 'failed', None
try:
    code, report = run('control')
    assert code == 0 and report.get('ok') is True and not report['errors']
    wait()
    assert source.read_bytes() == original
    source.write_bytes(mutated)
    code, report = run('mutant')
    assert code == 1 and report.get('ok') is False and not report['errors'] and not report['blockedExternal']
    assert 'toBeFocused' in report.get('failure', '') and 'Selected publication request' in report['failure']
    assert source.read_bytes() == mutated
    outcome = 'passed'
except (Exception, KeyboardInterrupt) as cause:
    error = f'{type(cause).__name__}: {cause}'
finally:
    wait()
    current = source.read_bytes()
    if current not in (original, mutated):
        raise RuntimeError(f'Concurrent source edit: refusing restoration; backup {backup}')
    source.write_bytes(original)
    assert sha(source.read_bytes()) == sha(original)
    code, report = run('restored-control')
    if code or report.get('ok') is not True: outcome, error = 'failed', 'Restored browser control failed'
    wait()
    record.write_text(json.dumps({'outcome': outcome, 'error': error, 'sourceSha256': sha(original), 'restored': sha(source.read_bytes()) == sha(original), 'backup': str(backup), 'results': results}, indent=2)+'\n')
    print(json.dumps({'outcome': outcome, 'error': error, 'restored': sha(source.read_bytes()) == sha(original)}))
    if outcome != 'passed': raise SystemExit(1)
