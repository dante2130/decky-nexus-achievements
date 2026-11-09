import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
let nextId = 0;
const React = { createElement(type, props) { return typeof type === 'function' ? type(props) : { type, props }; } };
const source = readFileSync(new URL('../src/achievement-icons.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
  jsx: ts.JsxEmit.React, jsxFactory: 'React.createElement', esModuleInterop: true } }).outputText;
const output = {};
vm.runInNewContext(compiled, { exports: output, React, require: name => name.endsWith('.svg?inline')
  ? readFileSync(new URL(`../src/${name.slice(0, -"?inline".length)}`, import.meta.url), 'utf8') : name === 'react' ? { useId: () => `:icon${++nextId}:` } : require(name) });

test('Rare and Mythic badges render native SVG without image loading', () => {
  for (const Icon of [output.RareIcon, output.MythicIcon]) {
    const node = Icon({ size: 20 });
    assert.equal(node.type, 'svg');
    const markup = node.props.dangerouslySetInnerHTML.__html;
    assert.match(markup, /<path/);
    assert.doesNotMatch(markup, /<img|data:image|src=/);
    assert.equal(node.props.width, 20); assert.equal(node.props.height, 20);
  }
});
test('multiple vector badges have isolated gradient IDs and valid references', () => {
  const markup = [output.RareIcon({}), output.RareIcon({}), output.MythicIcon({})].map(node => node.props.dangerouslySetInnerHTML.__html).join('');
  const ids = [...markup.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(output.RareIcon({}).props.viewBox, '0 0 576 512');
  assert.equal(output.MythicIcon({}).props.viewBox, '0 0 128 128');
  for (const match of markup.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids.includes(match[1]));
});
