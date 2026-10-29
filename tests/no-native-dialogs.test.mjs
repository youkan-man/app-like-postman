import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
test('application source never invokes browser alert, confirm or prompt',()=>{
  const root=fileURLToPath(new URL('../static/',import.meta.url));
  for(const name of fs.readdirSync(root).filter(name=>/\.(?:m?js|html)$/.test(name)))
    assert.doesNotMatch(fs.readFileSync(path.join(root,name),'utf8'),/\b(?:alert|confirm|prompt)\s*\(/,name);
});
