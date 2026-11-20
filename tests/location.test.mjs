import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { runInNewContext } from "node:vm";
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


/* Run the original vanilla browser module against a controlled DOM fixture.
   This tests field behavior, not just the existence of code strings. */
function locationFixture(onRequest) {
  const nodes = new Map();
  function node() {
    const listeners = new Map();
    const attrs = new Map();
    return {
      listeners, children: [], dataset: {}, value: "", textContent: "",
      hidden: false, disabled: false, open: true,
      addEventListener(type, callback) { listeners.set(type, callback); },
      append(...elements) { this.children.push(...elements); },
      replaceChildren(...elements) { this.children = elements; },
      getAttribute(name) { return attrs.get(name) ?? null; },
      setAttribute(name, value) { attrs.set(name, String(value)); },
      reportValidity() { return true; },
      focus() {},
    };
  }
  const $ = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, node());
    return nodes.get(selector);
  };
  const storage = new Map();
  const window = { BLUNDER_MAPS: {}, isSecureContext: true };
  const ctx = {
    window, document: { querySelector: $, querySelectorAll: () => [], createElement: node },
    sessionStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    AbortController, AbortSignal, DOMException, URL, Promise, Date,
    setTimeout, clearTimeout, encodeURIComponent,
    navigator: { geolocation: {
      getCurrentPosition(success) {
        success({coords: {latitude: 28.743, longitude: 77.109}});
      }
    } },
    console
  };
  runInNewContext(readFileSync(new URL("../location.js", import.meta.url), "utf8"), ctx);
  let selected = null;
  window.BlunderLocation.configure({
    readPin: () => "",
    checkAvailability: pincode => ({valid:true,available:true,text:"Check complete: "+pincode}),
    onSelect: value => { selected = value; },
    request: onRequest
  });
  window.BlunderLocation.open();
  return { $, window, getSelected: () => selected };
}

test("selected address preserves only user-entered flat/room prefix and avoids duplication", () => {
  const { window } = locationFixture(async () => []);
  const merge = window.BlunderLocation.mergeHouseDetails;
  assert.equal(
    merge("Room 204, Aryabhatta Hostel", "Example Road, Rohini", ""),
    "Room 204, Aryabhatta Hostel, Example Road, Rohini"
  );
  assert.equal(
    merge("Flat 12B, Example Road", "New Street", "Example Road"),
    "Flat 12B, New Street"
  );
  assert.equal(
    merge("Example Road, Rohini", "New Street", "Example Road, Rohini"),
    "New Street"
  );
  assert.equal(merge("Room 204", "", ""), "Room 204");
  assert.equal(merge("Room 204, Example Road", "Example Road", "Example Road"),
    "Room 204, Example Road");
  assert.ok(merge("Room 204", "X".repeat(220), "").length <= 220);
});

test("search selection preserves typed hostel room and fills city, state and PIN", async () => {
  const place = {
    lat: "28.743", lon: "77.109", display_name: "Rohini Sector 16",
    address: { road:"Example Road", city:"New Delhi", state:"Delhi",
      postcode:"110042", country_code:"in" }
  };
  const h = locationFixture(async kind => {
    assert.equal(kind, "search");
    return [place];
  });
  h.$("#location-address").value = "Room 204, Aryabhatta Hostel";
  h.$("#location-search").value = "Rohini Sector 16";
  await h.$("#location-search-form").listeners.get("submit")({preventDefault(){}});
  const button = h.$("#location-results").children[0].children[0];
  button.listeners.get("click")();
  assert.equal(h.$("#location-address").value,
    "Room 204, Aryabhatta Hostel, Example Road");
  assert.equal(h.$("#location-city").value, "New Delhi");
  assert.equal(h.$("#location-state").value, "Delhi");
  assert.equal(h.$("#delivery-pin").value, "110042");
  h.$("#delivery-form").listeners.get("submit")({preventDefault(){}});
  assert.equal(h.getSelected().address, "Room 204, Aryabhatta Hostel, Example Road");
  assert.equal(h.getSelected().pincode, "110042");
});

test("search 429 and GPS reverse lookup errors keep manual address and checkout enabled", async () => {
  const h = locationFixture(async () => {
    throw new Error("Address search is busy (429). Enter your address manually.");
  });
  h.$("#location-address").value = "Flat 7A, Old Market";
  h.$("#location-city").value = "New Delhi";
  h.$("#location-state").value = "Delhi";
  h.$("#delivery-pin").value = "110042";
  h.$("#location-search").value = "DTU Hostel";
  await h.$("#location-search-form").listeners.get("submit")({preventDefault(){}});
  assert.match(h.$("#location-status").textContent,/429|busy|manually/i);
  assert.equal(h.$("#location-address").value,"Flat 7A, Old Market");
  assert.equal(h.$("#location-confirm").disabled,false);
  h.$("#location-gps").listeners.get("click")();
  // Nominatim is deliberately rate-limited to one request per ~1.1s.
  // Wait for the queued failed reverse-geocode to finish, rather than
  // incorrectly testing form availability while the request is in flight.
  const deadline = Date.now() + 4000;
  while (h.$("#location-confirm").disabled && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(h.$("#location-address").value,"Flat 7A, Old Market");
  assert.equal(h.$("#delivery-pin").value,"110042");
  assert.equal(h.$("#location-confirm").disabled,false);
  h.$("#delivery-form").listeners.get("submit")({preventDefault(){}});
  assert.equal(h.getSelected().address,"Flat 7A, Old Market");
  assert.equal(h.getSelected().pincode,"110042");
});
