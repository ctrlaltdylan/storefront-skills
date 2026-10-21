// Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'plugins', 'storefront-sec', 'skills', 'theme-escape-scan', 'scripts', 'escape-scan.mjs');

function scan(fixture) {
  const res = spawnSync(process.execPath, [script, join(here, 'fixtures', fixture), '--json'], { encoding: 'utf8' });
  return { code: res.status, ...JSON.parse(res.stdout) };
}

const has = (findings, rule, level, where) =>
  findings.some((f) => f.rule === rule && f.level === level && `${f.file}:${f.line}`.endsWith(where));

test('safe extension passes', () => {
  const r = scan('safe-extension');
  assert.equal(r.result, 'PASS', JSON.stringify(r.findings, null, 2));
  assert.equal(r.code, 0);
});

test('vulnerable extension fails with the expected findings', () => {
  const { code, result, findings } = scan('vulnerable-extension');
  assert.equal(result, 'FAIL');
  assert.equal(code, 1);

  // App data (metafields) and search terms cross a trust boundary: FAIL
  assert.ok(has(findings, 'UNESCAPED_OUTPUT', 'FAIL', 'upsell.liquid:8'), 'metafield in HTML');
  assert.ok(has(findings, 'UNESCAPED_OUTPUT', 'FAIL', 'upsell.liquid:9'), 'metafield in _html translation');
  assert.ok(has(findings, 'SCRIPT_NOT_JSON', 'FAIL', 'upsell.liquid:16'), 'metafield in <script>');
  assert.ok(has(findings, 'UNESCAPED_OUTPUT', 'FAIL', 'upsell.liquid:23'), 'search.terms');
  assert.ok(has(findings, 'DYNAMIC_CODE', 'FAIL', 'upsell.js:2'), 'new Function');

  // Settings only the theme editor can change: WARN
  assert.ok(has(findings, 'UNESCAPED_OUTPUT', 'WARN', 'upsell.liquid:4'), 'text setting in HTML');
  assert.ok(has(findings, 'UNESCAPED_OUTPUT', 'WARN', 'badge.liquid:1'), 'setting passed to a snippet');
  assert.ok(has(findings, 'STYLE_NOT_ESCAPED', 'WARN', 'upsell.liquid:20'), 'custom CSS');
  assert.ok(has(findings, 'SCRIPT_NOT_JSON', 'WARN', 'upsell.liquid:15'), 'setting in <script> string');

  for (const rule of [
    'PUBLIC_METAFIELD_NAMESPACE', 'UNQUOTED_ATTRIBUTE', 'URL_ATTRIBUTE', 'STRIP_HTML_NOT_ESCAPE',
    'EVENT_HANDLER_ATTRIBUTE', 'RAW_CODE_SETTING', 'ESCAPE_IN_SCRIPT', 'JSON_IN_QUOTES',
    'HTML_SINK', 'RUNTIME_SCRIPT', 'STRING_TIMER',
  ]) {
    assert.ok(findings.some((f) => f.rule === rule), `expected ${rule}`);
  }

  // Constrained settings and literal HTML aren't flagged
  assert.ok(!findings.some((f) => f.snippet.includes('block.settings.color')), 'color setting flagged');
  assert.ok(!findings.some((f) => f.snippet.includes("innerHTML = ''")), 'literal innerHTML flagged');
});
