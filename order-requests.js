"use strict";
(() => {
  const money = (amount) =>
    new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: amount % 100 ? 2 : 0,
    }).format(amount / 100);
  const normal = (value) =>
    String(value || "")
      .trim()
      .replace(/\s+/g, " ");
  const fail = (message) => {
    throw new Error(message);
  };
  function contacts(config) {
    const value = config?.orderRequests || {};
    const phone =
      typeof value.whatsapp === "string"
        ? value.whatsapp.replace(/[+\s-]/g, "")
        : "";
    const email = typeof value.email === "string" ? value.email.trim() : "";
    return {
      enabled: value.enabled === true && /^91[6-9]\d{9}$/.test(phone),
      phone: /^91[6-9]\d{9}$/.test(phone) ? phone : "",
      email: /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)
        ? email
        : "",
    };
  }
  function create({
    items,
    customer,
    shipping = 0,
    discount = 0,
    id = `BW-${crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`,
    createdAt = Date.now(),
  }) {
    if (
      !/^BW-[A-F0-9]{12}$/.test(id) ||
      !Number.isFinite(createdAt) ||
      !Array.isArray(items) ||
      !items.length ||
      items.length > 30
    )
      fail("Please refresh your basket and try again.");
    const lines = items.map((item) => {
      if (
        typeof item.productId !== "string" ||
        typeof item.variantId !== "string" ||
        typeof item.name !== "string" ||
        !Number.isSafeInteger(item.price) ||
        item.price < 1 ||
        !Number.isSafeInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > 10
      )
        fail("Please check the items and quantities in your basket.");
      return {
        productId: item.productId.slice(0, 80),
        variantId: item.variantId.slice(0, 80),
        name: normal(item.name).slice(0, 120),
        pack: normal(item.pack).slice(0, 80),
        price: item.price,
        quantity: item.quantity,
      };
    });
    const buyer = {};
    for (const [name, min, max] of [
      ["name", 2, 80],
      ["email", 5, 160],
      ["phone", 10, 10],
      ["address", 8, 220],
      ["city", 2, 80],
      ["state", 2, 80],
      ["pincode", 6, 6],
    ]) {
      buyer[name] = normal(customer?.[name]);
      if (
        buyer[name].length < min ||
        buyer[name].length > max ||
        /[\u0000-\u001f]/.test(buyer[name])
      )
        fail(`Please check your ${name}.`);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyer.email))
      fail("Please enter a valid email address.");
    if (!/^[6-9]\d{9}$/.test(buyer.phone))
      fail("Please enter a valid 10-digit mobile number.");
    if (!/^[1-9]\d{5}$/.test(buyer.pincode))
      fail("Please enter a valid 6-digit PIN code.");
    const point = customer?.location;
    if (point != null) {
      if (
        typeof point.latitude !== "number" ||
        typeof point.longitude !== "number" ||
        !Number.isFinite(point.latitude) ||
        !Number.isFinite(point.longitude) ||
        Math.abs(point.latitude) > 90 ||
        Math.abs(point.longitude) > 180
      )
        fail("Please choose a valid delivery map point.");
      buyer.location = {
        latitude: Number(point.latitude.toFixed(6)),
        longitude: Number(point.longitude.toFixed(6)),
      };
    }
    const subtotal = lines.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0,
    );
    if (
      !Number.isSafeInteger(subtotal) ||
      !Number.isSafeInteger(shipping) ||
      shipping < 0 ||
      !Number.isSafeInteger(discount) ||
      discount < 0 ||
      discount > subtotal ||
      !Number.isSafeInteger(subtotal + shipping - discount)
    )
      fail("Please refresh your basket totals.");
    return {
      id,
      createdAt,
      channel: "whatsapp",
      status: "request_ready",
      items: lines,
      customer: buyer,
      subtotal,
      shipping,
      discount,
      total: subtotal + shipping - discount,
      currency: "INR",
    };
  }
  function message(draft) {
    const order = create(draft);
    const point = order.customer.location;
    return [
      "*BLUNDER · CASH ON DELIVERY REQUEST*",
      `Request: ${order.id}`,
      "Please confirm stock, delivery availability and the final total before accepting this request.",
      "",
      ...order.items.map(
        (item, index) =>
          `${index + 1}. ${item.name} · ${item.pack} × ${item.quantity}\n   ${money(item.price)} each · ${money(item.price * item.quantity)}`,
      ),
      "",
      `Products: ${money(order.subtotal)}`,
      ...(order.discount ? [`Offer savings: −${money(order.discount)}`] : []),
      `Estimated delivery: ${order.shipping ? money(order.shipping) : "Free"}`,
      `Estimated total: ${money(order.total)}`,
      "Payment: Cash on Delivery, after store confirmation.",
      "",
      `Name: ${order.customer.name}`,
      `Mobile: +91 ${order.customer.phone}`,
      `Email: ${order.customer.email}`,
      `Address: ${order.customer.address}`,
      `${order.customer.city}, ${order.customer.state} ${order.customer.pincode}`,
      ...(point
        ? [
            `Delivery map: https://www.google.com/maps/dir/?api=1&destination=${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`,
          ]
        : []),
      "",
      "Prepared at the Blunder website. This is a request, not a confirmed order.",
    ].join("\n");
  }
  function whatsappURL(draft, config) {
    const contact = contacts(config);
    if (!contact.enabled) fail("WhatsApp ordering is not configured.");
    return `https://wa.me/${contact.phone}?text=${encodeURIComponent(message(draft))}`;
  }
  function emailURL(draft, config) {
    const contact = contacts(config);
    if (!contact.email) return "";
    return `mailto:${contact.email}?subject=${encodeURIComponent(`Blunder COD request ${draft.id}`)}&body=${encodeURIComponent(message(draft))}`;
  }
  globalThis.BlunderRequests = Object.freeze({
    contacts,
    create,
    message,
    whatsappURL,
    emailURL,
  });
})();
