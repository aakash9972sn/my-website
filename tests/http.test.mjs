import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createApp, loadSettings } from "../server/index.mjs";
import { createCommerce } from "../server/commerce.mjs";
test("HTTP boundary protects files, origins, order access and closed checkout", async (t) => {
  const settings = loadSettings({ STORE_ENABLED: "false" });
  const commerce = createCommerce({
    ...settings,
    config: settings.config,
    catalog: settings.catalog,
  });
  const app = createApp({
    settings,
    commerce,
    env: { PUBLIC_ORIGIN: "https://shop.example.test", NODE_ENV: "production" },
  });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    app.close();
  });
  const root = `http://127.0.0.1:${server.address().port}`;
  for (const path of [
    "/.env",
    "/.git/config",
    "/server/commerce.mjs",
    "/data/store.json",
    "/var/store.sqlite",
    "/assets/../.env",
  ])
    assert.equal((await fetch(root + path)).status, 404, path);
  const page = await fetch(root + "/");
  assert.equal(page.status, 200);
  assert.ok(
    page.headers
      .get("content-security-policy")
      .includes("frame-ancestors 'none'"),
  );
  const config = await (await fetch(root + "/api/store")).json();
  assert.equal(config.checkoutEnabled, false);
  assert.equal(config.products.length, 12);
  assert.equal(config.paymentKeyId, null);
  assert.equal(
    (
      await fetch(root + "/api/store", {
        headers: { Origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  const allowed = await fetch(root + "/api/store", {
    headers: { Origin: "https://shop.example.test" },
  });
  assert.equal(
    allowed.headers.get("access-control-allow-origin"),
    "https://shop.example.test",
  );
  assert.equal(
    (
      await fetch(root + "/api/orders", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "{}",
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await fetch(root + "/api/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "123456789012345678901234",
        },
        body: "{}",
      })
    ).status,
    503,
  );
  assert.equal(
    (await fetch(root + "/api/orders/BL-0123456789ABCD")).status,
    404,
  );
});
