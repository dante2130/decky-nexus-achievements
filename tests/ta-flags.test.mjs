import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const flags = JSON.parse(readFileSync(new URL('../src/ta_flags.json', import.meta.url), 'utf8'));
const code = ts.transpileModule(readFileSync(new URL('../src/ta-flags.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const output = {};
vm.runInNewContext(code, { exports: output, require: () => flags });
test('TA flag filters match known metadata and keep unknown rows out', () => {
  assert.equal(output.matchesTAFlag({ flags: ['missable', 'offline'] }, 'ta:missable'), true);
  assert.equal(output.matchesTAFlag({ flags: ['offline'] }, 'ta:missable'), false);
  assert.equal(output.matchesTAFlag(undefined, 'ta:missable'), false);
  assert.equal(output.matchesTAFlag({ flags: [] }, 'ta:missable'), false);
  assert.equal(output.matchesTAFlag(undefined, 'all'), true);
  assert.equal(output.matchesTAFlag(undefined, 'locked'), true);
});
test('all TA flag choices have unique identifiers and bit positions', () => {
  assert.equal(flags.length, 31);
  assert.equal(new Set(flags.map(flag => flag.id)).size, flags.length);
  assert.equal(new Set(flags.map(flag => flag.bit)).size, flags.length);
});

test('TA filter choices come from the full game and exclude unrelated metadata', () => {
  const available = output.flagsForGame([{ id: '1' }, { id: '2' }], {
    '1': { flags: ['missable', 'offline'] }, '2': { flags: ['offline'] }, 'removed': { flags: ['viral'] },
  });
  assert.deepEqual(Array.from(available, flag => flag.id).sort(), ['missable', 'offline']);
  assert.equal(output.flagsForGame([], {}).length, 0);
});
