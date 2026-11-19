import nodemailer from "nodemailer";
const emailPattern = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const phonePattern = /^\+[1-9]\d{7,14}$/;
const money = (value) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(value / 100);
const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function notificationSettings(env, config) {
  const channels = [
    ...new Set(
      String(env.SELLER_NOTIFICATION_CHANNELS || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (
    channels.some((channel) => !["email", "sms", "whatsapp"].includes(channel))
  )
    throw new Error("SELLER_NOTIFICATION_CHANNELS accepts email,sms,whatsapp.");
  const seller = config.sellerNotifications || {};
  const required = (value, name) => {
    if (!value) throw new Error(`Configure ${name} for seller notifications.`);
    return value;
  };
  if (channels.includes("email")) {
    required(
      emailPattern.test(seller.email || ""),
      "sellerNotifications.email",
    );
    for (const name of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"])
      required(env[name], name);
    required(
      emailPattern.test(env.SMTP_FROM),
      "SMTP_FROM (a verified email address)",
    );
    required(
      [465, 587].includes(Number(env.SMTP_PORT || 465)),
      "SMTP_PORT (465 or 587 with TLS)",
    );
  }
  if (channels.some((channel) => channel !== "email")) {
    required(
      /^AC[a-fA-F0-9]{32}$/.test(env.TWILIO_ACCOUNT_SID || ""),
      "TWILIO_ACCOUNT_SID",
    );
    required(env.TWILIO_AUTH_TOKEN, "TWILIO_AUTH_TOKEN");
  }
  for (const channel of ["sms", "whatsapp"])
    if (channels.includes(channel)) {
      required(
        phonePattern.test(seller[channel] || ""),
        `sellerNotifications.${channel} (E.164)`,
      );
      required(
        phonePattern.test(
          env[channel === "sms" ? "TWILIO_SMS_FROM" : "TWILIO_WHATSAPP_FROM"] ||
            "",
        ),
        channel === "sms" ? "TWILIO_SMS_FROM" : "TWILIO_WHATSAPP_FROM",
      );
    }
  if (channels.includes("whatsapp"))
    required(
      /^HX[a-fA-F0-9]{32}$/.test(env.TWILIO_WHATSAPP_CONTENT_SID || ""),
      "TWILIO_WHATSAPP_CONTENT_SID (approved order-alert template)",
    );
  return { channels, seller };
}
function deliveryMap(order) {
  const point = order.customer.location;
  return point
    ? `https://www.google.com/maps/dir/?api=1&destination=${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`
    : "No map pin supplied; use the address above.";
}
function action(order, event) {
  if (event === "order.cancelled")
    return "CANCELLED — do not dispatch this order.";
  if (event === "order.expired")
    return "EXPIRED — do not dispatch without reconfirming the order.";
  if (event === "order.refunded")
    return "REFUNDED — check fulfilment before taking further action.";
  if (order.status === "paid_review")
    return "PAYMENT RECEIVED — stock needs review. Do not dispatch until resolved.";
  return order.method === "cod"
    ? "NEW COD ORDER — verify delivery details, then confirm and prepare. Collect payment on delivery."
    : "PAID ORDER — payment verified. Prepare the listed items for delivery.";
}
export function sellerMessage(order, event = "order.received") {
  const buyer = order.customer,
    address = `${buyer.address}, ${buyer.city}, ${buyer.state} ${buyer.pincode}`;
  const lines = order.items.map(
    (item, index) =>
      `${index + 1}. ${item.name} | ${item.pack} | Qty ${item.quantity} | ${money(item.price)} each | ${money(item.price * item.quantity)}`,
  );
  const text = [
    `BLUNDER · SELLER ORDER ALERT`,
    `Order: ${order.id}`,
    action(order, event),
    `Placed: ${new Date(order.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST`,
    "",
    "WHAT TO DELIVER",
    ...lines,
    "",
    `Products: ${money(order.subtotal)}`,
    `Discount: ${money(order.discount)}`,
    `Delivery: ${money(order.shipping)}`,
    `Total: ${money(order.total)}`,
    `Payment: ${order.method === "cod" ? "Cash on Delivery — not collected yet" : order.status === "paid" ? "Online payment verified" : "See order status before dispatch"}`,
    "",
    "DELIVER TO",
    `Name: ${buyer.name}`,
    `Customer phone: +91${buyer.phone}`,
    `Customer email: ${buyer.email}`,
    `Address: ${address}`,
    `Map: ${deliveryMap(order)}`,
    "",
    "This is an automatic seller alert. Use the stored order record to check the latest cancellation, payment and delivery status before dispatch.",
  ].join("\n");
  const html = `<div style="font-family:Arial,sans-serif;max-width:680px;color:#213a28"><h1 style="font-size:24px">Blunder · Seller order alert</h1><p><strong>${esc(action(order, event))}</strong></p><pre style="white-space:pre-wrap;font:14px/1.7 Arial,sans-serif">${esc(text)}</pre></div>`;
  return {
    subject: `${event === "order.received" ? "New order" : "Order update"} ${order.id} · ${money(order.total)}`,
    text,
    html,
    address,
    map: deliveryMap(order),
    action: action(order, event),
  };
}
export function createSellerNotifier(
  env,
  config,
  {
    transportFactory = (options) => nodemailer.createTransport(options),
    fetchImpl = fetch,
  } = {},
) {
  const { channels, seller } = notificationSettings(env, config);
  const transport = channels.includes("email")
    ? transportFactory({
        host: env.SMTP_HOST,
        port: Number(env.SMTP_PORT || 465),
        secure: Number(env.SMTP_PORT || 465) === 465,
        requireTLS: true,
        auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000,
        tls: { minVersion: "TLSv1.2" },
        disableFileAccess: true,
        disableUrlAccess: true,
      })
    : null;
  const failure = (code, retryable = false, uncertain = false) =>
    Object.assign(new Error("Seller notification was not accepted."), {
      code,
      retryable,
      uncertain,
    });
  async function send(job) {
    if (!channels.includes(job.channel))
      throw failure("CHANNEL_NOT_CONFIGURED");
    const { order, event, channel } = job,
      message = sellerMessage(order, event);
    if (channel === "email") {
      try {
        const result = await transport.sendMail({
          from: { name: "Blunder orders", address: env.SMTP_FROM },
          to: seller.email,
          replyTo: order.customer.email,
          subject: message.subject,
          text: message.text,
          html: message.html,
          messageId: `<blunder.${order.id}.${event}@${env.SMTP_FROM.split("@")[1]}>`,
        });
        if (
          !result.accepted?.some(
            (value) =>
              String(value).toLowerCase() === seller.email.toLowerCase(),
          )
        )
          throw failure("SMTP_RECIPIENT_REJECTED");
        return result.messageId;
      } catch (error) {
        if (error.code === "SMTP_RECIPIENT_REJECTED") throw error;
        const code = `SMTP_${String(error.code || error.responseCode || "ERROR")
          .replace(/[^A-Z0-9_]/g, "")
          .slice(0, 45)}`;
        const uncertain =
          ["DATA", "DOT"].includes(error.command) && !error.responseCode;
        const retryable =
          (Number(error.responseCode) >= 400 &&
            Number(error.responseCode) < 500) ||
          ["ECONNECTION", "EDNS"].includes(error.code) ||
          (error.code === "ETIMEDOUT" && error.command === "CONN");
        throw failure(code, retryable, uncertain);
      }
    }
    const body = new URLSearchParams({
      To: channel === "whatsapp" ? `whatsapp:${seller.whatsapp}` : seller.sms,
      From:
        channel === "whatsapp"
          ? `whatsapp:${env.TWILIO_WHATSAPP_FROM}`
          : env.TWILIO_SMS_FROM,
    });
    if (channel === "whatsapp") {
      body.set("ContentSid", env.TWILIO_WHATSAPP_CONTENT_SID);
      body.set(
        "ContentVariables",
        JSON.stringify({
          1: order.id,
          2: message.action,
          3: order.items
            .map(
              (item) =>
                `${item.name} (${item.pack}) x${item.quantity} = ${money(item.price * item.quantity)}`,
            )
            .join("; "),
          4: money(order.total),
          5: order.customer.name,
          6: `+91${order.customer.phone}`,
          7: message.address,
          8: message.map,
        }),
      );
    } else {
      const compact = [
        `BLUNDER ${order.id}`,
        message.action,
        ...order.items.map(
          (item) =>
            `${item.name} (${item.pack}) x${item.quantity}: ${money(item.price * item.quantity)}`,
        ),
        `Total ${money(order.total)}; delivery ${money(order.shipping)}; discount ${money(order.discount)}`,
        `To ${order.customer.name}, +91${order.customer.phone}`,
        message.address,
        message.map,
      ].join("\n");
      // Never silently drop products or the delivery address to fit an SMS.
      if (compact.length > 1500) throw failure("SMS_TOO_LONG_USE_EMAIL");
      body.set("Body", compact);
    }
    let response;
    try {
      response = await fetchImpl(
        `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
          signal: AbortSignal.timeout(15000),
        },
      );
    } catch {
      throw failure("TWILIO_DELIVERY_UNCERTAIN", false, true);
    }
    if (!response.ok)
      throw failure(
        `TWILIO_HTTP_${response.status}`,
        response.status === 429,
        response.status >= 500,
      );
    let result;
    try {
      result = await response.json();
    } catch {
      throw failure("TWILIO_RESPONSE_UNCERTAIN", false, true);
    }
    if (!result.sid) throw failure("TWILIO_RESPONSE_UNCERTAIN", false, true);
    if (["failed", "undelivered", "canceled"].includes(result.status))
      throw failure("TWILIO_REJECTED");
    return result.sid;
  }
  return { channels, send, close: () => transport?.close() };
}
