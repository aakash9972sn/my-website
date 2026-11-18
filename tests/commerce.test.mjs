import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommerce } from "../server/commerce.mjs";
import { loadSettings } from "../server/index.mjs";
const catalog = JSON.parse(
  readFileSync(new URL("../data/catalog.json", import.meta.url)),
);
const base = JSON.parse(
  readFileSync(new URL("../data/store.json", import.meta.url)),
);
const customer = {
  name: "Test Buyer",
  email: "buyer@example.test",
  phone: "9876543210",
  address: "12 Test Street, Test Building",
  city: "New Delhi",
  state: "Delhi",
  pincode: "110027",
};
const items = [{ productId: "banana", variantId: "standard", quantity: 2 }];
const payload = (method = "cod") => ({ customer, items, method });
function fixture(extra = {}) {
  let clock = 1800000000000;
  const payments = new Map();
  let sequence = 0;
  const gateway = {
    keyId: "rzp_test_fixture",
    secret: "test-provider-secret",
    webhookSecret: "test-webhook-secret",
    createOrder: async (body) => ({ ...body, id: `order_${++sequence}` }),
    getPayment: async (id) => payments.get(id),
    getPayments: async (id) =>
      [...payments.values()].filter((p) => p.order_id === id),
  };
  const store = createCommerce({
    catalog,
    config: {
      ...base,
      shipping: { ...base.shipping, pincodes: ["110027"] },
      coupons: [{ code: "TEN", percent: 10, minimum: 500, maximum: 1000 }],
    },
    secret: "test-order-secret-long-enough-for-testing",
    enabled: true,
    gateway,
    now: () => clock,
    ...extra,
  });
  store.db.prepare("UPDATE inventory SET stock=20").run();
  return {
    store,
    gateway,
    payments,
    advance: (value) => {
      clock += value;
    },
  };
}
test("server computes INR prices and shipping, ignoring client totals", (t) => {
  const { store } = fixture();
  t.after(() => store.close());
  const q = store.quote({
    items: [{ ...items[0], price: 1 }],
    total: 1,
    shipping: 0,
  });
  assert.equal(q.subtotal, 1000);
  assert.equal(q.shipping, 2000);
  assert.equal(q.total, 3000);
  assert.equal(q.currency, "INR");
  assert.throws(() => store.quote({ items: [{ ...items[0], quantity: 1.5 }] }));
  assert.throws(() => store.quote({ items: [{ ...items[0], quantity: -1 }] }));
  assert.throws(() =>
    store.quote({ items: [{ ...items[0], variantId: "fake" }] }),
  );
  assert.throws(() =>
    store.quote({ items: [{ ...items[0], productId: "fake" }] }),
  );
});
test("duplicate lines merge and cannot bypass quantity caps or stock", (t) => {
  const { store } = fixture();
  t.after(() => store.close());
  assert.equal(
    store.quote({ items: [items[0], items[0]] }).items[0].quantity,
    4,
  );
  assert.throws(() =>
    store.quote({
      items: [
        { ...items[0], quantity: 6 },
        { ...items[0], quantity: 6 },
      ],
    }),
  );
  store.db.prepare("UPDATE inventory SET stock=1").run();
  assert.throws(() => store.quote({ items }), /stock/);
});
test("coupons and free shipping are calculated by the server", (t) => {
  const { store } = fixture();
  t.after(() => store.close());
  assert.equal(store.quote({ items, coupon: "ten" }).discount, 100);
  assert.throws(() => store.quote({ items, coupon: "FAKE95" }));
  assert.equal(
    store.quote({
      items: [{ productId: "rice", variantId: "standard", quantity: 10 }],
    }).shipping,
    0,
  );
});
test("COD persists a request, reserves stock, is idempotent, and supports private cancellation", async (t) => {
  const { store } = fixture();
  t.after(() => store.close());
  const key = randomUUID(),
    order = await store.place(payload(), key);
  assert.equal(order.status, "cod_pending");
  assert.equal(order.method, "cod");
  assert.equal(store.stock("banana:standard"), 18);
  const again = await store.place(payload(), key);
  assert.equal(again.id, order.id);
  assert.equal(again.accessToken, order.accessToken);
  assert.equal(store.stock("banana:standard"), 18);
  await assert.rejects(
    store.place({ ...payload(), items: [{ ...items[0], quantity: 3 }] }, key),
    /different/,
  );
  await assert.rejects(store.getOrder(order.id, "wrong-token"), /not found/);
  assert.equal((await store.getOrder(order.id, order.accessToken)).total, 3000);
  assert.equal(store.cancel(order.id, order.accessToken).status, "cancelled");
  assert.equal(store.stock("banana:standard"), 20);
  assert.throws(() => store.cancel(order.id, order.accessToken));
});
test("closed storefront, invalid address and unsupported PIN cannot place real orders", async (t) => {
  const { store } = fixture();
  t.after(() => store.close());
  await assert.rejects(
    store.place(
      { ...payload(), customer: { ...customer, pincode: "999999" } },
      randomUUID(),
    ),
    /PIN/,
  );
  await assert.rejects(
    store.place(
      { ...payload(), customer: { ...customer, email: "bad" } },
      randomUUID(),
    ),
    /email/,
  );
  await assert.rejects(
    store.place(
      { ...payload(), customer: { ...customer, phone: "1234567890" } },
      randomUUID(),
    ),
    /mobile/,
  );
  const closed = fixture({ enabled: false }).store;
  t.after(() => closed.close());
  await assert.rejects(
    closed.place(payload(), randomUUID()),
    /not being accepted/,
  );
});
test("gateway failures release inventory without creating a paid order", async (t) => {
  const { store } = fixture({
    gateway: {
      createOrder: async () => {
        throw Error("offline");
      },
    },
  });
  t.after(() => store.close());
  await assert.rejects(
    store.place(payload("razorpay"), randomUUID()),
    /could not be started/,
  );
  assert.equal(store.stock("banana:standard"), 20);
  assert.equal(
    store.db.prepare("SELECT status FROM orders").get().status,
    "failed",
  );
});
test("payment signatures, order IDs, amount, currency and captured state are verified", async (t) => {
  const { store, gateway, payments } = fixture();
  t.after(() => store.close());
  const order = await store.place(payload("razorpay"), randomUUID());
  const payment = {
    id: "pay_1",
    order_id: order.gatewayOrderId,
    amount: order.total,
    currency: "INR",
    status: "authorized",
  };
  payments.set(payment.id, payment);
  const signature = createHmac("sha256", gateway.secret)
    .update(`${order.gatewayOrderId}|${payment.id}`)
    .digest("hex");
  const input = {
    razorpay_order_id: order.gatewayOrderId,
    razorpay_payment_id: payment.id,
    razorpay_signature: signature,
  };
  await assert.rejects(
    store.verify(order.id, order.accessToken, {
      ...input,
      razorpay_signature: "fake",
    }),
    /signature/,
  );
  assert.equal(
    (await store.verify(order.id, order.accessToken, input)).status,
    "pending",
  );
  payment.status = "captured";
  payment.amount = 1;
  await assert.rejects(
    store.verify(order.id, order.accessToken, input),
    /match/,
  );
  payment.amount = order.total;
  payment.currency = "USD";
  await assert.rejects(
    store.verify(order.id, order.accessToken, input),
    /match/,
  );
  payment.currency = "INR";
  assert.equal(
    (await store.verify(order.id, order.accessToken, input)).status,
    "paid",
  );
  assert.equal(
    (await store.verify(order.id, order.accessToken, input)).status,
    "paid",
  );
  assert.equal(store.stock("banana:standard"), 18);
});
test("signed webhooks reconcile abandoned checkout, reject tampering, and are idempotent", async (t) => {
  const { store, gateway } = fixture();
  t.after(() => store.close());
  const order = await store.place(payload("razorpay"), randomUUID());
  const payment = {
    id: "pay_webhook",
    order_id: order.gatewayOrderId,
    amount: order.total,
    currency: "INR",
    status: "captured",
  };
  const raw = Buffer.from(
    JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: payment } },
    }),
  );
  const signature = createHmac("sha256", gateway.webhookSecret)
    .update(raw)
    .digest("hex");
  assert.throws(() => store.webhook(raw, "fake"));
  store.webhook(raw, signature);
  store.webhook(raw, signature);
  assert.equal(
    (await store.getOrder(order.id, order.accessToken)).status,
    "paid",
  );
  assert.equal(store.stock("banana:standard"), 18);
  const refund = Buffer.from(
    JSON.stringify({
      event: "refund.processed",
      payload: {
        refund: { entity: { payment_id: payment.id, amount: order.total } },
      },
    }),
  );
  const refundSig = createHmac("sha256", gateway.webhookSecret)
    .update(refund)
    .digest("hex");
  store.webhook(refund, refundSig);
  store.webhook(refund, refundSig);
  assert.equal(
    (await store.getOrder(order.id, order.accessToken)).status,
    "refunded",
  );
  assert.equal(store.stock("banana:standard"), 20);
});
test("expired reservations release stock; late capture enters review when stock is gone", async (t) => {
  const { store, advance } = fixture();
  t.after(() => store.close());
  const order = await store.place(payload("razorpay"), randomUUID());
  advance(1200001);
  store.expire();
  assert.equal(store.stock("banana:standard"), 20);
  store.db
    .prepare("UPDATE inventory SET stock=0 WHERE sku='banana:standard'")
    .run();
  const result = store.settle({
    id: "pay_late",
    order_id: order.gatewayOrderId,
    amount: order.total,
    currency: "INR",
    status: "captured",
  });
  assert.equal(result.status, "paid_review");
  assert.equal(store.stock("banana:standard"), 0);
});
test("unconfirmed COD requests expire and cannot silently reserve forever", async (t) => {
  const { store, advance } = fixture();
  t.after(() => store.close());
  const order = await store.place(payload(), randomUUID());
  advance(86400001);
  store.expire();
  assert.equal(
    (await store.getOrder(order.id, order.accessToken)).status,
    "expired",
  );
  assert.equal(store.stock("banana:standard"), 20);
});
test("order references and inventory survive a database restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "blunder-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const options = {
    catalog,
    config: { ...base, shipping: { ...base.shipping, pincodes: ["110027"] } },
    database: join(dir, "store.sqlite"),
    secret: "persistent-secret-for-this-test-only",
    enabled: true,
  };
  let store = createCommerce(options);
  store.db.prepare("UPDATE inventory SET stock=20").run();
  const order = await store.place(payload(), randomUUID());
  store.close();
  store = createCommerce(options);
  t.after(() => store.close());
  assert.equal(
    (await store.getOrder(order.id, order.accessToken)).status,
    "cod_pending",
  );
  assert.equal(store.stock("banana:standard"), 18);
});
test("production cannot open with missing seller identity, delivery configuration and secrets", () => {
  assert.throws(
    () => loadSettings({ STORE_ENABLED: "true", NODE_ENV: "production" }),
    /Store cannot open/,
  );
  assert.equal(loadSettings({ STORE_ENABLED: "false" }).enabled, false);
});
