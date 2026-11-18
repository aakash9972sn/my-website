import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "../order-requests.js";

const { contacts, create, message, whatsappURL, emailURL } =
  globalThis.BlunderRequests;
const config = JSON.parse(
  readFileSync(new URL("../data/store.json", import.meta.url)),
);
const customer = {
  name: "Request Test Buyer",
  email: "buyer@example.test",
  phone: "9876543210",
  address: "12 Example Street\nTest Building",
  city: "New Delhi",
  state: "Delhi",
  pincode: "110027",
  location: { latitude: 28.643912345, longitude: 77.119012345 },
};
const input = {
  items: [
    {
      productId: "banana",
      variantId: "standard",
      name: "Fresh banana",
      pack: "1 piece",
      price: 500,
      quantity: 2,
    },
    {
      productId: "milk",
      variantId: "standard",
      name: "Fresh milk",
      pack: "200 ml",
      price: 1500,
      quantity: 1,
    },
  ],
  customer,
  shipping: 2000,
};

test("COD request links target the configured merchant and contain the complete reviewable request", () => {
  const draft = create(input);
  assert.equal(draft.status, "request_ready");
  assert.equal(draft.subtotal, 2500);
  assert.equal(draft.total, 4500);
  assert.equal(draft.customer.address, "12 Example Street Test Building");
  assert.deepEqual(draft.customer.location, {
    latitude: 28.643912,
    longitude: 77.119012,
  });
  const url = new URL(whatsappURL(draft, config));
  assert.equal(url.origin, "https://wa.me");
  assert.equal(url.pathname, "/919910113972");
  assert.equal(url.searchParams.get("text"), message(draft));
  for (const text of [
    draft.id,
    "Fresh banana · 1 piece × 2",
    "Fresh milk · 200 ml × 1",
    "Estimated total: ₹45",
    customer.name,
    customer.email,
    customer.phone,
    customer.pincode,
    "destination=28.643912,77.119012",
    "not a confirmed order",
  ])
    assert.ok(message(draft).includes(text), text);
  assert.equal(
    new URL(emailURL(draft, config)).pathname,
    "sdhanpal778@gmail.com",
  );
  assert.equal(
    new URL(emailURL(draft, config)).searchParams.get("body"),
    message(draft),
  );
  assert.equal(
    draft.status,
    "request_ready",
    "preparing links never marks a message sent",
  );
});

test("requests without GPS work, encode special characters and recompute client totals", () => {
  const draft = create({
    ...input,
    customer: { ...customer, name: "Buyer & Family", location: undefined },
    subtotal: 1,
    total: 1,
  });
  assert.equal(draft.total, 4500);
  assert.equal(message(draft).includes("Delivery map:"), false);
  assert.match(
    new URL(whatsappURL(draft, config)).searchParams.get("text"),
    /Buyer & Family/,
  );
  assert.equal(emailURL(draft, { orderRequests: {} }), "");
  assert.deepEqual(
    create(JSON.parse(JSON.stringify(draft))),
    draft,
    "same-tab reload preserves the request reference and totals",
  );
});

test("requests reject broken quantities, addresses, coordinates and unsafe contact links", () => {
  for (const quantity of [0, -1, 11, 1.5, "2"])
    assert.throws(() =>
      create({ ...input, items: [{ ...input.items[0], quantity }] }),
    );
  for (const location of [
    { latitude: 91, longitude: 77 },
    { latitude: 28, longitude: Infinity },
    { latitude: "28", longitude: 77 },
  ])
    assert.throws(() =>
      create({ ...input, customer: { ...customer, location } }),
    );
  for (const [field, value] of [
    ["email", "broken"],
    ["phone", "1234567890"],
    ["pincode", "000000"],
    ["address", "short"],
  ])
    assert.throws(() =>
      create({ ...input, customer: { ...customer, [field]: value } }),
    );
  assert.throws(() => create({ ...input, shipping: -1 }));
  assert.throws(() => create({ ...input, discount: 3000 }));
  assert.equal(
    contacts({
      orderRequests: {
        enabled: true,
        whatsapp: "javascript:alert(1)",
        email: "test@example.com?body=bad",
      },
    }).enabled,
    false,
  );
  assert.equal(
    contacts({ orderRequests: { email: "test@example.com?body=bad" } }).email,
    "",
  );
  assert.throws(() =>
    whatsappURL(create(input), {
      orderRequests: { enabled: false, whatsapp: "919910113972" },
    }),
  );
});
