import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createCommerce, validateCustomer } from "../server/commerce.mjs";
import { createApp, loadSettings } from "../server/index.mjs";
import { createGeocoder } from "../server/geocoder.mjs";
const customer = {
  name: "Map Test Buyer",
  email: "buyer@example.test",
  phone: "9876543210",
  address: "12 Example Street, Test Building",
  city: "New Delhi",
  state: "Delhi",
  pincode: "110027",
};
const place = {
  lat: "28.643900",
  lon: "77.119000",
  display_name: "Example Road, New Delhi, Delhi, India",
  address: {
    road: "Example Road",
    city: "New Delhi",
    state: "Delhi",
    postcode: "110027",
    country_code: "in",
  },
};

test("delivery coordinates are optional, bounded, numeric and normalised", () => {
  assert.equal(validateCustomer(customer).location, undefined);
  assert.deepEqual(
    validateCustomer({
      ...customer,
      location: {
        latitude: 28.6439123456,
        longitude: 77.1190123456,
        untrusted: "ignored",
      },
    }).location,
    { latitude: 28.643912, longitude: 77.119012 },
  );
  for (const location of [
    { latitude: "28.6", longitude: 77.1 },
    { latitude: 91, longitude: 0 },
    { latitude: 0, longitude: -181 },
    { latitude: NaN, longitude: 0 },
    { latitude: 0, longitude: Infinity },
    [],
    {},
    "point",
  ])
    assert.throws(
      () => validateCustomer({ ...customer, location }),
      /valid delivery map point/,
    );
});

test("private COD orders retain delivery pins without bypassing PIN-code checks", async (t) => {
  const catalog = JSON.parse(
    readFileSync(new URL("../data/catalog.json", import.meta.url)),
  );
  const config = JSON.parse(
    readFileSync(new URL("../data/store.json", import.meta.url)),
  );
  config.shipping.pincodes = ["110027"];
  const store = createCommerce({
    catalog,
    config,
    enabled: true,
    secret: "map-order-test-secret-only-not-for-production",
  });
  t.after(() => store.close());
  store.db.prepare("UPDATE inventory SET stock=10").run();
  const payload = {
    items: [{ productId: "banana", variantId: "standard", quantity: 1 }],
    method: "cod",
    customer: {
      ...customer,
      location: { latitude: 28.6439, longitude: 77.119 },
    },
  };
  const order = await store.place(payload, randomUUID());
  assert.deepEqual(
    (await store.getOrder(order.id, order.accessToken)).customer.location,
    payload.customer.location,
  );
  await assert.rejects(
    store.getOrder(order.id, "invalid-private-code"),
    /not found/,
  );
  await assert.rejects(
    store.place(
      { ...payload, customer: { ...payload.customer, pincode: "999999" } },
      randomUUID(),
    ),
    /PIN code/,
  );
});

test("geocoder validates requests, constrains the provider, caches and shares concurrent lookups", async () => {
  const calls = [];
  const geocoder = createGeocoder({
    interval: 0,
    origin: "https://store.example.test",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify([place]));
    },
  });
  const [a, b] = await Promise.all([
    geocoder.lookup("search", { query: "New Delhi" }),
    geocoder.lookup("search", { query: "New Delhi" }),
  ]);
  assert.deepEqual(a, b);
  await geocoder.lookup("search", { query: "New Delhi" });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.hostname, "nominatim.openstreetmap.org");
  assert.equal(url.searchParams.get("countrycodes"), "in");
  assert.equal(url.searchParams.get("limit"), "5");
  assert.match(calls[0].options.headers["User-Agent"], /BlunderStore\/2.1/);
  assert.throws(() => geocoder.lookup("search", { query: "ab" }));
  assert.throws(() =>
    geocoder.lookup("reverse", { latitude: 100, longitude: 77 }),
  );
  assert.throws(() => geocoder.lookup("https://evil.example/", {}));
});

test("geocoder spaces provider calls and handles missing or failed lookups", async () => {
  const starts = [];
  const geocoder = createGeocoder({
    interval: 50,
    fetchImpl: async () => {
      starts.push(Date.now());
      return new Response(JSON.stringify(place));
    },
  });
  await Promise.all([
    geocoder.lookup("reverse", { latitude: 28, longitude: 77 }),
    geocoder.lookup("reverse", { latitude: 29, longitude: 77 }),
  ]);
  assert.ok(starts[1] - starts[0] >= 45);
  const failed = createGeocoder({
    interval: 0,
    fetchImpl: async () => new Response("Unavailable", { status: 429 }),
  });
  await assert.rejects(
    failed.lookup("search", { query: "New Delhi" }),
    (error) => error.status === 429,
  );
  const missing = createGeocoder({
    interval: 0,
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: "No location" })),
  });
  assert.equal(
    await missing.lookup("reverse", { latitude: 0, longitude: 0 }),
    null,
  );
});

test("map HTTP endpoints and browser permissions allow location without weakening private order access", async (t) => {
  const settings = loadSettings({ STORE_ENABLED: "false" });
  const commerce = createCommerce(settings);
  const geocoder = {
    lookup: async (kind, input) => {
      assert.equal(kind, "search");
      assert.equal(input.query, "New Delhi");
      return [place];
    },
  };
  const app = createApp({
    settings,
    commerce,
    geocoder,
    env: {
      PUBLIC_ORIGIN: "https://store.example.test",
      NODE_ENV: "production",
    },
  });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    app.close();
  });
  const root = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(root + "/");
  assert.match(
    response.headers.get("permissions-policy"),
    /geolocation=\(self\)/,
  );
  assert.match(response.headers.get("permissions-policy"), /camera=\(\)/);
  assert.match(
    response.headers.get("content-security-policy"),
    /frame-src[^;]*https:\/\/maps.google.com/,
  );
  for (const path of [
    "/location.js",
    "/location.css",
    "/assets/vendor/leaflet/leaflet.js",
  ])
    assert.equal((await fetch(root + path)).status, 200);
  const result = await fetch(root + "/api/maps/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "New Delhi" }),
  });
  assert.deepEqual(await result.json(), [place]);
  assert.equal(
    (
      await fetch(root + "/api/maps/search", {
        method: "POST",
        headers: {
          Origin: "https://evil.example",
          "Content-Type": "application/json",
        },
        body: '{"query":"New Delhi"}',
      })
    ).status,
    403,
  );
});
