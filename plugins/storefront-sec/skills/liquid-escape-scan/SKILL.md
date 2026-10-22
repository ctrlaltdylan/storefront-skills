---
name: liquid-escape-scan
description: Scans a Shopify theme or theme app extension for output that isn't escaped for where it lands (HTML, attributes, <script>, <style>), settings read from public metafield namespaces, and JavaScript that runs strings as code. Use when a developer wants to harden a theme app extension or theme, review Liquid for XSS, check that metafields and settings are escaped, or asks how to protect against the October 2026 checkout hijack where app settings injected JavaScript.
allowed-tools: Bash, Read
---

# Theme escape scan

Checks the Liquid and JavaScript in a Shopify theme or theme app extension for the mistakes that let stored data become code on a storefront. It's based on Kirill Platonov's [Protect your Shopify theme app extensions from script injection](https://kirillplatonov.com/posts/protect-shopify-theme-app-extensions/).

Every `{{ }}` and `echo` is checked against where it lands:

| Where the value lands | What makes it safe |
| --- | --- |
| HTML text or a quoted attribute | `\| escape` |
| Inside `<script>` | `\| json`, with no quotes around it |
| Inside `<style>` or `{% style %}` | `\| replace: '</', '<\/'` |
| A URL attribute (`href`, `src`) | `\| escape`, plus a check that it starts with `https://` or `/` |

The script also follows values through `assign`, `for`, and `render` parameters into snippets, and reads each file's `{% schema %}` so constrained setting types like `color`, `number`, and `select` aren't flagged.

It only reads files. It never changes them.

## Steps

### 1. Find what to scan

Ask for the path if it isn't obvious. Any of these work:

- An app folder. The script finds every theme app extension under `extensions/`.
- One extension folder, like `extensions/my-theme-extension`.
- A theme folder, with `layout/`, `sections/`, and `snippets/`. Pull a live theme first with `shopify theme pull` if needed.

### 2. Run the scan

It needs Node.js 18 or newer and has no dependencies. The script lives next to this file in `scripts/`. In OpenClaw, that folder is `{baseDir}`.

```bash
node <this-skill-dir>/scripts/escape-scan.mjs <path>
```

Add `--json` for machine-readable output. By default only JavaScript in `assets/` folders is checked. Add `--all-js` to check every `.js` file under the path.

### 3. Read the results

| Result | Exit code | Meaning |
| --- | --- | --- |
| `PASS` | 0 | Nothing found |
| `FAIL` | 1 | Data from outside the theme editor reaches the page unescaped, or JavaScript runs strings as code |
| `WARN` | 2 | Escaping gaps that only someone who can already edit the theme could abuse, plus patterns worth a look |

How severity is decided:

- **FAIL:** metafields and metaobjects inside a theme app extension (your app's backend writes them, which is how the October 2026 attack got in), search terms, and `eval` or `new Function` in JavaScript.
- **WARN:** block, section, and theme settings. Anyone who can edit them can already add a Custom Liquid block, so escaping them is defense in depth, not a hard boundary. Also form values, line item properties, and cart notes, which Shopify's own Dawn theme prints without escaping, and metafields in a regular theme.

Still recommend fixing warnings in a theme app extension. Escaping costs nothing, and the extension's code shouldn't trust any value it renders.

### 4. Explain each finding and the fix

| Rule | What's wrong | Fix |
| --- | --- | --- |
| `UNESCAPED_OUTPUT` | A setting, metafield, or shopper input is printed as raw HTML | Add `\| escape` |
| `SCRIPT_NOT_JSON` | A value is printed inside `<script>` without `json` | `window.config = {{ value \| json }};` with no quotes |
| `STYLE_NOT_ESCAPED` | Custom CSS can close the `<style>` tag | `{{ css \| replace: '</', '<\/' }}`, and reject HTML tags when saving it |
| `JSON_IN_QUOTES` | `"{{ x \| json }}"` double-quotes the value | Remove the quotes |
| `ESCAPE_IN_SCRIPT` | `escape` used inside a JavaScript string | Switch to `json` without quotes |
| `UNQUOTED_ATTRIBUTE` | Escaped value in an attribute without quotes | Wrap the value in double quotes |
| `URL_ATTRIBUTE` | A setting starts an `href` or `src`, so it could be `javascript:` | Check the scheme before rendering |
| `EVENT_HANDLER_ATTRIBUTE` | A value is printed into `onclick` or another `on*` attribute | Pass it through a data attribute or `json` in a `<script>` |
| `STRIP_HTML_NOT_ESCAPE` | `strip_html` alone doesn't escape quotes or entities | Add `\| escape` |
| `RAW_CODE_SETTING` | An `html` or `liquid` setting is rendered | Remove it, or limit who can edit it |
| `PUBLIC_METAFIELD_NAMESPACE` | A theme app extension reads a public namespace that other apps and staff can change | Use `metafields['$app:your_namespace']` |
| `DYNAMIC_CODE` | `eval` or `new Function` in JavaScript | Ship the logic in bundled JS and read settings as data |
| `STRING_TIMER` | `setTimeout` or `setInterval` with a string | Pass a function |
| `HTML_SINK` | `innerHTML`, `insertAdjacentHTML`, `document.write`, or jQuery `.html()` with a variable | Use `textContent` or `createElement`, or sanitize the HTML |
| `RUNTIME_SCRIPT` | A `<script>` element is created at runtime | Make sure its URL is fixed and on a domain you control |

Show the user the file, line, and code for each `FAIL` first. Group repeated warnings by rule instead of listing every line.

### 5. Suppress what's been reviewed

If a finding has been checked and is safe, the user can add a comment containing `escape-scan-ignore` on the same line or the line above, like `{% # escape-scan-ignore: scheme checked above %}`. Suggest a short reason in the comment.

## Beyond this scan

- Also run Shopify's own checks. `shopify app security check` covers `THEME_EXTENSION_XSS`, `TEXT_SETTING_HTML_SMUGGLING`, and more. `shopify theme check` covers theme best practices.
- Escaping protects new output, not data already stored. Suggest auditing stored settings, custom CSS, and custom JS for external URLs, `eval`, `atob`, checkout button listeners, and known attack domains.
- Escape in internal admin and support tools too, and put 2FA on staff accounts. Those tools render the same merchant data.

## Limits to mention

- This is a pattern scan, not a full Liquid or JavaScript parser. It can miss values that pass through `capture`, filters it doesn't know, or JavaScript variables.
- `HTML_SINK` can't tell where HTML came from. Themes often insert HTML they fetched from Shopify's Section Rendering API, which is fine. Check where each one's data comes from.
- A `PASS` means none of these patterns were found, not that the code is free of injection bugs.
