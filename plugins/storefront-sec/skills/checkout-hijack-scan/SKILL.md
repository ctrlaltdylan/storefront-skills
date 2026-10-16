---
name: checkout-hijack-scan
description: Checks a Shopify store for checkout hijacking, where injected JavaScript sends shoppers to a fake checkout that steals card details. Opens the store in a fresh browser, adds a product to the cart, clicks Checkout, and reports where the shopper lands plus any known attack indicators. Use when a merchant wants to test their own storefront, suspects a phishing redirect, or asks about the October 2026 "fake checkout" / custom JS campaign.
allowed-tools: Bash, Read
---

# Checkout hijack check

Tests whether a Shopify store's **Checkout** button really goes to Shopify's checkout, or gets taken over by injected JavaScript and sent to a phishing page.

The script:

1. Opens the store in a brand-new browser session (the known attack only fires once per session)
2. Adds one in-stock product to the cart using Shopify's public cart API
3. Clicks **Checkout** on `/cart`, the same way a shopper would
4. Records every page the browser lands on, plus every script and API response
5. Stops at the checkout page. It **never** fills in or submits anything there

It alternates desktop and mobile across runs, since attacks can target one or the other.

## Before you start

- **Only check stores the user owns or has permission to test.** Each run creates an abandoned checkout on the store, which is harmless but shows up in the admin. If the user names a store that isn't theirs, explain this and don't run it.
- **Pick a mode.** If you can run shell commands and Node.js 18 or newer is installed (check with `node --version`), use the script in the steps below. It's more thorough. If you can only control a browser, skip to [Browser-only mode](#browser-only-mode).

## Steps

### 1. Get the store URL

Ask for the storefront URL if you don't have it, such as `https://mystore.com` or `mystore.myshopify.com`. Use the domain shoppers actually visit.

### 2. Set up Playwright in a temporary folder

Run this once per machine. Don't install into the user's project.

```bash
mkdir -p "${TMPDIR:-/tmp}/checkout-hijack-scan" && cd "${TMPDIR:-/tmp}/checkout-hijack-scan"
[ -f package.json ] || npm init -y >/dev/null
npm i playwright@1.63.0 && npx playwright install chromium
```

### 3. Run the check

Run from that same folder. The script lives next to this file in `scripts/`. In OpenClaw, that folder is `{baseDir}`.

```bash
cd "${TMPDIR:-/tmp}/checkout-hijack-scan"
node <this-skill-dir>/scripts/check-checkout.mjs https://mystore.com --runs 3
```

Options:

| Flag | Use it when |
| --- | --- |
| `--runs <n>` | Change the number of fresh sessions (default 3, max 10) |
| `--product <handle>` | The store hides `/products.json`, or the first products are sold out |
| `--password <pw>` | The storefront is password-protected |
| `--headed` | The user wants to watch the browser do it |
| `--out <dir>` | Save the report and screenshots somewhere specific |

It takes about 30 to 60 seconds per run.

### 4. Read the results

The script prints a summary and saves `report.json` plus screenshots. Read the screenshots for any run that isn't `PASS`.

| Result | Exit code | Meaning |
| --- | --- | --- |
| `PASS` | 0 | Checkout reached Shopify, with no known indicators found |
| `FAIL` | 1 | Shopper was sent off Shopify, or a known attack indicator was found |
| `WARN` | 2 | Checkout looked fine, but an app returned custom JavaScript in its settings or a suspicious session key was set |
| `INCONCLUSIVE` | 3 | Couldn't reach checkout (password page, no product, no Checkout button) |

Explain the result in plain language. Most merchants aren't developers.

### 5. Review the third-party script list

The report lists every non-Shopify domain that loaded a script on the storefront. Go through it with the user. Each one should match an app they know they installed, or a service they use, like analytics or reviews. Flag anything they don't recognize.

## Browser-only mode

Use this when you can drive a browser but can't run commands, like Claude in Chrome or Grok Bot. Do 3 runs. Start each one in a **brand-new tab**, because the known attack stores its "already fired" flag in `sessionStorage`, which a new tab doesn't share.

1. Open the store.
2. Add any in-stock product to the cart, then go to `/cart`.
3. Click **Checkout** once.
4. Wait a few seconds, then note the full address of the page you land on. **Don't type anything on that page.**
5. Go back to the store in the same tab. If you can run JavaScript, run `Object.keys(sessionStorage)` and note any key that starts with `__ctf_`.
6. If you can see network requests, note any request to a domain in `scripts/indicators.json`.

Then give a result:

- **PASS:** every run landed on the store's own domain or a Shopify domain (`shopify.com`, `myshopify.com`, `shop.app`), and steps 5 and 6 found nothing.
- **FAIL:** any run landed somewhere else, or steps 5 or 6 found something. Say exactly what you saw.
- **INCONCLUSIVE:** you couldn't reach checkout. Say what got in the way.

This mode can't see app API responses, so it won't catch a `WARN`. Mention that the script mode checks more if the user ever has a terminal.

## If the result is FAIL

Tell the user clearly that customers may be at risk, then walk them through:

1. **Contact Shopify Support right away** and share the report and screenshots
2. **Find the source.** Check each app's settings for "custom JS," "custom code," or "advanced" fields. Then check **Online Store > Themes > Customize > App embeds**, any Custom Liquid blocks, `theme.liquid` under **Edit code**, and **Settings > Customer events**. The `url` fields in `report.json` show which server sent the code.
3. **Turn off the source**, whether that's disabling the app embed, removing the app, or deleting the code
4. **Secure accounts.** Change the Shopify password and any app vendor dashboard passwords. Turn on 2FA for every staff account, and remove staff who no longer need access.
5. **Contact the app developer** and ask in writing for timestamps and the exact code that ran
6. **Talk to the payment provider** about next steps for customers who may have entered card details
7. **Run the check again** to confirm the redirect is gone

Don't guess whether the app or a staff account was compromised. Only the investigation can show that.

## If the result is WARN

An app returning custom JavaScript isn't proof of an attack. Many apps offer a "custom JS" box. But it's exactly how the October 2026 attack was delivered. Show the user the preview from the report, and ask whether they (or someone on their team) added it. If nobody recognizes it, treat it as a FAIL.

## If the result is INCONCLUSIVE

Fix what the reason says, using `--password` or `--product <handle>`. If the cart page uses a custom drawer or a nonstandard button, rerun with `--headed` to see what happened. If it still can't reach checkout, have the user test by hand: open a **new private window**, add something to the cart, click **Checkout**, and check that the address bar shows their own domain or Shopify's.

## Limits to mention

A `PASS` is good news, not a guarantee:

- Attacks can target certain countries, devices, or times of day. This check runs from one location at one time.
- Some attacks only fire for a share of visitors. Running more sessions with `--runs` helps.
- The indicator list in `scripts/indicators.json` only covers what's been published. New campaigns use new domains.

Suggest rerunning the check every so often, and after installing or updating any app.
