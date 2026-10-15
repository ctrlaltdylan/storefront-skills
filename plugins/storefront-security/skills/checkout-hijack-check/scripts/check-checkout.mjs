#!/usr/bin/env node
// Checks a Shopify storefront for checkout hijacking: opens the store in a
// fresh browser session, adds a product to the cart, clicks Checkout, and
// reports where the shopper actually ends up. It never fills in or submits
// anything on the checkout page.
//
// Usage:
//   node check-checkout.mjs <store-url> [--runs 3] [--product <handle>]
//        [--password <storefront password>] [--out <dir>] [--headed]
//
// Playwright is resolved from the current working directory, so run this from
// a folder where `npm i playwright` has been run.
//
// Exit codes: 0 = no problems found, 1 = hijack or known indicator found,
// 2 = warnings only, 3 = inconclusive (couldn't reach checkout), 4 = usage/setup error.

import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const indicators = JSON.parse(readFileSync(join(here, 'indicators.json'), 'utf8'));

function parseArgs(argv) {
  const opts = { runs: 3, headed: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs') opts.runs = Math.max(1, Math.min(10, parseInt(argv[++i], 10) || 3));
    else if (a === '--product') opts.product = argv[++i];
    else if (a === '--password') opts.password = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--headed') opts.headed = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else rest.push(a);
  }
  opts.url = rest[0];
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || !opts.url) {
  console.log('Usage: node check-checkout.mjs <store-url> [--runs 3] [--product <handle>] [--password <pw>] [--out <dir>] [--headed]');
  process.exit(opts.help ? 0 : 4);
}

let playwright;
try {
  playwright = createRequire(join(process.cwd(), 'noop.js'))('playwright');
} catch {
  console.error('Playwright isn\'t installed in this folder. Run:\n  npm i playwright@1.63.0 && npx playwright install chromium');
  process.exit(4);
}
const { chromium, devices } = playwright;

const storeUrl = new URL(/^https?:\/\//.test(opts.url) ? opts.url : `https://${opts.url}`);
const origin = storeUrl.origin;
const storeHost = storeUrl.hostname;
const outDir = opts.out || join(process.cwd(), `checkout-check-${storeHost}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(outDir, { recursive: true });

// Hosts a legitimate Shopify checkout can live on: the store's own domain
// (and its subdomains, like checkout.brand.com) plus Shopify's own.
const baseDomain = storeHost.replace(/^www\./, '');
const SHOPIFY_HOSTS = ['myshopify.com', 'shopify.com', 'shop.app', 'shopifycs.com', 'shopifysvc.com', 'shopifyinc.com'];
const hostMatches = (host, domain) => host === domain || host.endsWith(`.${domain}`);
const isAllowedHost = (host) => hostMatches(host, baseDomain) || SHOPIFY_HOSTS.some((d) => hostMatches(host, d));
const isIocHost = (host) => indicators.domains.some((d) => hostMatches(host, d));
const looksLikeCheckout = (url) => /\/checkouts?\b|\/cn\//.test(new URL(url).pathname);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Recursively look for non-empty custom code fields in a JSON payload.
function findCustomCode(value, path = '$', hits = []) {
  if (hits.length > 20 || value === null || typeof value !== 'object') return hits;
  for (const [k, v] of Object.entries(value)) {
    const p = `${path}.${k}`;
    if (indicators.customCodeKeys.includes(k) && typeof v === 'string' && v.trim().length > 0) {
      hits.push({ path: p, length: v.length, preview: v.trim().slice(0, 160) });
    } else if (typeof v === 'object') {
      findCustomCode(v, p, hits);
    }
  }
  return hits;
}

async function runOnce(browser, runIndex) {
  const mobile = runIndex % 2 === 1;
  const context = await browser.newContext({
    ...(mobile ? devices['iPhone 13'] : { viewport: { width: 1366, height: 900 } }),
    locale: 'en-US',
  });
  const page = await context.newPage();
  const result = {
    run: runIndex + 1,
    device: mobile ? 'mobile' : 'desktop',
    status: 'inconclusive',
    reasons: [],
    navigationsAfterClick: [],
    iocRequests: [],
    iocStrings: [],
    customCode: [],
    suspiciousSessionKeys: [],
    thirdPartyScriptHosts: [],
  };
  const scriptHosts = new Set();
  const seenBodies = new Set();
  let clicked = false;

  page.on('request', (req) => {
    let host;
    try { host = new URL(req.url()).hostname; } catch { return; }
    if (isIocHost(host)) result.iocRequests.push({ url: req.url(), afterClick: clicked });
    if (req.resourceType() === 'script' && !isAllowedHost(host)) scriptHosts.add(host);
  });

  page.on('response', async (res) => {
    const type = res.request().resourceType();
    if (!['script', 'xhr', 'fetch'].includes(type)) return;
    const url = res.url();
    if (seenBodies.has(url)) return;
    seenBodies.add(url);
    const ct = res.headers()['content-type'] || '';
    if (!/javascript|json|text/.test(ct)) return;
    let body;
    try { body = await res.text(); } catch { return; }
    if (!body || body.length > 5_000_000) return;
    for (const s of [...indicators.strings, ...indicators.domains]) {
      if (body.includes(s)) result.iocStrings.push({ indicator: s, url });
    }
    if (/json/.test(ct) || /^\s*[{[]/.test(body)) {
      try {
        for (const hit of findCustomCode(JSON.parse(body))) result.customCode.push({ url, ...hit });
      } catch { /* not JSON */ }
    }
  });

  page.on('framenavigated', (frame) => {
    if (clicked && frame === page.mainFrame()) result.navigationsAfterClick.push(frame.url());
  });
  const popups = [];
  context.on('page', (p) => { if (clicked) popups.push(p); });

  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    if (new URL(page.url()).pathname.startsWith('/password')) {
      if (!opts.password) {
        result.reasons.push('Store is password-protected. Rerun with --password.');
        return result;
      }
      await page.fill('input[type="password"]', opts.password);
      await Promise.all([
        page.waitForNavigation({ timeout: 20_000 }).catch(() => {}),
        page.press('input[type="password"]', 'Enter'),
      ]);
    }

    // Add one product to the cart with Shopify's public cart API
    const added = await page.evaluate(async (handle) => {
      let variantId;
      if (handle) {
        const r = await fetch(`/products/${handle}.js`);
        if (!r.ok) return { error: `Product "${handle}" not found` };
        const p = await r.json();
        variantId = (p.variants.find((v) => v.available) || p.variants[0])?.id;
      } else {
        const r = await fetch('/products.json?limit=50');
        if (!r.ok) return { error: 'Could not list products. Rerun with --product <handle>.' };
        const { products } = await r.json();
        for (const p of products) {
          const v = p.variants.find((x) => x.available);
          if (v) { variantId = v.id; break; }
        }
      }
      if (!variantId) return { error: 'No in-stock product found. Rerun with --product <handle>.' };
      const add = await fetch('/cart/add.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ id: variantId, quantity: 1 }] }),
      });
      return add.ok ? { variantId } : { error: `Add to cart failed (${add.status})` };
    }, opts.product);
    if (added.error) {
      result.reasons.push(added.error);
      return result;
    }

    await page.goto(`${origin}/cart`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

    // Some themes make shoppers agree to terms before checking out
    for (const box of await page.locator('input[type="checkbox"][name*="agree" i], input[type="checkbox"][id*="agree" i], input[type="checkbox"][name*="terms" i], input[type="checkbox"][id*="terms" i]').all()) {
      if (await box.isVisible().catch(() => false)) await box.check().catch(() => {});
    }

    const selectors = [
      'button[name="checkout"]',
      'input[name="checkout"]',
      'form[action*="/cart"] button[type="submit"]:has-text("check")',
      'a[href*="/checkout"]',
      'button:has-text("Check out")',
      'button:has-text("Checkout")',
    ];
    let button;
    for (const sel of selectors) {
      for (const el of await page.locator(sel).all()) {
        if (await el.isVisible().catch(() => false)) { button = el; break; }
      }
      if (button) break;
    }
    if (!button) {
      result.reasons.push('Could not find a visible Checkout button on /cart.');
      await page.screenshot({ path: join(outDir, `run-${result.run}-cart.png`) }).catch(() => {});
      return result;
    }

    clicked = true;
    await button.click({ timeout: 10_000 });
    await page.waitForURL((u) => u.pathname !== '/cart', { timeout: 25_000 }).catch(() => {});
    // Let any delayed redirect fire
    await sleep(6_000);

    const finalUrl = page.url();
    result.finalUrl = finalUrl;
    for (const p of popups) result.navigationsAfterClick.push(`(new tab) ${p.url()}`);
    await page.screenshot({ path: join(outDir, `run-${result.run}-after-click.png`) }).catch(() => {});

    const offsite = [...result.navigationsAfterClick, finalUrl]
      .map((u) => u.replace(/^\(new tab\) /, ''))
      .filter((u) => /^https?:/.test(u))
      .filter((u) => !isAllowedHost(new URL(u).hostname));
    result.offsiteNavigations = [...new Set(offsite)];

    // Read sessionStorage for the store origin. It survives navigation in the same tab.
    await page.goto(`${origin}/cart`, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    const keys = await page.evaluate(() => Object.keys(sessionStorage)).catch(() => []);
    result.suspiciousSessionKeys = keys.filter((k) => indicators.sessionStorageKeyPatterns.some((re) => new RegExp(re).test(k)));

    if (result.offsiteNavigations.length) {
      result.status = 'fail';
      result.reasons.push(`Checkout sent the shopper off Shopify to: ${result.offsiteNavigations.join(', ')}`);
    } else if (looksLikeCheckout(finalUrl)) {
      result.status = 'pass';
    } else {
      result.reasons.push(`Ended on ${finalUrl}, which doesn't look like a checkout page.`);
    }
  } catch (err) {
    result.reasons.push(`Error: ${err.message.split('\n')[0]}`);
  } finally {
    result.thirdPartyScriptHosts = [...scriptHosts].sort();
    if (result.iocRequests.length || result.iocStrings.length) {
      result.status = 'fail';
      result.reasons.push('Known indicators from the October 2026 campaign were found.');
    } else if (result.status !== 'fail' && (result.customCode.length || result.suspiciousSessionKeys.length)) {
      if (result.status === 'pass') result.status = 'warn';
      if (result.customCode.length) result.reasons.push('An app returned custom JavaScript in its settings. Review it.');
    }
    if (result.suspiciousSessionKeys.length) result.reasons.push(`Suspicious sessionStorage keys: ${result.suspiciousSessionKeys.join(', ')}`);
    await context.close();
  }
  return result;
}

const browser = await chromium.launch({ headless: !opts.headed });
const runs = [];
for (let i = 0; i < opts.runs; i++) {
  process.stdout.write(`Run ${i + 1}/${opts.runs}... `);
  const r = await runOnce(browser, i);
  runs.push(r);
  console.log(r.status.toUpperCase());
  if (i < opts.runs - 1) await sleep(3_000);
}
await browser.close();

const rank = { fail: 4, warn: 3, inconclusive: 2, pass: 1 };
const overall = runs.reduce((worst, r) => (rank[r.status] > rank[worst] ? r.status : worst), 'pass');
const allHosts = [...new Set(runs.flatMap((r) => r.thirdPartyScriptHosts))].sort();
const report = { store: origin, checkedAt: new Date().toISOString(), overall, runs, thirdPartyScriptHosts: allHosts };
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));

console.log(`\nOverall: ${overall.toUpperCase()}`);
for (const r of runs) {
  console.log(`\nRun ${r.run} (${r.device}): ${r.status.toUpperCase()}`);
  if (r.finalUrl) console.log(`  Ended on: ${r.finalUrl}`);
  for (const reason of r.reasons) console.log(`  - ${reason}`);
  for (const c of r.customCode) console.log(`  - Custom code at ${c.path} (${c.length} chars) from ${c.url}`);
  for (const s of r.iocStrings) console.log(`  - Indicator "${s.indicator}" in ${s.url}`);
  for (const q of r.iocRequests) console.log(`  - Request to known bad domain: ${q.url}`);
}
console.log(`\nThird-party script hosts loaded on the storefront (${allHosts.length}):`);
for (const h of allHosts) console.log(`  ${h}`);
console.log(`\nReport and screenshots: ${outDir}`);

process.exit({ fail: 1, warn: 2, inconclusive: 3, pass: 0 }[overall]);
