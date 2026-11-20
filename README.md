# Blunder — the everyday store

A responsive grocery storefront with searchable categories, price filters, sorting,
product quick views, saved items and a persistent basket. The Node backend stores
orders and stock in SQLite, supports Cash on Delivery, and integrates Razorpay
with server-side totals, payment signatures and signed webhooks.

**Checkout uses the hosted order service and automatic seller alerts.** The customer confirms an order on the website. The backend stores it and queues the product list, totals, customer details and delivery location for the seller's email/SMS/WhatsApp providers. The customer does not send a WhatsApp message or email draft.

The seller destinations are `sdhanpal778@gmail.com` and `+919910113972` in `data/store.json`. Read [SELLER-NOTIFICATIONS.md](SELLER-NOTIFICATIONS.md) for the exact setup, trigger rules and recovery commands. Provider credentials belong in hosting secrets. The public static site preserves browsing and baskets while checkout is unavailable; it never invents a saved order or a notification receipt.

**Live setup is still required:** persistent backend hosting, actual inventory and delivery configuration, and at least one notification provider. Online payments separately require the owner's Razorpay account. These services have not been activated or represented as live by this change.

## AI shopping helper

The hosted Google Gemini service powers catalogue questions and basket suggestions. See [HOSTED-BACKEND.md](HOSTED-BACKEND.md) for backend and Firebase configuration. AI cannot place orders or verify payment.

## Run locally

Node **24 or later** is required; run `npm ci` before starting (Nodemailer provides SMTP delivery).

```sh
npm ci
npm start
# http://localhost:3000
npm test
```

`npm start` loads `.env` when present. The first start creates the database and
initialises each product/pack with **zero available stock**. It does not manufacture
inventory from a sample catalogue. `npm test` uses isolated databases and a fake
payment-provider boundary; it never charges money or contacts a real customer.

## Enable the hosted order and inventory service

1. Host this whole repository as one persistent Node application over HTTPS.
   `Dockerfile`, `compose.yaml` and a Render blueprint are provided. Use one app
   instance with a persistent volume for SQLite; an ephemeral/serverless filesystem
   will lose orders. The Render blueprint uses a paid persistent disk/service;
   review its price before deploying. No service has been purchased or deployed.
2. Copy `.env.example` to `.env` locally, or set the equivalent hosting secrets.
   Set `PUBLIC_ORIGIN` to the exact HTTPS storefront origin. Generate a private
   `ORDER_ACCESS_SECRET` (at least 32 characters); keep it stable across restarts.
3. Edit `data/store.json`: real seller/legal name, business address, working support
   email, delivery PIN codes, shipping charges/window, COD limit, and reviewed
   policies. Confirm that you can fulfil every listed product and price. Set
   `catalogApproved: true` only after reviewing the product images, sizes, supplier
   stock, applicable taxes, food handling and actual seller obligations.
4. Run the server once, then enter **real available quantities**:

   ```sh
   npm run store -- inventory
   npm run store -- stock banana:standard 25
   npm run store -- stock tomato:standard 40
   ```

5. Configure automatic seller alerts using [SELLER-NOTIFICATIONS.md](SELLER-NOTIFICATIONS.md), then set `STORE_ENABLED=true` and restart. Startup rejects missing seller, delivery or
   secret configuration. COD can work without Razorpay. Do a real owner-controlled
   fulfilment check before advertising the store.

Unconfirmed COD requests reserve stock for 24 hours. The seller should verify the
customer and fulfilment details before confirming; the site does not send SMS OTPs
or pretend to verify phone ownership. Confirmation and delivery are seller actions:

```sh
npm run store -- orders
npm run store -- order BL-ORDERREFERENCE
npm run store -- confirm-cod BL-ORDERREFERENCE
npm run store -- dispatch BL-ORDERREFERENCE https://your-carrier.example/track/...
npm run store -- deliver BL-ORDERREFERENCE
```

Only mark a COD delivery complete after payment has been collected. Customers can
cancel unfulfilled COD requests; stock is released once. Orders are visible using a
random reference plus a private access code. For hosted orders, the browser stores only these access
credentials; full order details are fetched with the private access code. Optional
delivery selections stay in tab session storage. Automatic seller notifications use
the configured providers; there is no pretend login or customer-facing admin.
Merchant management is via the hosting shell; protect hosting access and the disk.

## Enable online payments

Create and activate your own Razorpay merchant account. Configure **test keys first**:

- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `RAZORPAY_WEBHOOK_SECRET`

Configure the webhook URL as `https://YOUR_ORIGIN/api/webhooks/razorpay` for
`payment.captured`, `order.paid` and `refund.processed`. Configure automatic capture
in Razorpay. Secrets stay on the server; only the public key ID reaches the browser.
Test-key mode is labelled visibly and must not be advertised as taking real money.

The server rebuilds totals from its catalogue, validates pack, quantity, stock and
PIN code, and reserves inventory in a transaction. Repeated submission of the same
checkout is idempotent. A browser success callback is insufficient: its HMAC,
provider order ID, amount, INR currency and **captured** status are checked. Webhooks
also reconcile payment when the browser is closed. Signed duplicate events are
safe. Orders use private bearer access codes; keep them out of screenshots/logs.

Online reservations expire after 20 minutes. A late captured payment reacquires
stock when possible. Otherwise its status is `paid_review` and the customer sees
that fulfilment or a refund must be arranged. Never dispatch a `paid_review` order
until resolved. Full processed refunds update order status; handle partial refunds
and disputes in the merchant dashboard. There is no automatic promise of fulfilment
or instant refund. Gateway failure never displays a paid confirmation.

After a successful merchant test, use live keys and confirm the live webhook secret.
This implementation has been tested with an injected gateway; a real Razorpay
transaction cannot be verified without the owner's account and credentials.

## GitHub Pages plus a separate API

Serving the whole site from Node is the simplest deployment. If retaining the
GitHub Pages URL, set `window.BLUNDER_API_ORIGIN` in `store-config.js` to the backend
HTTPS origin, and `STOREFRONT_ORIGIN=https://aakash9972sn.github.io` on that backend.
CORS accepts only configured exact origins. If the API is unavailable, browsing and
baskets remain available but order submission is disabled. No third-party chat
handoff or fake order confirmation is used as an ordering fallback.

## Delivery maps and addresses

The location dialog includes explicit area/landmark/PIN search, opt-in GPS,
click/drag pin selection, keyboard pan with **Use map centre**, and manual address
entry. Confirming a location fills checkout; changing the linked city/state/PIN
removes the stale map point. No GPS call or map tile request happens before the
customer opens the picker and chooses the relevant action. GPS needs HTTPS (or
localhost) and browser permission. Addresses and points are kept only in the tab,
with a visible clear control. The final point becomes a directions link in the
seller notification or private hosted order/receipt.

Leaflet **1.9.4** is vendored in `assets/vendor/leaflet`; its BSD license is retained.
OpenStreetMap tiles and Nominatim are low-traffic defaults with visible attribution.
Configure `window.BLUNDER_MAPS` in `store-config.js` to switch browser providers.
On Node, `POST /api/maps/search` and `/api/maps/reverse` use the shared geocoder
proxy: explicit requests only, a 1.1-second queue, bounded one-hour cache, duplicate
request sharing and timeouts. `GEOCODER_URL` selects an HTTPS Nominatim-compatible
provider. Static GitHub Pages uses the configured browser provider directly, with
per-tab throttling and caching. For higher traffic, use a licensed or self-hosted
provider and update the server CSP for any new browser-facing tile/search origins.
Respect [OSM tile usage](https://operations.osmfoundation.org/policies/tiles/) and
[Nominatim usage](https://operations.osmfoundation.org/policies/nominatim/).

Map failures, denied GPS permission and missing geocoding results leave manual
address entry usable. The map does not prove delivery serviceability. Hosted orders enforce configured PIN codes; a selected point alone does not establish serviceability. Browser map tests use controlled provider/tile fixtures because the
cloud review network blocks the public map provider; live-provider availability
and GPS accuracy must be checked in the customer's browser.

## Product information and honest promotions

There are 12 grocery products, with owner-requested launch prices of ₹5–₹20
(average ₹9.17, excluding delivery). Image sources and license are recorded in
[`assets/SOURCES.md`](assets/SOURCES.md). Photos represent the product category;
exact packs, suppliers, image rights and inventory require seller review.

An 80–95% discount is **not** fabricated from an invented reference price. Add a
verified `mrp` in paise and a matching HTTPS `priceSource` for the same product/pack
to display an automatically calculated discount. No random real-looking support
address or guaranteed one-hour delivery is published. Shipping/returns policies
are included for review; delivery timing must match the seller's actual operation.

## Checks and operations

`npm test` covers pricing, coupons, stock, COD idempotency/cancellation, delivery
validation, gateway failure, signatures, amount/currency mismatch, captured-state
checks, webhooks/refunds, expired/late payments, database persistence, launch gating
and HTTP file/origin boundaries. It also covers coordinate validation, geocoder
queue/cache/error handling and automatic seller notification routing, complete delivery details, duplicate events, retry persistence and failures.
Browser verification also covers the complete COD
flow against isolated inventory, responsive layouts, keyboard dialogs, filtering,
saved items, basket reload, order lookup and receipt download.

The app uses native browser dialogs, reduced-motion preferences, CSS view
transitions and local fonts/images. Core shopping stays visible if motion APIs are
unavailable. JavaScript is required for the store; a no-script notice is provided.

Back up the SQLite database and its WAL correctly (SQLite backup API or stop the
app first), verify restores, retain the order secret securely, set appropriate
personal-data retention rules and monitor orders/webhooks. The included in-process
rate limit keys by socket address by default. `TRUST_PROXY_HOPS=1` is configured
for the Render blueprint; use it only behind a trusted proxy that appends or
overwrites X-Forwarded-For and prevents direct app access. Configure an edge
rate limiter for public traffic as well. An unauthenticated
visitor cannot read orders, modify inventory or choose their own payable amount.
