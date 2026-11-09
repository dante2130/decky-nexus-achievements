import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

test('the production bundle embeds SVG documents rather than asset-loader modules', () => {
  const code = readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8');
  const source = ts.createSourceFile('index.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const artwork = new Map();
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ['rareSvg', 'mythicSvg'].includes(node.name.text)) {
      assert.ok(ts.isStringLiteral(node.initializer));
      artwork.set(node.name.text, node.initializer.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(artwork.size, 2);
  for (const [name, markup] of artwork) {
    assert.match(markup.trimStart(), /^<svg\s/, name);
    assert.match(markup, /<path\s/, name);
    assert.doesNotMatch(markup, /export default|127\.0\.0\.1|plugins\/Nexus Achievements\/assets/, name);
  }
});
