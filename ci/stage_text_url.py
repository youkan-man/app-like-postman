"""Apply reviewed plaintext edits to pinned source in disposable verification VMs.

Every available result blob is checked against the locally tested version.
The generated source is published as evidence for exact-blob promotion; this
helper, its manifest and fragment are excluded from the application branch.
"""
from pathlib import Path
import hashlib
import json

root = Path.cwd().resolve()
manifest = json.loads((root / 'ci/text_url_edits.json').read_text())
# Keep the regexp source as literal UTF-8, without a second JSON escape layer.
for edit in manifest['static/core.mjs']['edits']:
    if edit['start'] == 213:
        edit['text'] = (root / 'ci/url_compile.fragment').read_text()

def blob(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()

prepared = {}
for name, record in manifest.items():
    path = (root / name).resolve()
    assert path.is_relative_to(root) and not (root / name).is_symlink(), name
    data = path.read_bytes()
    assert blob(data) == record['base_blob'], ('unexpected source', name, blob(data))
    lines = data.decode().splitlines(keepends=True)
    for edit in reversed(record.get('edits', [])):
        assert 0 <= edit['start'] <= edit['end'] <= len(lines), name
        lines[edit['start']:edit['end']] = [edit['text']]
    value = ''.join(lines)
    for before, after in record.get('replace', []):
        assert value.count(before) == 1, ('ambiguous replacement', name, before)
        value = value.replace(before, after)
    output = value.encode()
    if record.get('result_blob'):
        assert blob(output) == record['result_blob'], ('result differs from tested code', name, blob(output))
    prepared[name] = output
for name, data in prepared.items():
    (root / name).write_bytes(data)
files = sorted(set(manifest) | {'url_codec.py', 'static/collection-drag.mjs', 'static/collection-move.mjs',
    'static/url-menu.mjs', 'static/navigation-ui.css', 'tests/text-url.test.mjs', 'tests/collection-move.test.mjs',
    'tests/test_text_url.py', 'tests/ui_text_url_navigation.py'})
output = root / '.local_relay/output/promotion'
records = {}
for name in files:
    data = (root / name).read_bytes()
    target = output / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    records[name] = {'git_blob': blob(data), 'sha256': hashlib.sha256(data).hexdigest()}
(root / '.local_relay/output/promotion-manifest.json').write_text(json.dumps(records, indent=2))
print('PASS pinned inputs and locally tested result blobs; staged', len(files), 'files')
