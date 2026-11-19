import { DatabaseSync } from "node:sqlite";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createNotificationOutbox } from "./notification-outbox.mjs";

export class StoreError extends Error {
  constructor(message, status = 400, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const assert = (condition, message, status) => {
  if (!condition) throw new StoreError(message, status);
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
export function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export const sku = (product, variant) => `${product}:${variant}`;
export function validateCustomer(input) {
  const customer = {};
  for (const [field, min, max] of [
    ["name", 2, 80],
    ["email", 5, 160],
    ["phone", 10, 16],
    ["address", 8, 220],
    ["city", 2, 80],
    ["state", 2, 80],
    ["pincode", 6, 6],
  ]) {
    assert(typeof input?.[field] === "string", `Please enter your ${field}.`);
    customer[field] =
      field === "address"
        ? input[field].trim().replace(/\s+/g, " ")
        : input[field].trim();
    assert(
      customer[field].length >= min &&
        customer[field].length <= max &&
        !/[\u0000-\u001f]/.test(customer[field]),
      `Please check your ${field}.`,
    );
  }
  assert(
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email),
    "Please enter a valid email address.",
  );
  customer.phone = customer.phone
    .replace(/[^\d+]/g, "")
    .replace(/^(\+91|91)(?=[6-9]\d{9}$)/, "");
  assert(
    /^[6-9]\d{9}$/.test(customer.phone),
    "Please enter a valid 10-digit Indian mobile number.",
  );
  assert(
    /^[1-9]\d{5}$/.test(customer.pincode),
    "Please enter a valid 6-digit PIN code.",
  );
  if (input.location !== undefined && input.location !== null) {
    const location = input.location;
    assert(
      typeof location === "object" &&
        !Array.isArray(location) &&
        typeof location.latitude === "number" &&
        typeof location.longitude === "number" &&
        Number.isFinite(location.latitude) &&
        Number.isFinite(location.longitude) &&
        Math.abs(location.latitude) <= 90 &&
        Math.abs(location.longitude) <= 180,
      "Please choose a valid delivery map point.",
    );
    customer.location = {
      latitude: Number(location.latitude.toFixed(6)),
      longitude: Number(location.longitude.toFixed(6)),
    };
  }
  return customer;
}

export function createCommerce({
  catalog,
  config,
  database = ":memory:",
  secret = randomBytes(32).toString("hex"),
  enabled = false,
  gateway = null,
  now = () => Date.now(),
  notificationChannels = [],
}) {
  if (database !== ":memory:")
    mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(database);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS inventory (sku TEXT PRIMARY KEY, stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0));
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, idem TEXT UNIQUE NOT NULL, request_hash TEXT NOT NULL,
      token_hash TEXT NOT NULL, method TEXT NOT NULL, status TEXT NOT NULL,
      items TEXT NOT NULL, customer TEXT NOT NULL, totals TEXT NOT NULL,
      gateway_id TEXT UNIQUE, payment_id TEXT UNIQUE, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, reserved INTEGER NOT NULL DEFAULT 1,
      fulfillment TEXT NOT NULL DEFAULT 'unfulfilled', tracking TEXT, updated_at INTEGER NOT NULL
    );`);
  const notifications = createNotificationOutbox({
    db,
    channels: notificationChannels,
    now,
  });
  assert(
    Number.isSafeInteger(config.shipping.standard) &&
      config.shipping.standard >= 0 &&
      Number.isSafeInteger(config.shipping.freeAbove) &&
      config.shipping.freeAbove > 0,
    "Shipping prices must be valid amounts in paise.",
  );
  assert(
    Number.isSafeInteger(config.codMax) && config.codMax > 0,
    "Set a valid COD order limit.",
  );
  for (const coupon of config.coupons || [])
    assert(
      Number.isInteger(coupon.percent) &&
        coupon.percent >= 1 &&
        coupon.percent <= 95 &&
        Number.isSafeInteger(coupon.minimum || 0) &&
        (coupon.minimum || 0) >= 0 &&
        Number.isSafeInteger(coupon.maximum || 0) &&
        (coupon.maximum || 0) >= 0,
      "Invalid offer configuration.",
    );
  const products = new Map(catalog.map((p) => [p.id, p]));
  for (const p of catalog) {
    assert(
      Number.isSafeInteger(p.price) && p.price > 0,
      `Invalid catalog price: ${p.id}`,
    );
    for (const v of p.variants)
      db.prepare(
        "INSERT OR IGNORE INTO inventory(sku, stock) VALUES (?, 0)",
      ).run(sku(p.id, v.id));
  }
  const transaction = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const stock = (id) =>
    db.prepare("SELECT stock FROM inventory WHERE sku=?").get(id)?.stock || 0;
  const find = (id) => db.prepare("SELECT * FROM orders WHERE id=?").get(id);
  const tokenFor = (id, key) =>
    createHmac("sha256", secret).update(`${id}:${key}`).digest("hex");
  const publicOrder = (row) => ({
    id: row.id,
    method: row.method,
    status: row.status,
    items: JSON.parse(row.items),
    customer: JSON.parse(row.customer),
    ...JSON.parse(row.totals),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    fulfillment: row.fulfillment,
    tracking: row.tracking,
    gatewayOrderId: row.gateway_id,
  });
  function release(row) {
    if (!row.reserved) return;
    for (const item of JSON.parse(row.items))
      db.prepare("UPDATE inventory SET stock=stock+? WHERE sku=?").run(
        item.quantity,
        item.sku,
      );
    db.prepare("UPDATE orders SET reserved=0 WHERE id=?").run(row.id);
  }
  function expire() {
    transaction(() => {
      const rows = db
        .prepare(
          "SELECT * FROM orders WHERE status IN ('creating', 'pending', 'cod_pending') AND expires_at < ?",
        )
        .all(now());
      for (const row of rows) {
        release(row);
        db.prepare(
          "UPDATE orders SET status='expired', updated_at=? WHERE id=?",
        ).run(now(), row.id);
        if (row.method === "cod")
          notifications.enqueue(publicOrder(find(row.id)), "order.expired");
      }
    });
  }
  function quote(input, checkInventory = enabled) {
    assert(
      Array.isArray(input?.items) &&
        input.items.length > 0 &&
        input.items.length <= 30,
      "Your bag needs between 1 and 30 items.",
    );
    const combined = new Map();
    for (const entry of input.items) {
      const product = products.get(entry?.productId);
      assert(product, "A product in your bag is no longer available.");
      const variant = product.variants.find((v) => v.id === entry.variantId);
      assert(
        variant &&
          Number.isSafeInteger(entry.quantity) &&
          entry.quantity >= 1 &&
          entry.quantity <= 10,
        "Please check the pack and quantity in your bag.",
      );
      const key = sku(product.id, variant.id),
        previous = combined.get(key);
      const quantity = (previous?.quantity || 0) + entry.quantity;
      assert(quantity <= 10, "You can order up to 10 of each item.");
      if (checkInventory)
        assert(
          stock(key) >= quantity,
          `${product.name} does not have enough stock. Please update your bag.`,
          409,
        );
      combined.set(key, {
        sku: key,
        productId: product.id,
        variantId: variant.id,
        name: product.name,
        pack: variant.label,
        image: product.image,
        price: product.price,
        quantity,
      });
    }
    const items = [...combined.values()];
    const subtotal = items.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0,
    );
    let discount = 0;
    const couponCode =
      typeof input.coupon === "string"
        ? input.coupon.trim().toUpperCase().slice(0, 30)
        : "";
    if (couponCode) {
      const coupon = (config.coupons || []).find((c) => c.code === couponCode);
      assert(
        coupon &&
          (!coupon.expiresAt || new Date(coupon.expiresAt).getTime() > now()),
        "This offer code is not available.",
      );
      assert(
        subtotal >= (coupon.minimum || 0),
        `Your bag does not meet the minimum for ${couponCode}.`,
      );
      discount = Math.min(
        Math.floor((subtotal * coupon.percent) / 100),
        coupon.maximum || subtotal,
        subtotal,
      );
    }
    const shipping =
      subtotal - discount >= config.shipping.freeAbove
        ? 0
        : config.shipping.standard;
    return {
      items,
      subtotal,
      discount,
      shipping,
      total: subtotal - discount + shipping,
      currency: "INR",
      coupon: couponCode,
    };
  }
  function authorise(id, token) {
    const row = find(id);
    assert(
      row && typeof token === "string" && equal(row.token_hash, hash(token)),
      "Order not found. Check your reference and private access code.",
      404,
    );
    return row;
  }
  function settle(payment) {
    assert(
      payment &&
        typeof payment.order_id === "string" &&
        typeof payment.id === "string",
      "Invalid payment details.",
    );
    const existing = db
      .prepare("SELECT * FROM orders WHERE gateway_id=?")
      .get(payment.order_id);
    if (!existing) return null;
    assert(
      payment.status === "captured" &&
        payment.currency === "INR" &&
        payment.amount === JSON.parse(existing.totals).total,
      "Payment amount or currency does not match this order.",
      409,
    );
    return transaction(() => {
      const row = find(existing.id);
      if (["paid", "paid_review", "refunded"].includes(row.status)) {
        assert(
          row.payment_id === payment.id,
          "A different payment is already linked to this order.",
          409,
        );
        return publicOrder(row);
      }
      let available = !!row.reserved;
      if (!available) {
        const items = JSON.parse(row.items);
        available = items.every((item) => stock(item.sku) >= item.quantity);
        if (available)
          for (const item of items)
            db.prepare("UPDATE inventory SET stock=stock-? WHERE sku=?").run(
              item.quantity,
              item.sku,
            );
      }
      db.prepare(
        "UPDATE orders SET status=?, payment_id=?, reserved=?, updated_at=? WHERE id=?",
      ).run(
        available ? "paid" : "paid_review",
        payment.id,
        available ? 1 : 0,
        now(),
        row.id,
      );
      notifications.enqueue(
        publicOrder(find(row.id)),
        available ? "order.received" : "order.review",
      );
      return publicOrder(find(row.id));
    });
  }
  async function place(input, key) {
    assert(
      enabled,
      "The store is preparing to open. Orders are not being accepted yet.",
      503,
    );
    assert(
      typeof key === "string" && /^[a-zA-Z0-9_-]{24,100}$/.test(key),
      "Please restart checkout and try again.",
    );
    const method = input.method;
    assert(
      method === "cod" || method === "razorpay",
      "Choose a payment method.",
    );
    assert(
      method === "cod" ? config.codEnabled : !!gateway,
      "This payment method is not available.",
      503,
    );
    const customer = validateCustomer(input.customer);
    assert(
      config.shipping.pincodes.includes(customer.pincode),
      "Delivery is not available to this PIN code yet.",
      422,
    );
    const requestHash = hash(
      JSON.stringify({
        items: input.items,
        coupon: input.coupon || "",
        customer,
        method,
      }),
    );
    const previous = db
      .prepare("SELECT * FROM orders WHERE idem=?")
      .get(hash(key));
    if (previous) {
      assert(
        previous.request_hash === requestHash,
        "This checkout was already used for a different order. Please start again.",
        409,
      );
      if (previous.status === "failed")
        throw new StoreError(
          "Payment setup failed. Please start a new checkout.",
          409,
          "CHECKOUT_RESTART",
        );
      assert(
        previous.status !== "creating",
        "Your order is still being prepared. Please retry shortly.",
        409,
      );
      return {
        ...publicOrder(previous),
        accessToken: tokenFor(previous.id, key),
        keyId: gateway?.keyId || null,
      };
    }
    expire();
    const row = transaction(() => {
      const totals = quote(input, true);
      assert(
        method !== "cod" || totals.total <= config.codMax,
        "This order exceeds the Cash on Delivery limit.",
      );
      const id = `BL-${randomBytes(7).toString("hex").toUpperCase()}`;
      for (const item of totals.items)
        db.prepare("UPDATE inventory SET stock=stock-? WHERE sku=?").run(
          item.quantity,
          item.sku,
        );
      const { items, ...amounts } = totals;
      db.prepare(
        "INSERT INTO orders(id, idem, request_hash, token_hash, method, status, items, customer, totals, created_at, expires_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        hash(key),
        requestHash,
        hash(tokenFor(id, key)),
        method,
        method === "cod" ? "cod_pending" : "creating",
        JSON.stringify(items),
        JSON.stringify(customer),
        JSON.stringify(amounts),
        now(),
        now() + (method === "cod" ? 86400000 : 1200000),
        now(),
      );
      const created = find(id);
      if (method === "cod") notifications.enqueue(publicOrder(created));
      return created;
    });
    if (method === "razorpay") {
      let remote;
      try {
        remote = await gateway.createOrder({
          amount: JSON.parse(row.totals).total,
          currency: "INR",
          receipt: row.id,
        });
        assert(
          remote?.id &&
            remote.amount === JSON.parse(row.totals).total &&
            remote.currency === "INR",
          "The payment provider returned an invalid order.",
          502,
        );
      } catch {
        transaction(() => {
          release(find(row.id));
          db.prepare(
            "UPDATE orders SET status='failed', updated_at=? WHERE id=?",
          ).run(now(), row.id);
        });
        throw new StoreError(
          "Online payment could not be started. Your order was not charged. Please try again.",
          502,
          "CHECKOUT_RESTART",
        );
      }
      db.prepare(
        "UPDATE orders SET gateway_id=?, status='pending', updated_at=? WHERE id=?",
      ).run(remote.id, now(), row.id);
    }
    return {
      ...publicOrder(find(row.id)),
      accessToken: tokenFor(row.id, key),
      keyId: gateway?.keyId || null,
    };
  }
  async function getOrder(id, token) {
    let row = authorise(id, token);
    expire();
    row = find(id);
    if (
      gateway &&
      row.gateway_id &&
      ["pending", "expired"].includes(row.status)
    ) {
      try {
        const payments = await gateway.getPayments(row.gateway_id);
        const captured = payments.find((p) => p.status === "captured");
        if (captured) return settle(captured);
      } catch {
        /* A provider outage must not erase a saved order. Webhooks also reconcile payments. */
      }
    }
    return publicOrder(find(id));
  }
  async function verify(id, token, input) {
    const row = authorise(id, token);
    assert(
      row.method === "razorpay" &&
        gateway &&
        input?.razorpay_order_id === row.gateway_id &&
        typeof input.razorpay_payment_id === "string",
      "Payment does not match this order.",
    );
    const expected = createHmac("sha256", gateway.secret)
      .update(`${row.gateway_id}|${input.razorpay_payment_id}`)
      .digest("hex");
    assert(
      equal(expected, input.razorpay_signature),
      "The payment signature could not be verified.",
      400,
    );
    const payment = await gateway.getPayment(input.razorpay_payment_id);
    assert(
      payment.order_id === row.gateway_id &&
        payment.currency === "INR" &&
        payment.amount === JSON.parse(row.totals).total,
      "Payment details do not match.",
      409,
    );
    return payment.status === "captured" ? settle(payment) : publicOrder(row);
  }
  function webhook(raw, signature) {
    assert(gateway?.webhookSecret, "Webhooks are not configured.", 503);
    assert(
      equal(
        createHmac("sha256", gateway.webhookSecret).update(raw).digest("hex"),
        signature,
      ),
      "Invalid webhook signature.",
      400,
    );
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      throw new StoreError("Invalid webhook payload.");
    }
    if (["payment.captured", "order.paid"].includes(event.event))
      settle(event.payload?.payment?.entity);
    if (event.event === "refund.processed") {
      const refund = event.payload?.refund?.entity;
      const row =
        refund &&
        db
          .prepare("SELECT * FROM orders WHERE payment_id=?")
          .get(refund.payment_id);
      if (row && refund.amount === JSON.parse(row.totals).total)
        transaction(() => {
          if (row.fulfillment === "unfulfilled") release(row);
          db.prepare(
            "UPDATE orders SET status='refunded', updated_at=? WHERE id=?",
          ).run(now(), row.id);
          notifications.enqueue(publicOrder(find(row.id)), "order.refunded");
        });
    }
    return { received: true };
  }
  function cancel(id, token) {
    return transaction(() => {
      const row = authorise(id, token);
      assert(
        row.method === "cod" &&
          ["cod_pending", "cod_confirmed"].includes(row.status) &&
          row.fulfillment === "unfulfilled",
        "This order cannot be cancelled here. Please contact the store.",
        409,
      );
      release(row);
      db.prepare(
        "UPDATE orders SET status='cancelled', updated_at=? WHERE id=?",
      ).run(now(), id);
      notifications.enqueue(publicOrder(find(id)), "order.cancelled");
      return publicOrder(find(id));
    });
  }
  return {
    db,
    notifications,
    quote,
    place,
    getOrder,
    verify,
    webhook,
    cancel,
    settle,
    expire,
    stock,
    close: () => db.close(),
    catalog: () =>
      catalog.map((p) => ({
        ...p,
        variants: p.variants.map((v) => ({
          ...v,
          stock: stock(sku(p.id, v.id)),
        })),
      })),
  };
}
