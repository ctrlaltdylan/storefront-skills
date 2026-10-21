# storefront-skills

AI agent skills for Shopify merchants and developers. They work with Claude, Grok, OpenClaw, Muse, and other agents that can drive a browser or run commands.

## Plugins

| Plugin | Provides |
| --- | --- |
| `storefront-sec` | `/storefront-sec:checkout:hijack-scan` and the `checkout-hijack-scan` skill: opens your store in a fresh browser, clicks **Checkout**, and flags phishing redirects or known attack indicators. |
| | `/storefront-sec:liquid:escape-scan` and the `liquid-escape-scan` skill: scans a theme or theme app extension for output that isn't escaped, public metafield namespaces, and JavaScript that runs strings as code. |

## Check your store's checkout

In October 2026, attackers injected JavaScript into Shopify storefronts through third-party apps' "custom JS" settings. When shoppers clicked **Checkout**, they were sent to a fake checkout page that stole their card details. The code only fired once per browser session, so merchants testing their own stores often saw nothing wrong.

This check does what a first-time shopper would do:

1. Opens your store in a brand-new browser session
2. Adds an in-stock product to the cart
3. Clicks **Checkout**
4. Reports where it landed, plus any known attack indicators

It stops at the checkout page and never enters or submits anything. Each run leaves an abandoned checkout in your admin, which is harmless.

**Only run it on stores you own or have permission to test.**

### Run it with your AI assistant

**Claude** ([Claude in Chrome](https://claude.com/chrome), paid plans): open the extension and paste the prompt from [`PROMPT.md`](PROMPT.md), with your store's address filled in.

**Grok** ([Grok Bot](https://x.ai)): start a new task and paste the prompt from [`PROMPT.md`](PROMPT.md). Grok Bot runs in its own cloud browser.

**OpenClaw:** install the skill, then start a new session and ask it to check your store's checkout.

```bash
git clone https://github.com/ctrlaltdylan/storefront-skills.git
openclaw skills install ./storefront-skills/plugins/storefront-sec/skills/checkout-hijack-scan
```

**Muse Code:** copy the skill into Muse's skills folder, run `muse skills list` to confirm it's there, then ask Muse to check your store's checkout.

```bash
git clone https://github.com/ctrlaltdylan/storefront-skills.git
mkdir -p ~/.agents/skills
cp -R storefront-skills/plugins/storefront-sec/skills/checkout-hijack-scan ~/.agents/skills/
```

**Claude Code:** install the plugin, restart Claude Code, then run `/storefront-sec:checkout:hijack-scan https://yourstore.com`.

```bash
claude plugin marketplace add ctrlaltdylan/storefront-skills
claude plugin install storefront-sec@storefront-skills
```

OpenClaw, Muse Code, and Claude Code run the full script when Node.js 18 or newer is installed. Browser-only assistants follow the same steps by hand, but they can't inspect app API responses, so they won't catch a `WARN`.

### Run it without Claude Code

```bash
git clone https://github.com/ctrlaltdylan/storefront-skills.git
mkdir -p /tmp/checkout-check && cd /tmp/checkout-check
npm init -y >/dev/null && npm i playwright@1.63.0 && npx playwright install chromium
node ~/path/to/storefront-skills/plugins/storefront-sec/skills/checkout-hijack-scan/scripts/check-checkout.mjs https://yourstore.com --runs 3
```

| Flag | Use it when |
| --- | --- |
| `--runs <n>` | Change the number of fresh sessions (default 3, max 10) |
| `--product <handle>` | Your store hides `/products.json`, or the first products are sold out |
| `--password <pw>` | Your storefront is password-protected |
| `--headed` | You want to watch the browser |
| `--out <dir>` | Save the report and screenshots somewhere specific |

### Results

| Result | Meaning |
| --- | --- |
| `PASS` | Checkout reached Shopify, with no known indicators found |
| `FAIL` | The shopper was sent off Shopify, or a known attack indicator was found. Contact Shopify Support now. |
| `WARN` | Checkout looked fine, but an app returned custom JavaScript in its settings. Make sure you recognize it. |
| `INCONCLUSIVE` | The check couldn't reach checkout. Try `--product` or `--password`, or test by hand in a private window. |

A `PASS` is good news, not a guarantee. Attacks can target certain countries, devices, or times, and new campaigns use new domains. Rerun the check every so often, and after installing or updating apps.

### Indicators

Known domains and code markers live in [`indicators.json`](plugins/storefront-sec/skills/checkout-hijack-scan/scripts/indicators.json). Pull requests with new, published indicators are welcome.

## Scan your theme or app extension for unescaped output

For developers. The October 2026 attack worked because app settings became code on the storefront. This scan checks the Liquid and JavaScript you ship for the same kind of gap, based on Kirill Platonov's [Protect your Shopify theme app extensions from script injection](https://kirillplatonov.com/posts/protect-shopify-theme-app-extensions/).

It checks that every value is escaped for where it lands:

| Where the value lands | What makes it safe |
| --- | --- |
| HTML text or a quoted attribute | `\| escape` |
| Inside `<script>` | `\| json`, with no quotes around it |
| Inside `<style>` | `\| replace: '</', '<\/'` |

It also flags theme app extensions that read settings from public metafield namespaces instead of `$app:`, and `eval`, `new Function`, and `innerHTML` with variables in your JavaScript. Values are followed through `assign`, `for`, and snippet parameters, and each file's `{% schema %}` is read so constrained settings like `color` aren't flagged.

**Claude Code:** with the plugin installed, run `/storefront-sec:liquid:escape-scan` from your app or theme folder.

**OpenClaw or Muse Code:** install the `liquid-escape-scan` skill the same way as above, then ask your agent to scan your theme app extension for unescaped output.

**Anything else:** it's one Node.js 18+ script with no dependencies.

```bash
node storefront-skills/plugins/storefront-sec/skills/liquid-escape-scan/scripts/escape-scan.mjs path/to/your-app
```

Point it at an app folder (it finds `extensions/`), one extension, or a theme. Add `--json` for CI. It exits with `1` on `FAIL`, `2` on `WARN` only, and `0` when clean.

| Result | Meaning |
| --- | --- |
| `FAIL` | App data (metafields in a theme app extension) or search terms reach the page unescaped, or JavaScript runs strings as code |
| `WARN` | Settings that only theme editors can change are unescaped, plus patterns worth a look, like `innerHTML` |
| `PASS` | None of these patterns were found |

Mark a reviewed line with a comment containing `escape-scan-ignore`. Run the tests with `node --test tests/*.test.mjs`.

## Updating

```bash
claude plugin marketplace update storefront-skills
claude plugin update storefront-sec@storefront-skills
```

Installed it before version 2.0.0? The plugin was renamed from `storefront-security`, so swap it out:

```bash
claude plugin uninstall storefront-security@storefront-skills
claude plugin install storefront-sec@storefront-skills
```

## License

[MIT](LICENSE)
