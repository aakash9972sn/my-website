import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommerce } from "../server/commerce.mjs";
import {
  createSellerNotifier,
  notificationSettings,
  sellerMessage,
} from "../server/notifications.mjs";
import { createNotificationWorker } from "../server/notification-outbox.mjs";
const base = JSON.parse(
  readFileSync(new URL("../data/store.json", import.meta.url)),
);
const catalog = JSON.parse(
  readFileSync(new URL("../data/catalog.json", import.meta.url)),
);
const buyer = {
  name: "Customer & Family",
  email: "buyer@example.test",
  phone: "9876543210",
  address: "12 Example Road",
  city: "New Delhi",
  state: "Delhi",
  pincode: "110027",
  location: { latitude: 28.6439, longitude: 77.119 },
};
const input = {
  method: "cod",
  customer: buyer,
  items: [
    { productId: "banana", variantId: "standard", quantity: 2 },
    { productId: "tomato", variantId: "standard", quantity: 3 },
  ],
  sellerEmail: "attacker@example.test",
  to: "1234567890",
};
const env = {
  SELLER_NOTIFICATION_CHANNELS: "email,sms,whatsapp",
  SMTP_HOST: "smtp.example.test",
  SMTP_PORT: "465",
  SMTP_USER: "merchant@example.test",
  SMTP_PASS: "test-only-secret",
  SMTP_FROM: "merchant@example.test",
  TWILIO_ACCOUNT_SID: "AC" + "a".repeat(32),
  TWILIO_AUTH_TOKEN: "test-token",
  TWILIO_SMS_FROM: "+15005550006",
  TWILIO_WHATSAPP_FROM: "+15005550007",
  TWILIO_WHATSAPP_CONTENT_SID: "HX" + "b".repeat(32),
};
function fixture(extra = {}) {
  return createCommerce({
    catalog,
    config: { ...base, shipping: { ...base.shipping, pincodes: ["110027"] } },
    enabled: true,
    notificationChannels: ["email", "sms", "whatsapp"],
    ...extra,
  });
}
const jobs = (store) =>
  store.db.prepare("SELECT * FROM seller_notifications ORDER BY id").all();

test("confirmed COD checkout durably queues complete seller alerts, never to customer-controlled recipients", async (t) => {
  const store = fixture();
  t.after(() => store.close());
  store.db.prepare("UPDATE inventory SET stock=20").run();
  const sent = [],
    http = [];
  const notifier = createSellerNotifier(env, base, {
    transportFactory: () => ({
      sendMail: async (msg) => {
        sent.push(msg);
        return {
          accepted: [base.sellerNotifications.email],
          messageId: "mail-1",
        };
      },
      close() {},
    }),
    fetchImpl: async (url, options) => {
      http.push({ url, body: new URLSearchParams(options.body) });
      return new Response(
        JSON.stringify({ sid: "SM-test", status: "queued" }),
        { status: 201 },
      );
    },
  });
  const key = randomUUID();
  const order = await store.place(input, key);
  assert.equal(jobs(store).length, 3);
  assert.ok(jobs(store).every((j) => j.status === "queued"));
  assert.ok(jobs(store).every((j) => !j.payload.includes(order.accessToken)));
  await store.place(input, key);
  assert.equal(jobs(store).length, 3);
  const worker = createNotificationWorker({
    outbox: store.notifications,
    notifier,
  });
  await Promise.all([worker.run(), worker.run()]);
  await worker.close();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "sdhanpal778@gmail.com");
  assert.equal(sent[0].replyTo, buyer.email);
  for (const field of [
    "Banana",
    "Fresh Tomatoes",
    "Qty 2",
    "Qty 3",
    "₹54.00",
    buyer.name,
    buyer.phone,
    buyer.email,
    buyer.address,
    "28.643900,77.119000",
  ])
    assert.ok(sent[0].text.includes(field), field);
  assert.ok(sent[0].html.includes("Customer &amp; Family"));
  assert.equal(http.length, 2);
  assert.equal(http[0].body.get("To"), "+919910113972");
  assert.equal(http[1].body.get("To"), "whatsapp:+919910113972");
  assert.equal(http[1].body.get("ContentSid"), env.TWILIO_WHATSAPP_CONTENT_SID);
  assert.ok(
    JSON.parse(http[1].body.get("ContentVariables"))["3"].includes(
      "Fresh Tomatoes",
    ),
  );
  assert.ok(jobs(store).every((j) => j.status === "accepted"));
});

test("unpaid or failed online checkout sends no purchase alert; verified duplicate captures send one per channel", async (t) => {
  const gateway = {
    keyId: "rzp_test_notifications",
    secret: "test",
    webhookSecret: "hook-test",
    createOrder: async (body) => ({ ...body, id: "order_1" }),
  };
  const store = fixture({ gateway });
  t.after(() => store.close());
  store.db.prepare("UPDATE inventory SET stock=20").run();
  const order = await store.place(
    { ...input, method: "razorpay" },
    randomUUID(),
  );
  assert.equal(jobs(store).length, 0);
  const payment = {
    id: "pay_test",
    order_id: order.gatewayOrderId,
    amount: order.total,
    currency: "INR",
    status: "captured",
  };
  assert.throws(() => store.settle({ ...payment, amount: 1 }));
  assert.equal(jobs(store).length, 0);
  store.settle(payment);
  store.settle(payment);
  const raw = Buffer.from(
    JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: payment } },
    }),
  );
  store.webhook(
    raw,
    createHmac("sha256", gateway.webhookSecret).update(raw).digest("hex"),
  );
  assert.equal(jobs(store).length, 3);
  assert.ok(jobs(store).every((j) => JSON.parse(j.payload).status === "paid"));
  const failed = fixture({
    gateway: {
      createOrder: async () => {
        throw new Error("failure");
      },
    },
  });
  t.after(() => failed.close());
  failed.db.prepare("UPDATE inventory SET stock=20").run();
  await assert.rejects(
    failed.place({ ...input, method: "razorpay" }, randomUUID()),
  );
  assert.equal(jobs(failed).length, 0);
});

test("notification queue survives restart and transient retry does not lose the saved order", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "blunder-alerts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, "store.sqlite");
  let now = 1800000000000;
  let store = fixture({ database, now: () => now });
  store.db.prepare("UPDATE inventory SET stock=20").run();
  const order = await store.place(input, randomUUID());
  store.close();
  store = fixture({ database, now: () => now });
  t.after(() => store.close());
  let fail = true;
  const notifier = {
    channels: ["email", "sms", "whatsapp"],
    send: async (job) => {
      if (fail && job.channel === "email")
        throw Object.assign(new Error("Temporary"), {
          code: "SMTP_TEMPORARY",
          retryable: true,
        });
      return "accepted";
    },
  };
  const worker = createNotificationWorker({
    outbox: store.notifications,
    notifier,
  });
  await worker.run();
  assert.equal(jobs(store)[0].status, "retry");
  assert.equal(
    store.db
      .prepare("SELECT count(*) AS n FROM orders WHERE id=?")
      .get(order.id).n,
    1,
  );
  fail = false;
  now += 31000;
  await worker.run();
  assert.equal(jobs(store)[0].status, "accepted");
  assert.equal(jobs(store)[0].attempts, 2);
  await worker.close();
});

test("cancelled orders supersede queued packing alerts and issue a do-not-dispatch update", async (t) => {
  const store = fixture();
  t.after(() => store.close());
  store.db.prepare("UPDATE inventory SET stock=20").run();
  const order = await store.place(input, randomUUID());
  store.cancel(order.id, order.accessToken);
  const records = jobs(store);
  assert.equal(records.length, 6);
  assert.ok(records.slice(0, 3).every((j) => j.status === "superseded"));
  const delivered = [];
  const worker = createNotificationWorker({
    outbox: store.notifications,
    notifier: {
      channels: ["email", "sms", "whatsapp"],
      send: async (job) => {
        delivered.push(sellerMessage(job.order, job.event).text);
        return "accepted";
      },
    },
  });
  await worker.run();
  await worker.close();
  assert.equal(delivered.length, 3);
  assert.ok(
    delivered.every((text) => text.includes("CANCELLED — do not dispatch")),
  );
});

test("ambiguous delivery and interrupted sends require review instead of automatic duplicates", async (t) => {
  let now = 1800000000000;
  const store = fixture({ notificationChannels: ["email"], now: () => now });
  t.after(() => store.close());
  store.db.prepare("UPDATE inventory SET stock=20").run();
  await store.place(input, randomUUID());
  const job = store.notifications.claim();
  now += 130000;
  assert.equal(store.notifications.claim(), null);
  assert.equal(jobs(store)[0].status, "review");
  store.db.prepare("UPDATE seller_notifications SET status='queued'").run();
  const worker = createNotificationWorker({
    outbox: store.notifications,
    notifier: {
      channels: ["email"],
      send: async () => {
        throw Object.assign(new Error("unknown"), {
          code: "SMTP_TIMEOUT",
          uncertain: true,
          retryable: true,
        });
      },
    },
  });
  await worker.run();
  await worker.close();
  assert.equal(jobs(store)[0].status, "review");
  assert.equal(job.attempts, 1);
});

test("provider settings fail closed and SMTP/Twilio failures do not falsely record delivery", async () => {
  assert.throws(
    () => notificationSettings({ ...env, SMTP_PASS: "" }, base),
    /SMTP_PASS/,
  );
  assert.throws(
    () =>
      notificationSettings({ ...env, TWILIO_WHATSAPP_CONTENT_SID: "" }, base),
    /CONTENT_SID/,
  );
  assert.throws(
    () => notificationSettings({ ...env, SMTP_PORT: "25" }, base),
    /SMTP_PORT/,
  );
  const order = {
    id: "BL-TEST",
    items: [{ name: "Test", pack: "1 piece", price: 500, quantity: 1 }],
    customer: buyer,
    subtotal: 500,
    discount: 0,
    shipping: 2000,
    total: 2500,
    method: "cod",
    status: "cod_pending",
    createdAt: Date.now(),
  };
  const notifier = createSellerNotifier(env, base, {
    transportFactory: () => ({
      sendMail: async () => {
        throw Object.assign(new Error("auth details must not leak"), {
          code: "EAUTH",
          responseCode: 535,
        });
      },
      close() {},
    }),
    fetchImpl: async () => new Response("{}", { status: 429 }),
  });
  await assert.rejects(
    notifier.send({ order, event: "order.received", channel: "email" }),
    (e) =>
      e.code === "SMTP_EAUTH" &&
      !e.retryable &&
      !e.message.includes("auth details"),
  );
  await assert.rejects(
    notifier.send({ order, event: "order.received", channel: "sms" }),
    (e) => e.code === "TWILIO_HTTP_429" && e.retryable,
  );
});

test("abandoned unpaid online orders do not send seller expiry alerts", async (t) => {
  let now = 1800000000000;
  const store = fixture({
    now: () => now,
    gateway: { createOrder: async (body) => ({ ...body, id: "order_unpaid" }) },
  });
  t.after(() => store.close());
  store.db.prepare("UPDATE inventory SET stock=20").run();
  await store.place({ ...input, method: "razorpay" }, randomUUID());
  now += 1300000;
  store.expire();
  assert.equal(jobs(store).length, 0);
});
