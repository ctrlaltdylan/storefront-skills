# Checkout hijack check: copy-paste prompt

Use this with any AI agent that can control a web browser, like Claude in Chrome or Grok Bot. Replace `https://yourstore.com` with your store's address, then paste the whole thing.

```text
Check my Shopify store's checkout for a phishing redirect. My store is https://yourstore.com. Only test this store.

Do this 3 times. Each time, start in a brand-new browser tab:
1. Open my store.
2. Add any in-stock product to the cart, then go to the /cart page.
3. Click the Checkout button once.
4. Wait a few seconds, then write down the full address of the page you land on. Don't type anything on that page.
5. Go back to my store in the same tab. If you can run JavaScript, run Object.keys(sessionStorage) and write down any key that starts with __ctf_.
6. If you can see network requests, write down any request to biliing.top, checkout-confirm.top, or order-confirm.top.

Then give me a result:
- PASS if every run landed on my store's domain or a Shopify domain (shopify.com, myshopify.com, shop.app), with nothing found in steps 5 or 6.
- FAIL if any run landed on a different domain, or steps 5 or 6 found something. Tell me exactly what you saw.
- INCONCLUSIVE if you couldn't reach checkout. Tell me what got in the way.

If it's a FAIL, tell me to contact Shopify Support right away, and to check every app's settings for "custom JS" or "custom code" fields.
```

A `PASS` is good news, not a guarantee. Attacks can target certain countries, devices, or times of day. Rerun the check every so often, and after you install or update apps.
