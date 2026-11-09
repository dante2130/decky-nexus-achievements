import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source = readFileSync(new URL('../src/achievement-tracker.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('tracker.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'TrackerPanel');
const code = ts.transpileModule(node.getText(ast), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
function render(count = 5) {
  const output = {};
  const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
  vm.runInNewContext(code, { exports: output, React, translate: (_, text) => text, pluginLocales: { en: 'en-US' } });
  const item = { id: '1', name: '', description: '', secret: true, progress: null, unlocked: false };
  const tree = output.TrackerPanel({ locale: 'en', state: {
    options: { count, opacity: 50 }, running: { titleName: 'Game' }, achievements: [item,
      { ...item, id: '2', name: 'Zero', description: 'Work', progress: 0, secret: false },
      { ...item, id: '3', name: 'Completed', progress: 100, unlocked: true }],
  } });
  const nodes = [], texts = [];
  function walk(value) {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') { nodes.push(value); walk(value.props?.children); }
    else if (typeof value === 'string') texts.push(value);
  }
  walk(tree);
  return { nodes, texts };
}
test('tracker preserves unknown versus zero progress and masks secret details', () => {
  const { nodes, texts } = render();
  assert.equal(texts.includes('Game'), false);
  assert.ok(texts.includes('Secret achievement'));
  assert.ok(texts.includes('Progress unavailable'));
  assert.ok(texts.includes('0%'));
  assert.equal(texts.includes('Completed'), false);
  const bars = nodes.filter(node => node.props?.role === 'progressbar');
  assert.equal(bars.length, 1);
  assert.equal(bars[0].props['aria-valuenow'], 0);
  assert.equal(nodes[0].props.style.pointerEvents, 'none');
  assert.equal(nodes[0].props.style.background, 'rgb(14,20,27)');
  assert.equal(nodes[0].props.style.opacity, 0.5);
});
test('display count limits the overlay without exposing additional tracked items', () => {
  const { texts } = render(1);
  assert.ok(texts.includes('Secret achievement'));
  assert.equal(texts.includes('Zero'), false);
});
