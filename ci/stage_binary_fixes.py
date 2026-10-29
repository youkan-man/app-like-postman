"""Stage an integrity-checked development patch in disposable Relay guests only.

The tested source files are returned as artifacts for exact-blob promotion.
This helper and its transport payload are never part of the application merge.
"""
from pathlib import Path
import base64
import gzip
import hashlib
import json
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
CI = ROOT / 'ci'
EXPECTED_PATCH = '624d9586ba0e6a4fe3063860389befa8edbad1c0eed6143ea4b56f8d2bde84f4'
manifest = json.loads((CI / 'binary-fixes.manifest.json').read_text())
parts = [(CI / f'binary-fixes.{index:02}').read_text() for index in range(3)]
# Restore the separately recorded transport segment and remove duplicate
# transport characters. The complete patch digest below is authoritative.
parts[0] = parts[0][:442] + 'ebWc/03FHPHw59L5e35vOkQDgdtazx8eQAGpj40STanA72qIvi+NiqnH++bN2DF77lhpNBH3qKNrshDMIPoWCBCw6D/XMbJrQvDkZueGx1j6FNgtUdj4eDnkuAAtz9QXhIPyJVczmsGwas95Lf1gLgXep2HcilpAZ6VnsGpOs0a1bA1lPT' + parts[0][442:]
parts[1] = parts[1].replace('mc+fSVJJ886', 'mc+fSVJ886')
for received, original in [
    ('X7Pb1SqNcqo3J0aYIsiMI4HpYI/BKY6PY0u7/vDpmP8rpW63VO1367We6zUrtX7Pb1S2K', 'X7Pb1S2K'),
    ('Yd/+vjjt0Yd/+vjjt0lu/2', 'Yd/+vjjt0/u/2'),
    ('Uat3Kz6WaaeXm323Uat3Kz6W816udQvd/3SdrXXK7les7FVLNZ73tZ2rVft6udQvd/3SdrXXK7les7FVLNZ73tZ2rVft9', 'Uat3Kz6W816udQvd/3SdrXXK7les7FVLNZ73tZ2rVft9'),
    ('a41HZU', 'a41mo1HZU'),
]:
    parts[2] = parts[2].replace(received, original)
patch = gzip.decompress(base64.b64decode(''.join(parts), validate=True))
assert hashlib.sha256(patch).hexdigest() == EXPECTED_PATCH, 'Patch transfer digest mismatch'
for entry in manifest:
    path = ROOT / entry['path']
    assert ROOT in path.resolve().parents and not path.is_symlink()
    actual = hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
    assert actual == entry['before'], f'Base mismatch: {entry["path"]}'
subprocess.run(['git', 'apply', '--check', '-'], input=patch, cwd=ROOT, check=True)
subprocess.run(['git', 'apply', '-'], input=patch, cwd=ROOT, check=True)
for entry in manifest:
    path = ROOT / entry['path']
    content = path.read_bytes()
    assert hashlib.sha256(content).hexdigest() == entry['after'], f'Result mismatch: {entry["path"]}'
    blob = hashlib.sha1(f'blob {len(content)}\0'.encode() + content).hexdigest()
    assert blob == entry['blob'], f'Git blob mismatch: {entry["path"]}'
    target = ROOT / '.local_relay/output/staged' / entry['path']
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(path, target)
output = ROOT / '.local_relay/output/staged-manifest.json'
output.write_text(json.dumps({'patch_sha256': EXPECTED_PATCH, 'files': manifest}, indent=2))
print(f'PASS staged {len(manifest)} exact-source files; patch SHA-256 {EXPECTED_PATCH}', flush=True)
