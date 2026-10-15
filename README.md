# storefront-skills

AI agent skills for Shopify merchants and developers. They work with Claude, Grok, OpenClaw, and other agents that can drive a browser.

## Plugins

| Plugin | Provides |
| --- | --- |
| `storefront-security` | `/check-checkout` command and `checkout-hijack-check` skill. Opens your store in a fresh browser, clicks **Checkout**, and flags phishing redirects or known attack indicators. |

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
openclaw skills install ./storefront-skills/plugins/storefront-security/skills/checkout-hijack-check
```

**Claude Code:** install the plugin, restart Claude Code, then run `/check-checkout https://yourstore.com`.

```bash
claude plugin marketplace add ctrlaltdylan/storefront-skills
claude plugin install storefront-security@storefront-skills
```

OpenClaw and Claude Code run the full script when Node.js 18 or newer is installed. Browser-only assistants follow the same steps by hand, but they can't inspect app API responses, so they won't catch a `WARN`.

### Run it without Claude Code

```bash
git clone https://github.com/ctrlaltdylan/storefront-skills.git
mkdir -p /tmp/checkout-check && cd /tmp/checkout-check
npm init -y >/dev/null && npm i playwright@1.63.0 && npx playwright install chromium
node ~/path/to/storefront-skills/plugins/storefront-security/skills/checkout-hijack-check/scripts/check-checkout.mjs https://yourstore.com --runs 3
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

Known domains and code markers live in [`indicators.json`](plugins/storefront-security/skills/checkout-hijack-check/scripts/indicators.json). Pull requests with new, published indicators are welcome.

## Updating

```bash
claude plugin marketplace update storefront-skills
claude plugin update storefront-security@storefront-skills
```

## License

[MIT](LICENSE)
