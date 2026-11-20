import { createServer } from "node:http";
import { isIP } from "node:net";
import { readFileSync, statSync } from "node:fs";
import { resolve, extname, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createCommerce, StoreError } from "./commerce.mjs";
import { razorpayGateway } from "./gateway.mjs";
import { createGeocoder } from "./geocoder.mjs";
import {
  createSellerNotifier,
  notificationSettings,
} from "./notifications.mjs";
import { createNotificationWorker } from "./notification-outbox.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function loadSettings(env = process.env) {
  const config = JSON.parse(readFileSync(resolve(root, "data/store.json")));
  const catalog = JSON.parse(readFileSync(resolve(root, "data/catalog.json")));
  const enabled = env.STORE_ENABLED === "true";
  const notificationConfig = notificationSettings(env, config);
  if (enabled) {
    const missing = [];
    if (!notificationConfig.channels.length)
      missing.push("at least one seller notification channel");
    if (!config.catalogApproved) missing.push("approved product catalog");
    if (!config.legalName || !config.businessAddress)
      missing.push("seller identity/address");
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.supportEmail) ||
      /\.(example|invalid|test)$/.test(config.supportEmail)
    )
      missing.push("real support email");
    if (
      !config.shipping.pincodes.length ||
      config.shipping.pincodes.some((code) => !/^[1-9]\d{5}$/.test(code))
    )
      missing.push("valid delivery PIN codes");
    if (!env.ORDER_ACCESS_SECRET || env.ORDER_ACCESS_SECRET.length < 32)
      missing.push("ORDER_ACCESS_SECRET (32+ characters)");
    if (
      !Object.values(config.policies).every(
        (text) => typeof text === "string" && text.length >= 40,
      )
    )
      missing.push("published customer policies");
    if (
      env.NODE_ENV === "production" &&
      !/^https:\/\//.test(env.PUBLIC_ORIGIN || "")
    )
      missing.push("HTTPS PUBLIC_ORIGIN");
    if (!config.codEnabled && !razorpayGateway(env))
      missing.push("at least one configured payment method");
    if (missing.length)
      throw new Error(`Store cannot open: configure ${missing.join(", ")}.`);
  }
  return { config, catalog, enabled };
}
export function createApp({
  env = process.env,
  settings = loadSettings(env),
  gateway = razorpayGateway(env),
  commerce,
  notifier = createSellerNotifier(env, settings.config),
  geocoder = createGeocoder({
    baseURL: env.GEOCODER_URL,
    origin: env.PUBLIC_ORIGIN,
  }),
} = {}) {
  const { config, catalog, enabled } = settings;
  const store =
    commerce ||
    createCommerce({
      catalog,
      config,
      database: env.DATABASE_PATH || resolve(root, "var/store.sqlite"),
      secret: env.ORDER_ACCESS_SECRET,
      enabled,
      gateway,
      notificationChannels: notifier.channels,
    });
  const notificationWorker = createNotificationWorker({
    outbox: store.notifications,
    notifier,
    onError: (error) =>
      console.error("Seller notification worker:", error.name),
  });
  notificationWorker.start();
  const publicOrigin =
    env.PUBLIC_ORIGIN || `http://localhost:${env.PORT || 3000}`;
  const origins = new Set(
    [publicOrigin, env.STOREFRONT_ORIGIN].filter(Boolean),
  );
  if (env.NODE_ENV !== "production") {
    origins.add(`http://127.0.0.1:${env.PORT || 3000}`);
    origins.add("http://localhost:3000");
  }
  const limits = new Map();
  function rateLimit(req, type) {
    const hops = Math.max(0, Math.min(3, Number(env.TRUST_PROXY_HOPS) || 0));
    const forwarded = String(req.headers["x-forwarded-for"] || "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => isIP(value));
    const chain = [...forwarded, req.socket.remoteAddress];
    const client = chain[Math.max(0, chain.length - 1 - hops)];
    const key = `${client}:${type}`;
    const period = type === "order" ? 3600000 : 60000;
    const max = type === "order" ? 12 : 120;
    let bucket = limits.get(key);
    if (!bucket || bucket.until < Date.now()) {
      bucket = { count: 0, until: Date.now() + period };
      limits.set(key, bucket);
    }
    if (++bucket.count > max)
      throw new StoreError(
        "Too many attempts. Please try again in a little while.",
        429,
      );
    if (limits.size > 10000)
      for (const [id, value] of limits)
        if (value.until < Date.now()) limits.delete(id);
  }
  async function body(req, raw = false) {
    if (!raw && !req.headers["content-type"]?.startsWith("application/json"))
      throw new StoreError("Use application/json.", 415);
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) throw new StoreError("Request is too large.", 413);
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    if (raw) return data;
    try {
      return JSON.parse(data.toString());
    } catch {
      throw new StoreError("Invalid JSON.");
    }
  }
  const send = (res, status, data) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  const handler = async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(self)",
    );
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' https://checkout.razorpay.com https://www.gstatic.com https://apis.google.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.razorpay.com https://tile.openstreetmap.org; connect-src 'self' https://*.razorpay.com https://nominatim.openstreetmap.org https://ais-pre-wdyrf6yb4psuwizvqpn4hw-374223411049.asia-northeast1.run.app https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firestore.googleapis.com https://firebaseinstallations.googleapis.com https://gen-lang-client-0580718541.firebaseapp.com; frame-src https://*.razorpay.com https://gen-lang-client-0580718541.firebaseapp.com https://maps.google.com https://www.google.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    );
    if (env.NODE_ENV === "production")
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (path.startsWith("/api/")) {
        if (req.headers.origin) {
          if (!origins.has(req.headers.origin))
            throw new StoreError(
              "This website is not allowed to access the store.",
              403,
            );
          res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
          res.setHeader("Vary", "Origin");
          res.setHeader(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization, Idempotency-Key",
          );
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        }
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          return res.end();
        }
        if (path === "/api/webhooks/razorpay" && req.method === "POST")
          return send(
            res,
            200,
            store.webhook(
              await body(req, true),
              req.headers["x-razorpay-signature"],
            ),
          );
        rateLimit(req, "api");
        const mapRoute = path.match(/^\/api\/maps\/(search|reverse)$/);
        if (mapRoute && req.method === "POST")
          return send(
            res,
            200,
            await geocoder.lookup(mapRoute[1], await body(req)),
          );
        if (path === "/api/store" && req.method === "GET")
          return send(res, 200, {
            name: config.name,
            mapsAvailable: true,
            sellerNotificationsEnabled: notifier.channels.length > 0,
            supportPhone: config.supportPhone,
            legalName: config.legalName,
            businessAddress: config.businessAddress,
            supportEmail: config.supportEmail,
            checkoutEnabled: enabled,
            paymentMethods: enabled
              ? [config.codEnabled && "cod", gateway && "razorpay"].filter(
                  Boolean,
                )
              : [],
            paymentMode: gateway?.keyId.startsWith("rzp_test_")
              ? "test"
              : "live",
            paymentKeyId: enabled ? gateway?.keyId || null : null,
            shipping: config.shipping,
            policies: config.policies,
            products: store.catalog(),
          });
        if (path === "/api/quote" && req.method === "POST")
          return send(res, 200, store.quote(await body(req)));
        if (path === "/api/orders" && req.method === "POST") {
          rateLimit(req, "order");
          const order = await store.place(
            await body(req),
            req.headers["idempotency-key"],
          );
          notificationWorker
            .run()
            .catch((error) =>
              console.error("Seller notification worker:", error.name),
            );
          return send(res, 201, order);
        }
        const match = path.match(
          /^\/api\/orders\/(BL-[A-F0-9]{14})(?:\/(verify|cancel))?$/,
        );
        if (match) {
          const token = req.headers.authorization?.replace(/^Bearer /, "");
          if (req.method === "GET" && !match[2])
            return send(res, 200, await store.getOrder(match[1], token));
          if (req.method === "POST" && match[2] === "verify")
            return send(
              res,
              200,
              await store.verify(match[1], token, await body(req)),
            );
          if (req.method === "POST" && match[2] === "cancel")
            return send(res, 200, store.cancel(match[1], token));
        }
        throw new StoreError("Not found.", 404);
      }
      if (path === "/healthz") return send(res, 200, { ok: true });
      if (!["GET", "HEAD"].includes(req.method))
        throw new StoreError("Method not allowed.", 405);
      const decoded = decodeURIComponent(path);
      const relative =
        decoded === "/" ? "index.html" : decoded.replace(/^\//, "");
      const allowed = [
        "index.html",
        "style.css",
        "script.js",
        "store-config.js",
        "location.js",
        "location.css",
        "ai-config.js",
        "ai-assistant.js",
        "ai-assistant.css",
        "data/catalog.json",
      ];
      if (!allowed.includes(relative) && !relative.startsWith("assets/"))
        throw new StoreError("Not found.", 404);
      const file = resolve(root, relative);
      if (
        !file.startsWith(root + sep) ||
        !statSync(file, { throwIfNoEntry: false })?.isFile()
      )
        throw new StoreError("Not found.", 404);
      const mime = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
        ".txt": "text/plain",
        ".md": "text/plain",
      };
      const data = readFileSync(file);
      res.writeHead(200, {
        "Content-Type": `${mime[extname(file)] || "application/octet-stream"}`,
        "Content-Length": data.length,
        "Cache-Control": relative.startsWith("assets/")
          ? "public, max-age=86400"
          : "no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch (error) {
      if (!(error instanceof StoreError))
        console.error("Store request failed:", error.name);
      if (!res.headersSent)
        send(res, error.status || 500, {
          error:
            error instanceof StoreError
              ? error.message
              : "Something went wrong. Please try again.",
          code: error instanceof StoreError ? error.code : undefined,
        });
      else res.end();
    }
  };
  const timer = setInterval(() => store.expire(), 60000);
  timer.unref();
  return {
    handler,
    store,
    notificationWorker,
    close: async () => {
      clearInterval(timer);
      await notificationWorker.close();
      store.close();
    },
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = createApp();
  const server = createServer(app.handler);
  server.listen(Number(process.env.PORT || 3000), "0.0.0.0", () =>
    console.log(`Blunder listening on port ${process.env.PORT || 3000}`),
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () =>
      server.close(async () => {
        await app.close();
        process.exit(0);
      }),
    );
}
