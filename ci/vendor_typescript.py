"""Rebuild the offline JavaScript language service; application startup needs no npm.

The upstream archive is pinned and verified before extraction. The compiler is
minified without bundling or changing its behavior, then exported as an ES module.
Run --check to verify committed artifacts without network access or build tools.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / 'static'
VERSION = '5.9.3'
ESBUILD = '0.25.12'
URL = f'https://registry.npmjs.org/typescript/-/typescript-{VERSION}.tgz'
INTEGRITY = 'sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw=='
MANIFEST = STATIC / 'vendor-typescript-manifest.json'
LIBRARIES = ['lib.es2023.d.ts', 'lib.webworker.d.ts', 'lib.webworker.iterable.d.ts', 'lib.webworker.asynciterable.d.ts']


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, value):
    pending = path.with_name(path.name + '.pending')
    pending.write_text(value, encoding='utf-8')
    pending.replace(path)


def check():
    manifest = json.loads(MANIFEST.read_text())
    assert manifest['version'] == VERSION and manifest['source_integrity'] == INTEGRITY
    for name, expected in manifest['files'].items():
        assert digest(STATIC / name) == expected, f'Vendored file differs: {name}'
    print(f'Verified TypeScript {VERSION}: {len(manifest["files"])} offline artifacts')


def build():
    archive = urllib.request.urlopen(URL, timeout=60).read()
    actual = 'sha512-' + base64.b64encode(hashlib.sha512(archive).digest()).decode()
    if actual != INTEGRITY:
        raise ValueError('TypeScript package integrity mismatch')
    with tempfile.TemporaryDirectory(prefix='minipost-typescript-') as folder:
        temporary = Path(folder)
        with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as package:
            def source(name):
                return package.extractfile('package/' + name).read().decode('utf-8')

            entry = temporary / 'compiler.mjs'
            entry.write_text(source('lib/typescript.js') + '\nexport default ts;\n')
            output = temporary / 'vendor-typescript.mjs'
            subprocess.run([
                'npm', 'exec', '--yes', '--package=esbuild@' + ESBUILD, '--', 'esbuild', str(entry),
                '--minify', '--format=esm', '--target=es2020', '--legal-comments=inline',
                '--log-level=error', '--outfile=' + str(output),
            ], check=True)
            write(STATIC / 'vendor-typescript.mjs', output.read_text())
            libraries = {}

            def include(name):
                if name in libraries:
                    return
                text = source('lib/' + name)
                libraries[name] = text
                for reference in re.findall(r'<reference lib="([^"]+)"', text):
                    include('lib.' + reference + '.d.ts')

            for name in LIBRARIES:
                include(name)
            write(STATIC / 'vendor-typescript-libs.mjs',
                  '// TypeScript standard libraries, Apache-2.0. See vendor-typescript.LICENSE.txt.\nexport default ' +
                  json.dumps(dict(sorted(libraries.items())), ensure_ascii=False, separators=(',', ':')) + ';\n')
            # Keep upstream notice text with repository-standard line endings.
            for target, origin in [('vendor-typescript.LICENSE.txt', 'LICENSE.txt'),
                                   ('vendor-typescript.NOTICE.txt', 'ThirdPartyNoticeText.txt')]:
                notice = '\n'.join(line.rstrip() for line in source(origin).splitlines()).rstrip() + '\n'
                write(STATIC / target, notice)
    names = ['vendor-typescript.mjs', 'vendor-typescript-libs.mjs', 'vendor-typescript.LICENSE.txt', 'vendor-typescript.NOTICE.txt']
    write(MANIFEST, json.dumps({
        'package': 'typescript', 'version': VERSION, 'source_url': URL, 'source_integrity': INTEGRITY,
        'minifier': 'esbuild@' + ESBUILD, 'library_roots': LIBRARIES,
        'files': {name: digest(STATIC / name) for name in names},
    }, indent=2) + '\n')
    check()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Check committed hashes without fetching or building')
    options = parser.parse_args()
    check() if options.check else build()
