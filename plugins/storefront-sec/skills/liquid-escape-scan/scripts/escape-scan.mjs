#!/usr/bin/env node
// Scans a Shopify theme or theme app extension for output that isn't escaped
// for where it lands: HTML text and attributes need `escape`, <script> needs
// `json`, and <style> needs `replace: '</', '<\/'`. Also flags JavaScript that
// runs code from strings (eval, new Function) or writes HTML from data.
//
// Usage:
//   node escape-scan.mjs <path> [<path>...] [--json] [--all-js]
//
// <path> can be a theme folder, an app folder (it finds extensions/*), one
// extension, or single files. No dependencies; needs Node.js 18 or newer.
//
// Suppress a finding you've reviewed with a comment containing
// `escape-scan-ignore` on the same line or the line above it.
//
// Exit codes: 0 = nothing found, 1 = at least one FAIL, 2 = warnings only,
// 4 = usage error.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, basename, dirname, extname, sep } from 'node:path';

// ---------------------------------------------------------------------------
// Args

const argv = process.argv.slice(2);
const opts = { json: false, allJs: false, paths: [] };
for (const a of argv) {
  if (a === '--json') opts.json = true;
  else if (a === '--all-js') opts.allJs = true;
  else if (a === '-h' || a === '--help') opts.help = true;
  else opts.paths.push(a);
}
if (opts.help || !opts.paths.length) {
  console.log('Usage: node escape-scan.mjs <theme-or-extension-path> [...] [--json] [--all-js]');
  process.exit(opts.help ? 0 : 4);
}

// ---------------------------------------------------------------------------
// What counts as risky data, and what makes it safe

// Filters that make a value safe to print in HTML. `json` is also the only
// filter that's safe inside <script>.
const HTML_SAFE_FILTERS = new Set([
  'escape', 'escape_once', 'json', 'url_encode', 'url_escape', 'url_param_escape',
  'handle', 'handleize', 'metafield_tag',
  'money', 'money_with_currency', 'money_without_currency', 'money_without_trailing_zeros',
  'plus', 'minus', 'times', 'divided_by', 'modulo', 'round', 'ceil', 'floor', 'abs',
  'at_least', 'at_most', 'size',
  'image_url', 'img_url', 'image_tag', 'asset_url', 'asset_img_url', 'file_url', 'file_img_url',
  'shopify_asset_url', 'global_asset_url', 'date', 'weight_with_unit',
  // Shopify escapes translations and their interpolated values, unless the
  // key ends in _html (handled in evalExpr).
  't', 'translate',
]);

// Setting types whose values are constrained or are objects, so printing
// them can't inject markup. richtext and inline_richtext are sanitized by
// Shopify and meant to be printed as HTML.
const SAFE_SETTING_TYPES = new Set([
  'checkbox', 'number', 'range', 'color', 'color_background', 'select', 'radio',
  'font_picker', 'image_picker', 'collection', 'collection_list', 'product', 'product_list',
  'blog', 'page', 'link_list', 'video', 'metaobject', 'metaobject_list', 'color_scheme',
  'color_scheme_group', 'text_alignment', 'header', 'paragraph', 'richtext', 'inline_richtext',
]);
// Setting types that hold markup or Liquid on purpose.
const RAW_CODE_SETTING_TYPES = new Set(['html', 'liquid']);
// Safe to print inside <style> without the `</` replace.
const CSS_SAFE_SETTING_TYPES = new Set([
  'color', 'color_background', 'number', 'range', 'checkbox', 'select', 'radio', 'font_picker',
]);

// Shopper-controlled values that themes commonly print. Shopify's own Dawn
// theme prints the "soft" ones raw, so they're warnings, not failures.
const SHOPPER_INPUT = [/^search\.terms\b/, /^predictive_search\.terms\b/];
const SHOPPER_INPUT_SOFT = [/^cart\.note\b/, /^cart\.attributes\b/, /\.properties\b/, /^form\.(?!errors\b)/];

// ---------------------------------------------------------------------------
// File discovery

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.shopify']);

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = [];
for (const p of opts.paths) {
  const abs = resolve(p);
  if (!existsSync(abs)) {
    console.error(`Not found: ${p}`);
    process.exit(4);
  }
  if (statSync(abs).isDirectory()) walk(abs, files);
  else files.push(abs);
}
const liquidFiles = [...new Set(files.filter((f) => f.endsWith('.liquid')))];
const jsFiles = [...new Set(files.filter((f) => f.endsWith('.js') && (opts.allJs || isAssetFile(f))))];
const baseDir = opts.paths.length === 1 && statSync(resolve(opts.paths[0])).isDirectory()
  ? resolve(opts.paths[0])
  : process.cwd();

function isAssetFile(f) {
  return f.split(sep).includes('assets');
}

// A theme app extension has a shopify.extension.toml with type = "theme".
const extensionRootCache = new Map();
function themeExtensionRoot(file) {
  let dir = dirname(file);
  while (dir !== dirname(dir)) {
    if (extensionRootCache.has(dir)) return extensionRootCache.get(dir);
    const toml = join(dir, 'shopify.extension.toml');
    if (existsSync(toml)) {
      const isTheme = /^\s*type\s*=\s*["']theme["']/m.test(readFileSync(toml, 'utf8'));
      extensionRootCache.set(dir, isTheme ? dir : null);
      return isTheme ? dir : null;
    }
    dir = dirname(dir);
  }
  return null;
}

// The folder that holds snippets/ for a file (theme root or extension root).
function codeRoot(file) {
  const parts = file.split(sep);
  for (const folder of ['blocks', 'sections', 'snippets', 'layout', 'templates']) {
    const i = parts.lastIndexOf(folder);
    if (i > 0) return parts.slice(0, i).join(sep);
  }
  return dirname(file);
}

// ---------------------------------------------------------------------------
// Findings

const findings = [];
const RULES = {
  UNESCAPED_OUTPUT: { level: 'FAIL', fix: 'Add `| escape` (or `| json` if it feeds JavaScript).' },
  SCRIPT_NOT_JSON: { level: 'FAIL', fix: 'Inside <script>, use `{{ value | json }}` with no quotes around it. `escape` doesn\'t stop JavaScript injection.' },
  STYLE_NOT_ESCAPED: { level: 'FAIL', fix: "Inside <style>, use `| replace: '</', '<\\/'` so the value can't close the tag, and reject HTML tags when the CSS is saved." },
  JSON_IN_QUOTES: { level: 'WARN', fix: '`json` adds its own quotes. Remove the quotes around `{{ value | json }}`.' },
  ESCAPE_IN_SCRIPT: { level: 'WARN', fix: 'Use `| json` without quotes instead of `| escape` inside quotes. It\'s safer and keeps the value intact.' },
  UNQUOTED_ATTRIBUTE: { level: 'WARN', fix: 'Put the attribute value in double quotes. `escape` can\'t stop a space from starting a new attribute.' },
  URL_ATTRIBUTE: { level: 'WARN', fix: 'A URL from settings can be `javascript:`. Check it starts with `https://` or `/` before rendering, on the server or with a Liquid condition.' },
  EVENT_HANDLER_ATTRIBUTE: { level: 'WARN', fix: 'Don\'t print settings into `on*` attributes. Pass them with `| json` in a <script> or a data attribute instead.' },
  STRIP_HTML_NOT_ESCAPE: { level: 'WARN', fix: '`strip_html` removes tags but not quotes or entities. Use `| escape` too.' },
  RAW_CODE_SETTING: { level: 'WARN', fix: 'This setting holds HTML or Liquid on purpose. Anyone who can edit it controls this page. Remove it if you can, or limit who can edit it.' },
  PUBLIC_METAFIELD_NAMESPACE: { level: 'WARN', fix: "Read settings from your app-owned namespace, `metafields['$app:your_namespace']`, so other apps and staff can't change them." },
  DYNAMIC_CODE: { level: 'FAIL', fix: "Don't run strings as code. Ship the logic in your bundled JavaScript and read settings as data." },
  STRING_TIMER: { level: 'WARN', fix: 'Pass a function to setTimeout/setInterval, not a string.' },
  HTML_SINK: { level: 'WARN', fix: 'Use textContent, or build elements with createElement. If the HTML has to come from data, sanitize it first.' },
  RUNTIME_SCRIPT: { level: 'WARN', fix: 'Make sure the script URL is fixed and points to a domain you control, and never set its text from data.' },
};

function lineCol(text, index) {
  let line = 1, last = -1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) { line++; last = i; }
  return { line, col: index - last };
}

function ignored(lines, line) {
  return [lines[line - 1], lines[line - 2]].some((l) => l && l.includes('escape-scan-ignore'));
}

// Settings and soft shopper input can only hurt you if someone who can already
// edit the theme abuses them, so those are warnings. App data (metafields in a
// theme app extension) and search terms cross a trust boundary: failures.
function levelFor(rule, kind) {
  if (RULES[rule].level !== 'FAIL') return RULES[rule].level;
  return ['setting', 'shopper-soft', 'metafield'].includes(kind) ? 'WARN' : 'FAIL';
}

function report(file, text, index, rule, snippet, detail, kind) {
  const { line, col } = lineCol(text, index);
  const lines = text.split('\n');
  if (ignored(lines, line)) return;
  const key = `${file}:${line}:${col}:${rule}`;
  if (findings.some((f) => f.key === key)) return;
  findings.push({
    key, file: relative(baseDir, file) || basename(file), line, col, rule,
    level: levelFor(rule, kind), source: kind, snippet: snippet.trim().slice(0, 160), detail, fix: RULES[rule].fix,
  });
}

// ---------------------------------------------------------------------------
// Liquid helpers

// Replace comments and raw blocks with spaces so offsets and lines still match.
function blank(s) {
  return s.replace(/[^\n]/g, ' ');
}
function stripLiquidComments(src) {
  return src
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, blank)
    .replace(/\{%-?\s*raw\s*-?%\}[\s\S]*?\{%-?\s*endraw\s*-?%\}/g, blank)
    .replace(/\{%-?\s*#[\s\S]*?-?%\}/g, (m) => (m.includes('escape-scan-ignore') ? m : blank(m)))
    .replace(/<!--[\s\S]*?-->/g, (m) => (m.includes('escape-scan-ignore') ? m : blank(m)));
}

// Setting id -> type from {% schema %}, split by how Liquid reads them. In a
// blocks/ file the top-level settings are block.settings; in a section they're
// section.settings and the nested blocks' settings are block.settings.
function schemaSettings(src, file) {
  const section = new Map();
  const block = new Map();
  const m = src.match(/\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/);
  if (!m) return { section, block };
  try {
    const schema = JSON.parse(m[1]);
    const add = (map, settings) => (settings || []).forEach((s) => s.id && addSetting(map, s.id, s.type));
    const isBlockFile = file.split(sep).includes('blocks');
    add(isBlockFile ? block : section, schema.settings);
    (schema.blocks || []).forEach((b) => add(block, b.settings));
  } catch { /* invalid JSON: treat every setting as text */ }
  return { section, block };
}

// Every setting id in a theme or extension, for snippets, which have no schema.
const rootSettingsCache = new Map();
function rootSettings(root) {
  if (rootSettingsCache.has(root)) return rootSettingsCache.get(root);
  const all = { section: new Map(), block: new Map() };
  for (const f of liquidFiles) {
    if (codeRoot(f) !== root) continue;
    const { section, block } = schemaSettings(readFileSync(f, 'utf8'), f);
    for (const [id, type] of section) addSetting(all.section, id, type);
    for (const [id, type] of block) addSetting(all.block, id, type);
  }
  rootSettingsCache.set(root, all);
  return all;
}
function addSetting(map, id, type) {
  // If two blocks reuse an id with different types, assume the riskier one.
  const prev = map.get(id);
  if (!prev || (SAFE_SETTING_TYPES.has(prev) && !SAFE_SETTING_TYPES.has(type))) map.set(id, type);
}
const themeSettingsCache = new Map();
function themeSettings(root) {
  if (themeSettingsCache.has(root)) return themeSettingsCache.get(root);
  const map = new Map();
  const p = join(root, 'config', 'settings_schema.json');
  if (existsSync(p)) {
    try {
      for (const group of JSON.parse(readFileSync(p, 'utf8'))) {
        (group.settings || []).forEach((s) => s.id && addSetting(map, s.id, s.type));
      }
    } catch { /* ignore */ }
  }
  themeSettingsCache.set(root, map);
  return map;
}

// Split on a separator outside quotes and brackets.
function splitTop(s, sepChar) {
  const parts = [];
  let depth = 0, quote = null, cur = '';
  for (const ch of s) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '[' || ch === '(') depth++;
    if (ch === ']' || ch === ')') depth--;
    if (ch === sepChar && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

// Variable references in an expression (skips string literals).
function refsIn(expr) {
  const noStrings = expr.replace(/"[^"]*"|'[^']*'/g, (m) => (/\$app:|app--/.test(m) ? m : '""'));
  return noStrings.match(/[A-Za-z_][\w-]*(?:\s*(?:\.[\w-]+|\[[^\]]*\]))*/g) || [];
}

// ---------------------------------------------------------------------------
// Taint analysis for one Liquid file

const LITERALS = new Set(['true', 'false', 'nil', 'null', 'empty', 'blank', 'and', 'or', 'contains', 'in', 'with', 'as', 'for']);

function makeScope(file, src, seeds) {
  const isExtension = !!themeExtensionRoot(file);
  return {
    file,
    isExtension,
    settings: schemaSettings(src, file),
    rootSettings: rootSettings(codeRoot(file)),
    themeSettings: themeSettings(codeRoot(file)),
    tainted: new Map(seeds || []), // local var -> reason
    rawCode: new Set(),            // local vars holding html/liquid settings
  };
}

// Returns { tainted, reason, settingType } for one variable reference.
function refTaint(ref, scope) {
  const path = ref.replace(/\s+/g, '');
  const head = path.split(/[.[]/)[0];
  if (LITERALS.has(head) || /^\d/.test(head)) return { tainted: false };

  const settingMatch = path.match(/^(block|section)\.settings\.([\w-]+)/) || path.match(/^settings\.([\w-]+)/);
  if (settingMatch) {
    const id = settingMatch[2] || settingMatch[1];
    const type = head === 'settings'
      ? scope.themeSettings.get(id)
      : scope.settings[head].get(id) ?? scope.rootSettings[head].get(id);
    const rest = path.slice(settingMatch[0].length);
    if (type && SAFE_SETTING_TYPES.has(type)) return { tainted: false, settingType: type };
    if (rest && type && !['text', 'textarea', 'url', 'html', 'liquid'].includes(type)) return { tainted: false, settingType: type };
    return { tainted: true, kind: 'setting', reason: `setting \`${id}\`${type ? ` (${type})` : ''}`, settingType: type || 'text' };
  }
  if (/(^|\.)metafields\b/.test(path) || /^metaobject\b|\.metaobjects\b/.test(path)) {
    return { tainted: true, kind: scope.isExtension ? 'app-data' : 'metafield', reason: 'metafield or metaobject value' };
  }
  if (SHOPPER_INPUT.some((re) => re.test(path))) return { tainted: true, kind: 'shopper', reason: 'shopper input' };
  if (SHOPPER_INPUT_SOFT.some((re) => re.test(path))) return { tainted: true, kind: 'shopper-soft', reason: 'shopper input' };
  if (scope.tainted.has(head)) {
    const t = scope.tainted.get(head);
    return { tainted: true, kind: t.kind, reason: t.reason, settingType: scope.rawCode.has(head) ? 'html' : undefined };
  }
  return { tainted: false };
}

// Evaluates an output expression: is the final value risky, and which filters ran?
function evalExpr(expr, scope) {
  const [base, ...filters] = splitTop(expr, '|');
  let state = { tainted: false };
  for (const ref of refsIn(base)) {
    const t = refTaint(ref, scope);
    if (t.tainted) { state = t; break; }
    if (t.settingType && !state.settingType) state.settingType = t.settingType;
  }
  const names = [];
  for (const f of filters) {
    const [name, args = ''] = f.split(/:(.*)/s).map((x) => x.trim());
    names.push(name);
    if ((name === 't' || name === 'translate') && /_html['"]\s*$/.test(base.trim())) {
      const t = refsIn(args).map((ref) => refTaint(ref, scope)).find((x) => x.tainted);
      if (t) { state = { ...t, reason: `${t.reason} in an _html translation, which isn't escaped` }; continue; }
    }
    if (HTML_SAFE_FILTERS.has(name)) {
      state = { ...state, tainted: false, sanitizedBy: name };
      continue;
    }
    if (name === 'replace' && /^['"]<\/['"]/.test(args)) {
      state = { ...state, cssSafe: true };
      continue;
    }
    for (const ref of refsIn(args)) {
      const t = refTaint(ref, scope);
      if (t.tainted) { state = { ...t, sanitizedBy: undefined }; break; }
    }
  }
  return { ...state, filters: names };
}

// Handles assign / for / echo / render inside {% %} and {% liquid %}.
function handleTag(body, scope, ctx) {
  const statements = /^liquid\b/.test(body) ? body.replace(/^liquid\b/, '').split('\n') : [body];
  for (let stmt of statements) {
    stmt = stmt.trim();
    let m;
    if ((m = stmt.match(/^assign\s+([\w-]+)\s*=\s*([\s\S]+)$/))) {
      const r = evalExpr(m[2], scope);
      if (r.tainted && !r.sanitizedBy) {
        scope.tainted.set(m[1], { kind: r.kind, reason: r.reason });
        if (r.settingType && RAW_CODE_SETTING_TYPES.has(r.settingType)) scope.rawCode.add(m[1]);
      } else {
        scope.tainted.delete(m[1]);
        scope.rawCode.delete(m[1]);
      }
    } else if ((m = stmt.match(/^for\s+([\w-]+)\s+in\s+([^\s]+)/))) {
      const t = refTaint(m[2], scope);
      if (t.tainted) scope.tainted.set(m[1], { kind: t.kind, reason: t.reason }); else scope.tainted.delete(m[1]);
    } else if ((m = stmt.match(/^echo\s+([\s\S]+)$/))) {
      ctx.output(m[1]);
    } else if ((m = stmt.match(/^render\s+['"]([^'"]+)['"]\s*,?\s*([\s\S]*)$/))) {
      ctx.render(m[1], m[2]);
    } else if (/^capture\s/.test(stmt) || /^endcapture/.test(stmt)) {
      // Output inside a capture is checked where it's written.
    }
    if (scope.isExtension) checkMetafieldNamespace(stmt, ctx);
  }
}

function checkMetafieldNamespace(expr, ctx) {
  const re = /\.metafields(?:\.([A-Za-z_][\w-]*)|\[\s*['"]([^'"]+)['"]\s*\])/g;
  let m;
  while ((m = re.exec(expr))) {
    const ns = m[1] || m[2];
    if (!ns.startsWith('$app') && !ns.startsWith('app--')) {
      ctx.flag('PUBLIC_METAFIELD_NAMESPACE', m[0], `reads the public \`${ns}\` namespace`);
    }
  }
}

// ---------------------------------------------------------------------------
// Context-aware scan of one Liquid file

function scanLiquid(file, seeds, renderCalls, emit) {
  const original = readFileSync(file, 'utf8');
  const src = stripLiquidComments(original).replace(/\{%-?\s*schema\s*-?%\}[\s\S]*?\{%-?\s*endschema\s*-?%\}/g, blank)
    .replace(/\{%-?\s*(javascript|stylesheet)\s*-?%\}[\s\S]*?\{%-?\s*end\1\s*-?%\}/g, blank);
  const scope = makeScope(file, original, seeds);

  // HTML tokenizer state
  let mode = 'text';          // text | tag | script | style
  let attr = null;            // { name, quote, valueStart } when inside an attribute value
  let jsQuote = null;         // quote char while inside a JS string in <script>
  let scriptStart = -1;
  let i = 0;

  const flag = (rule, snippet, detail, at, kind) => emit && report(file, original, at ?? i, rule, snippet, detail, kind);

  const output = (expr, at, raw) => {
    if (scope.isExtension) checkMetafieldNamespace(expr, { flag: (r, s, d) => flag(r, s, d, at) });
    const r = evalExpr(expr, scope);
    const isRaw = r.settingType && RAW_CODE_SETTING_TYPES.has(r.settingType);
    if (mode === 'script') {
      if (r.filters.includes('json')) {
        if (jsQuote) flag('JSON_IN_QUOTES', raw, 'json output inside a quoted string', at);
        return;
      }
      if (!r.tainted && !r.sanitizedBy) return;
      if (r.sanitizedBy && jsQuote && r.sanitizedBy.startsWith('escape')) {
        flag('ESCAPE_IN_SCRIPT', raw, `${r.reason || 'value'} escaped for HTML inside JavaScript`, at);
        return;
      }
      if (r.sanitizedBy && r.sanitizedBy !== 'escape' && r.sanitizedBy !== 'escape_once') return; // numbers, urls
      flag('SCRIPT_NOT_JSON', raw, `${r.reason || 'value'} printed inside <script>${jsQuote ? ' string' : ''}`, at, r.kind);
      return;
    }
    if (mode === 'style') {
      if (r.cssSafe || (r.settingType && CSS_SAFE_SETTING_TYPES.has(r.settingType))) return;
      if (!r.tainted && !r.sanitizedBy) return;
      if (r.sanitizedBy && !r.sanitizedBy.startsWith('escape')) return;
      flag('STYLE_NOT_ESCAPED', raw, `${r.reason || 'value'} printed inside <style>`, at, r.kind);
      return;
    }
    if (isRaw && r.tainted) {
      flag('RAW_CODE_SETTING', raw, `${r.reason} is rendered as code`, at);
      return;
    }
    if (r.tainted) {
      if (r.filters.includes('strip_html')) flag('STRIP_HTML_NOT_ESCAPE', raw, `${r.reason} only has strip_html`, at, r.kind);
      else flag('UNESCAPED_OUTPUT', raw, `${r.reason} printed without escaping${mode === 'tag' ? ' in an attribute' : ''}`, at, r.kind);
      return;
    }
    // Escaped, but in a place where escaping isn't enough.
    if (mode === 'tag' && r.sanitizedBy && refsIn(expr.split('|')[0]).some((ref) => refTaint(ref, scope).tainted)) {
      const base = refsIn(expr.split('|')[0]).map((ref) => refTaint(ref, scope)).find((t) => t.tainted);
      if (attr && !attr.quote) flag('UNQUOTED_ATTRIBUTE', raw, `${base.reason} in unquoted attribute \`${attr.name}\``, at);
      else if (attr && /^on/i.test(attr.name)) flag('EVENT_HANDLER_ATTRIBUTE', raw, `${base.reason} in \`${attr.name}\``, at);
      else if (attr && /^(href|src|action|formaction|data|srcdoc|xlink:href)$/i.test(attr.name)
        && src.slice(attr.valueStart, at).trim() === '' && r.sanitizedBy !== 'url_encode' && r.sanitizedBy !== 'url_param_escape') {
        flag('URL_ATTRIBUTE', raw, `${base.reason} starts the \`${attr.name}\` URL`, at);
      }
    }
  };

  const render = (name, args) => {
    const params = new Map();
    let m;
    if ((m = args.match(/^(with|for)\s+([\s\S]+?)\s+as\s+([\w-]+)/))) {
      const t = evalExpr(m[2], scope);
      if (t.tainted) params.set(m[3], t);
    } else if ((m = args.match(/^(with|for)\s+([^\s,]+)/))) {
      const t = evalExpr(m[2], scope);
      if (t.tainted) params.set(name.split('/').pop(), t);
    }
    for (const part of splitTop(args.replace(/^(with|for)\s+[\s\S]+?(\s+as\s+[\w-]+)?\s*(,|$)/, ''), ',')) {
      const kv = part.match(/^\s*([\w-]+)\s*:\s*([\s\S]+)$/);
      if (!kv) continue;
      const t = evalExpr(kv[2], scope);
      if (t.tainted && !t.sanitizedBy) params.set(kv[1], t);
    }
    if (params.size && renderCalls) {
      const target = join(codeRoot(file), 'snippets', `${name}.liquid`);
      const existing = renderCalls.get(target) || new Map();
      for (const [k, v] of params) {
        if (!existing.has(k)) existing.set(k, { kind: v.kind, reason: `${v.reason} (passed to snippet \`${name}\`)` });
      }
      renderCalls.set(target, existing);
    }
  };

  while (i < src.length) {
    // Liquid
    if (src.startsWith('{{', i)) {
      const end = src.indexOf('}}', i + 2);
      if (end < 0) break;
      const raw = src.slice(i, end + 2);
      const expr = raw.replace(/^\{\{-?/, '').replace(/-?\}\}$/, '').trim();
      if (expr) output(expr, i, raw);
      i = end + 2;
      continue;
    }
    if (src.startsWith('{%', i)) {
      const end = src.indexOf('%}', i + 2);
      if (end < 0) break;
      const raw = src.slice(i, end + 2);
      const body = raw.replace(/^\{%-?/, '').replace(/-?%\}$/, '').trim();
      if (body === 'style' && mode === 'text') { mode = 'style'; i = end + 2; continue; }
      if (body === 'endstyle' && mode === 'style') { mode = 'text'; i = end + 2; continue; }
      const at = i;
      handleTag(body, scope, {
        output: (expr) => output(expr, at, raw),
        render,
        flag: (rule, snippet, detail) => flag(rule, snippet, detail, at),
      });
      i = end + 2;
      continue;
    }

    const ch = src[i];
    if (mode === 'text') {
      if (ch === '<') {
        const tag = src.slice(i).match(/^<([a-zA-Z][\w:-]*)/);
        if (tag) {
          mode = 'tag';
          attr = null;
          scope.openTag = tag[1].toLowerCase();
          i += tag[0].length;
          continue;
        }
      }
    } else if (mode === 'tag') {
      if (attr) {
        if (attr.quote ? ch === attr.quote : /[\s>]/.test(ch)) {
          attr = null;
          if (ch === '>') { mode = enterContent(); i++; continue; }
        }
      } else if (ch === '>') {
        mode = enterContent();
        i++;
        continue;
      } else {
        const a = src.slice(i).match(/^([^\s=>"'/]+)\s*=\s*(["']?)/);
        if (a) {
          attr = { name: a[1], quote: a[2] || null, valueStart: i + a[0].length };
          i += a[0].length;
          continue;
        }
      }
    } else if (mode === 'script') {
      if (!jsQuote && /^<\/script/i.test(src.slice(i, i + 8))) {
        scanJs(file, original, src.slice(scriptStart, i), scriptStart, emit);
        mode = 'text';
        continue;
      }
      if (jsQuote) {
        if (ch === '\\') { i += 2; continue; }
        if (ch === jsQuote || (ch === '\n' && jsQuote !== '`')) jsQuote = null;
      } else if (ch === '"' || ch === "'" || ch === '`') {
        jsQuote = ch;
      } else if (ch === '/' && src[i + 1] === '/') {
        const nl = src.indexOf('\n', i);
        i = nl < 0 ? src.length : nl;
        continue;
      }
    } else if (mode === 'style') {
      if (/^<\/style/i.test(src.slice(i, i + 7))) { mode = 'text'; continue; }
    }
    i++;
  }

  function enterContent() {
    if (scope.openTag === 'script') {
      // JSON blocks and templates aren't executed as JavaScript.
      const tagText = src.slice(src.lastIndexOf('<script', i), i);
      const type = (tagText.match(/type\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
      if (type && !/javascript|module/i.test(type)) {
        const close = src.slice(i).search(/<\/script/i);
        const body = close < 0 ? '' : src.slice(i + 1, i + close);
        if (/json/i.test(type)) checkJsonBlock(body, i + 1);
        return 'text';
      }
      jsQuote = null;
      scriptStart = i + 1;
      return 'script';
    }
    if (scope.openTag === 'style') return 'style';
    return 'text';
  }

  // Inside <script type="application/json">, values must be `| json`.
  function checkJsonBlock(body, offset) {
    const re = /\{\{-?([\s\S]*?)-?\}\}/g;
    let m;
    while ((m = re.exec(body))) {
      const r = evalExpr(m[1].trim(), scope);
      if ((r.tainted || r.sanitizedBy?.startsWith('escape')) && !r.filters.includes('json')) {
        flag('SCRIPT_NOT_JSON', m[0], `${r.reason || 'value'} printed inside a JSON <script> block`, offset + m.index, r.kind);
      }
    }
  }

  return scope;
}

// ---------------------------------------------------------------------------
// JavaScript checks (asset files and inline <script>)

function scanJs(file, fullText, js, offset, emit) {
  if (!emit) return;
  // Blank out Liquid so it doesn't look like code.
  const code = js.replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g, blank);
  const at = (m) => offset + m.index;
  const checks = [
    [/\beval\s*\(/g, 'DYNAMIC_CODE', 'eval() runs a string as code'],
    [/\bnew\s+Function\s*\(/g, 'DYNAMIC_CODE', 'new Function() runs a string as code'],
    [/\b(?:setTimeout|setInterval)\s*\(\s*['"`]/g, 'STRING_TIMER', 'timer runs a string as code'],
    [/\.(?:innerHTML|outerHTML)\s*\+?=(?!=)(?!\s*['"`][^'"`$+]*['"`]\s*[;,)\n])/g, 'HTML_SINK', 'HTML written from a variable'],
    [/\binsertAdjacentHTML\s*\(/g, 'HTML_SINK', 'insertAdjacentHTML writes HTML'],
    [/\bdocument\.write(?:ln)?\s*\(/g, 'HTML_SINK', 'document.write writes HTML'],
    [/\.html\s*\((?!\s*\)|\s*['"`][^'"`$+]*['"`]\s*\))/g, 'HTML_SINK', 'jQuery .html() with a variable'],
    [/createElement\s*\(\s*['"]script['"]\s*\)/g, 'RUNTIME_SCRIPT', 'creates a <script> element at runtime'],
  ];
  for (const [re, rule, detail] of checks) {
    let m;
    while ((m = re.exec(code))) {
      const lineEnd = code.indexOf('\n', m.index);
      const lineStart = code.lastIndexOf('\n', m.index) + 1;
      report(file, fullText, at(m), rule, code.slice(lineStart, lineEnd < 0 ? undefined : lineEnd), detail);
    }
  }
}

// ---------------------------------------------------------------------------
// Run

// Taint flows from render calls into snippets, so iterate until it settles.
let seeds = new Map();
for (let pass = 0; pass < 4; pass++) {
  const calls = new Map();
  for (const f of liquidFiles) scanLiquid(f, seeds.get(f), calls, false);
  const same = calls.size === seeds.size && [...calls].every(([k, v]) => seeds.get(k)?.size === v.size);
  seeds = calls;
  if (same) break;
}
for (const f of liquidFiles) scanLiquid(f, seeds.get(f), null, true);

const MAX_JS_BYTES = 500_000;
const skipped = [];
for (const f of jsFiles) {
  const size = statSync(f).size;
  if (size > MAX_JS_BYTES) { skipped.push(relative(baseDir, f)); continue; }
  const text = readFileSync(f, 'utf8');
  scanJs(f, text, text, 0, true);
}

findings.sort((a, b) => (a.level === b.level ? 0 : a.level === 'FAIL' ? -1 : 1)
  || a.file.localeCompare(b.file) || a.line - b.line);
const fails = findings.filter((f) => f.level === 'FAIL').length;
const warns = findings.length - fails;
const result = fails ? 'FAIL' : warns ? 'WARN' : 'PASS';

if (opts.json) {
  console.log(JSON.stringify({
    result, scanned: { liquid: liquidFiles.length, js: jsFiles.length - skipped.length }, skipped,
    findings: findings.map(({ key, ...f }) => f),
  }, null, 2));
} else {
  console.log(`Escape scan: ${liquidFiles.length} Liquid file(s), ${jsFiles.length - skipped.length} JavaScript file(s)\n`);
  for (const f of findings) {
    console.log(`${f.level.padEnd(4)}  ${f.file}:${f.line}:${f.col}  ${f.rule}`);
    console.log(`      ${f.snippet}`);
    console.log(`      ${f.detail}. ${f.fix}\n`);
  }
  if (skipped.length) console.log(`Skipped (over 500 KB, likely bundled libraries): ${skipped.join(', ')}\n`);
  if (!liquidFiles.length && !jsFiles.length) console.log('No .liquid or asset .js files found. Point this at a theme, an app, or an extension folder.\n');
  console.log(`Result: ${result} (${fails} fail, ${warns} warn)`);
}
process.exit(fails ? 1 : warns ? 2 : 0);
