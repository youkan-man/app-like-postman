import test from 'node:test';
import assert from 'node:assert/strict';
import {signatureHelp} from '../static/script-intelligence.mjs';

test('signature help works without Array.prototype.toReversed',()=>{
  const previous=Array.prototype.toReversed;
  try {delete Array.prototype.toReversed;assert.equal(signatureHelp('vars.set(').name,'vars.set');}
  finally {if(previous)Array.prototype.toReversed=previous;}
});
