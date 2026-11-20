"use strict";
(() => {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const money = (amount) =>
    new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: amount % 100 ? 2 : 0,
    }).format(amount / 100);
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char],
    );
  const icon = (name) =>
    `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
  const read = (key, fallback) => {
    try {
      return JSON.parse(localStorage.getItem(`blunder:${key}`)) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const save = (key, value) => {
    try {
      localStorage.setItem(`blunder:${key}`, JSON.stringify(value));
    } catch {
      /* Shopping still works when storage is unavailable. */
    }
  };
  const state = {
    products: [],
    cart: [],
    saved: [],
    config: null,
    category: "all",
    query: "",
    maxPrice: 50,
    sort: "featured",
    savedOnly: false,
    coupon: "",
    quote: null,
    activeOrder: null,
    orderToken: "",
    detailProduct: null,
    detailVariant: "",
    checkoutBusy: false,
    checkoutLocation: null,
  };
  const apiOrigin = String(window.BLUNDER_API_ORIGIN || "").replace(/\/$/, "");
  let hasAPI = false,
    toastTimer,
    searchTimer,
    pollTimer,
    entranceObserver;
  const openers = new WeakMap();
  const animations = new Set();
  const product = (id) => state.products.find((p) => p.id === id);
  const keyFor = (id, variant) => `${id}:${variant}`;
  const cartItem = (id, variant = "standard") =>
    state.cart.find(
      (item) => item.productId === id && item.variantId === variant,
    );
  const count = () => state.cart.reduce((sum, item) => sum + item.quantity, 0);
  async function api(path, data, options = {}) {
    const response = await fetch(`${apiOrigin}${path}`, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.key ? { "Idempotency-Key": options.key } : {}),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: options.signal || AbortSignal.timeout(20000),
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error("The store could not be reached. Please try again.");
    }
    if (!response.ok) {
      const error = new Error(result.error || "Please try again in a moment.");
      error.code = result.code;
      throw error;
    }
    return result;
  }
  function animate(element, frames, options) {
    if (!element || reduced.matches || typeof element.animate !== "function")
      return;
    const animation = element.animate(frames, options);
    animations.add(animation);
    const done = () => animations.delete(animation);
    animation.addEventListener("finish", done, { once: true });
    animation.addEventListener("cancel", done, { once: true });
    return animation;
  }
  function openDialog(id) {
    const dialog = $(`#${id}`);
    if (dialog.open) return;
    openers.set(dialog, document.activeElement);
    dialog.showModal();
  }
  function closeDialog(dialog) {
    if (!dialog?.open) return;
    dialog.close();
    if (dialog.id === "orders-dialog") clearTimeout(pollTimer);
    const opener = openers.get(dialog);
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }
  $$("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) {
        const r = dialog.getBoundingClientRect();
        if (
          event.clientX < r.left ||
          event.clientX > r.right ||
          event.clientY < r.top ||
          event.clientY > r.bottom
        )
          closeDialog(dialog);
      }
    });
    dialog.addEventListener("close", () => {
      if (dialog.id === "orders-dialog") clearTimeout(pollTimer);
    });
  });
  function toast(text, showBag = true) {
    clearTimeout(toastTimer);
    $("#toast>span").textContent = text;
    $("#toast>button").hidden = !showBag;
    $("#toast").hidden = false;
    toastTimer = setTimeout(() => {
      $("#toast").hidden = true;
    }, 4000);
  }
  function paintCounts() {
    $("#bag-count").textContent = count();
    $(".bag-trigger").setAttribute(
      "aria-label",
      `Open basket, ${count()} item${count() === 1 ? "" : "s"}`,
    );
    $("#saved-count").textContent = state.saved.length;
    $("#saved-count").hidden = !state.saved.length;
    $(".saved-trigger").setAttribute(
      "aria-label",
      `Saved items, ${state.saved.length}`,
    );
  }
  function quantityControl(id, variant = "standard") {
    const p = product(id),
      item = cartItem(id, variant),
      quantity = item?.quantity || 0;
    const available = p?.variants.find((v) => v.id === variant)?.stock;
    if (!quantity)
      return `<button class="add-button" data-add="${esc(id)}" data-variant="${esc(variant)}" aria-label="Add ${esc(p?.name)} to basket" ${state.config?.checkoutEnabled && !available ? "disabled" : ""}>${state.config?.checkoutEnabled && !available ? "Sold out" : `Add ${icon("plus")}`}</button>`;
    return `<div class="quantity" aria-label="${esc(p.name)} quantity"><button data-quantity="-1" data-id="${esc(id)}" data-variant="${esc(variant)}" aria-label="Remove one ${esc(p.name)}">${icon("minus")}</button><output aria-label="Quantity">${quantity}</output><button data-quantity="1" data-id="${esc(id)}" data-variant="${esc(variant)}" aria-label="Add one ${esc(p.name)}" ${quantity >= 10 || (state.config?.checkoutEnabled && quantity >= available) ? "disabled" : ""}>${icon("plus")}</button></div>`;
  }
  function priceHTML(p) {
    const verified =
      Number.isSafeInteger(p.mrp) &&
      p.mrp > p.price &&
      typeof p.priceSource === "string" &&
      /^https:\/\//.test(p.priceSource);
    return `<span class="product-price">${money(p.price)}${verified ? `<del>${money(p.mrp)}</del>` : ""}</span>`;
  }
  function card(p) {
    const wish = state.saved.includes(p.id);
    const verified =
      Number.isSafeInteger(p.mrp) &&
      p.mrp > p.price &&
      /^https:\/\//.test(p.priceSource || "");
    return `<article class="product-card tone-${esc(p.tone)}" data-product-card="${esc(p.id)}" style="view-transition-name:product-${esc(p.id)}"><span class="product-label">${verified ? `${Math.round((1 - p.price / p.mrp) * 100)}% OFF` : p.price <= 1000 ? "THE ₹10 CLUB" : "PANTRY PICK"}</span><button class="wish-button" data-save="${esc(p.id)}" aria-pressed="${wish}" aria-label="${wish ? "Unsave" : "Save"} ${esc(p.name)}">${icon("heart")}</button><button class="product-picture" data-detail="${esc(p.id)}" aria-label="View ${esc(p.name)} details"><img src="${esc(p.image)}" alt="${esc(p.name)}" width="432" height="432" loading="lazy"></button><div class="product-body"><p class="product-category">${esc(p.category)}</p><h3><button class="product-name" data-detail="${esc(p.id)}">${esc(p.name)}</button></h3><span class="pack-size">${esc(p.pack)}</span><div class="product-bottom">${priceHTML(p)}<div data-card-quantity="${esc(p.id)}">${quantityControl(p.id, p.variants[0].id)}</div></div></div></article>`;
  }
  function renderProducts(useTransition = false) {
    const filtered = state.products.filter(
      (p) =>
        (state.category === "all" || p.category === state.category) &&
        p.price <= state.maxPrice * 100 &&
        (!state.savedOnly || state.saved.includes(p.id)) &&
        `${p.name} ${p.category} ${p.pack}`
          .toLowerCase()
          .includes(state.query.toLowerCase()),
    );
    filtered.sort((a, b) =>
      state.sort === "low"
        ? a.price - b.price
        : state.sort === "high"
          ? b.price - a.price
          : state.sort === "name"
            ? a.name.localeCompare(b.name)
            : a.featured - b.featured,
    );
    const paint = () => {
      $("#product-grid").innerHTML = filtered.map(card).join("");
      $("#empty-products").hidden = !!filtered.length;
      $("#result-count").textContent =
        `${filtered.length} ${state.savedOnly ? "saved" : "little"} find${filtered.length === 1 ? "" : "s"}${state.query ? ` for “${state.query}”` : ""}`;
      $("#reset-filters").hidden =
        state.category === "all" &&
        !state.query &&
        state.maxPrice === 50 &&
        !state.savedOnly;
      $$(".filter-chips button").forEach((button) =>
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.filter === state.category),
        ),
      );
      $("#price-filter").value = String(state.maxPrice);
      $("#sort").value = state.sort;
      $("#search").value = state.query;
      $(".search-clear").hidden = !state.query;
      observeReveals();
    };
    if (
      useTransition &&
      document.startViewTransition &&
      !reduced.matches &&
      !document.querySelector("dialog[open]")
    )
      document.startViewTransition(paint);
    else paint();
    const params = new URLSearchParams();
    if (state.query) params.set("q", state.query);
    if (state.category !== "all") params.set("category", state.category);
    if (state.maxPrice !== 50) params.set("max", state.maxPrice);
    if (state.savedOnly) params.set("saved", "1");
    history.replaceState(
      null,
      "",
      `${location.pathname}${params.size ? "?" + params : ""}${location.hash}`,
    );
  }
  function scrollShop() {
    $("#shop").scrollIntoView({
      behavior: reduced.matches ? "instant" : "smooth",
      block: "start",
    });
  }
  function resetFilters() {
    state.category = "all";
    state.query = "";
    state.maxPrice = 50;
    state.savedOnly = false;
    renderProducts(true);
  }
  function mutateCart(id, variant, delta) {
    const p = product(id),
      v = p?.variants.find((x) => x.id === variant);
    if (!p || !v) return;
    let item = cartItem(id, variant);
    const next = (item?.quantity || 0) + delta;
    if (next > 10) return toast("You can add up to 10 of each item.", false);
    if (state.config?.checkoutEnabled && next > v.stock)
      return toast("That quantity is not available right now.", false);
    if (next <= 0) state.cart = state.cart.filter((x) => x !== item);
    else if (item) item.quantity = next;
    else state.cart.push({ productId: id, variantId: variant, quantity: next });
    state.quote = null;
    state.coupon = "";
    save("bag", state.cart);
    paintCounts();
    const holder = document.querySelector(`[data-card-quantity="${id}"]`);
    const focused = document.activeElement;
    const action = focused?.dataset.quantity;
    const focusInCard = holder?.contains(focused);
    if (holder) holder.innerHTML = quantityControl(id, p.variants[0].id);
    if (focusInCard)
      (
        holder.querySelector(`[data-quantity="${action}"]:not(:disabled)`) ||
        holder.querySelector("button")
      )?.focus({ preventScroll: true });
    if ($("#bag-dialog").open) renderBag();
    if (delta > 0) {
      toast(`${p.name} added to your basket.`);
      animate(
        $("#bag-count"),
        [{ scale: 1 }, { scale: 1.35, background: "#f6ffba" }, { scale: 1 }],
        { duration: 420, easing: "ease-out" },
      );
    }
  }
  function totals() {
    const items = state.cart.map((i) => ({
      ...i,
      ...product(i.productId),
      price: product(i.productId).price,
      name: product(i.productId).name,
      pack: product(i.productId).variants.find((v) => v.id === i.variantId)
        .label,
    }));
    const subtotal = items.reduce(
      (sum, item) => sum + item.quantity * item.price,
      0,
    );
    const shipping =
      subtotal >= (state.config?.shipping.freeAbove || 19900)
        ? 0
        : (state.config?.shipping.standard ?? 2000);
    return (
      state.quote || {
        items,
        subtotal,
        discount: 0,
        shipping,
        total: subtotal + shipping,
      }
    );
  }
  function totalRows(t, estimated = !state.config.checkoutEnabled) {
    return `<div class="totals"><div><span>Products</span><span>${money(t.subtotal)}</span></div>${t.discount ? `<div><span>Offer savings</span><span>−${money(t.discount)}</span></div>` : ""}<div><span>${estimated ? "Estimated delivery" : "Delivery"}</span><span>${t.shipping ? money(t.shipping) : "Free"}</span></div><div class="total"><span>${estimated ? "Estimated total" : "Total"}</span><span>${money(t.total)}</span></div></div>`;
  }
  function renderBag() {
    const content = $("#bag-content");
    const focused = document.activeElement;
    const focus =
      focused && content.contains(focused)
        ? {
            id: focused.dataset.id,
            variant: focused.dataset.variant,
            delta: focused.dataset.quantity,
            remove: focused.dataset.remove,
          }
        : null;
    if (!state.cart.length)
      content.innerHTML = `<div class="empty-state">${icon("bag")}<h3>A little room for good things.</h3><p>Your basket is waiting for its first everyday favourite.</p><button class="button button-dark" data-action="continue">Explore the shop ${icon("arrow")}</button></div>`;
    else {
      const t = totals(),
        threshold = state.config.shipping.freeAbove;
      content.innerHTML = `<div>${state.cart
        .map((item) => {
          const p = product(item.productId);
          return `<div class="bag-line"><img src="${esc(p.image)}" alt="" width="76" height="82"><div><h3>${esc(p.name)}</h3><p>${esc(p.variants.find((v) => v.id === item.variantId).label)} · ${money(p.price)} each</p>${quantityControl(p.id, item.variantId)}</div><div><span class="line-total">${money(p.price * item.quantity)}</span><button class="remove-item" data-remove="${esc(p.id)}" data-variant="${esc(item.variantId)}" aria-label="Remove ${esc(p.name)} from basket">Remove</button></div></div>`;
        })
        .join(
          "",
        )}</div><div class="basket-summary"><div class="shipping-progress">${t.subtotal >= threshold ? "Your basket meets the free delivery threshold." : `You’re ${money(threshold - t.subtotal)} away from free delivery.`}<div><i style="width:${Math.min(100, (t.subtotal / threshold) * 100)}%"></i></div></div>${totalRows(t)}${!state.config.checkoutEnabled ? '<p class="notice">Ordering is temporarily unavailable. Your basket is saved.</p>' : ""}<button class="button button-dark" data-action="checkout">Review & checkout ${icon("arrow")}</button><small>Delivery availability is checked before placing your order.</small></div>`;
    }
    if (focus?.id)
      content
        .querySelector(
          `[data-quantity="${focus.delta}"][data-id="${focus.id}"][data-variant="${focus.variant}"]:not(:disabled)`,
        )
        ?.focus({ preventScroll: true });
    else if (focus?.remove)
      ($('[data-action="checkout"]') || content.querySelector("button"))?.focus(
        { preventScroll: true },
      );
  }
  function detail(id) {
    const p = product(id);
    if (!p) return;
    state.detailProduct = id;
    state.detailVariant = p.variants[0].id;
    $("#product-detail").innerHTML =
      `<div class="detail-grid"><div class="detail-art tone-${esc(p.tone)}"><img src="${esc(p.image)}" alt="${esc(p.name)}" width="432" height="432"></div><div class="detail-copy"><p class="eyebrow">${esc(p.category.toUpperCase())}</p><h2 id="detail-title">${esc(p.name)}</h2><span class="pack-size">${esc(p.pack)}</span><p class="detail-description">${esc(p.description)}</p>${priceHTML(p)}<label>${esc(p.optionLabel)}</label><div class="variant-options" role="group" aria-label="Choose pack">${p.variants.map((v, i) => `<button data-choose-variant="${esc(v.id)}" aria-pressed="${i === 0}">${esc(v.label)}</button>`).join("")}</div><button class="button button-dark" data-action="detail-add">Add to your basket ${icon("plus")}</button><button class="text-button" data-save="${esc(id)}" aria-pressed="${state.saved.includes(id)}">${icon("heart")} Save for later</button><button class="text-button" data-action="product-ai">Ask AI about this product ${icon("arrow")}</button><ul>${p.details.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div></div>`;
    updateDetailAvailability();
    openDialog("product-dialog");
  }
  function updateDetailAvailability() {
    const p = product(state.detailProduct);
    const button = $('[data-action="detail-add"]');
    if (button && p) {
      button.disabled =
        state.config.checkoutEnabled &&
        !p.variants.find((v) => v.id === state.detailVariant).stock;
      button.innerHTML = button.disabled
        ? "Currently sold out"
        : `Add to your basket ${icon("plus")}`;
    }
  }
  function policy(type) {
    const titles = {
      shipping: "Good things, on their way.",
      returns: "Let’s make it right.",
      privacy: "Your privacy matters.",
      terms: "A few good things to know.",
    };
    $("#policy-title").textContent = titles[type] || "Contact the store.";
    const text = state.config.policies?.[type];
    $("#policy-content").innerHTML = text
      ? `<p>${esc(text)}</p>${!state.config.checkoutEnabled ? '<p class="notice">The store is preparing to open. No orders are being accepted yet.</p>' : ""}`
      : `<p>${state.config.supportEmail ? `For help with an order, email <a href="mailto:${esc(state.config.supportEmail)}">${esc(state.config.supportEmail)}</a> and include your order reference.` : "Our support contact will be published before the store opens. We are not accepting orders yet."}</p>`;
    if (state.config.supportEmail && type !== "support")
      $("#policy-content").insertAdjacentHTML(
        "beforeend",
        `<p>Need help? <a href="mailto:${esc(state.config.supportEmail)}">${esc(state.config.supportEmail)}</a></p>`,
      );
    const supportPhone = String(state.config.supportPhone || "").replace(
      /\D/g,
      "",
    );
    if (type === "support" && /^91[6-9]\d{9}$/.test(supportPhone))
      $("#policy-content").insertAdjacentHTML(
        "beforeend",
        `<a class="button button-dark" href="https://wa.me/${supportPhone}" target="_blank" rel="noopener">Contact support ${icon("diagonal")}</a><p>For order questions, include your order reference. New orders are placed through checkout.</p>`,
      );
    openDialog("policy-dialog");
  }
  function checkDelivery(pin) {
    if (!/^[1-9]\d{5}$/.test(pin))
      return { valid: false, text: "Please enter a valid 6-digit PIN code." };
    if (!state.config.checkoutEnabled)
      return {
        valid: false,
        text: "We’re preparing to open. Your area and delivery window will be confirmed at launch.",
      };
    const valid = state.config.shipping.pincodes.includes(pin);
    return {
      valid,
      text: valid
        ? `Good things are coming your way. ${state.config.shipping.estimate}`
        : "We don’t deliver to this PIN code yet. Please try another address.",
    };
  }
  function directions(point) {
    if (
      !point ||
      !Number.isFinite(point.latitude) ||
      !Number.isFinite(point.longitude) ||
      Math.abs(point.latitude) > 90 ||
      Math.abs(point.longitude) > 180
    )
      return "";
    return `https://www.google.com/maps/dir/?api=1&destination=${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`;
  }
  function locationMatchesForm(selection) {
    if (!selection?.point || !$("#checkout-form")) return false;
    const normal = (value) =>
      String(value || "")
        .trim()
        .toLowerCase();
    return ["city", "state", "pincode"].every(
      (name) =>
        !selection[name] ||
        normal($("#checkout-form").elements[name].value) ===
          normal(selection[name]),
    );
  }
  function paintCheckoutLocation() {
    const container = $("#checkout-location");
    if (!container) return;
    const point = state.checkoutLocation?.point;
    container.innerHTML = `<div>${icon("pin")}<strong>${point ? "Delivery point selected" : "Pin your delivery address"}</strong><button type="button" data-action="checkout-location">${point ? "Change location" : "Choose on map"}</button></div><p>${point ? `Pin at ${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}. Check the house / flat details below.` : "Search your area or use your current location. You can also enter your address manually."}</p>${point ? `<a href="${directions(point)}" target="_blank" rel="noopener">Open directions ↗</a>` : ""}`;
  }
  function applyDeliverySelection(selection, preserveHouse = false) {
    state.checkoutLocation = selection;
    const form = $("#checkout-form");
    if (form && selection) {
      for (const field of ["address", "city", "state", "pincode"]) {
        if (
          field === "address" &&
          preserveHouse &&
          form.elements[field].value.trim()
        )
          continue;
        if (selection[field]) form.elements[field].value = selection[field];
      }
      $("#checkout-delivery").textContent = checkDelivery(
        form.elements.pincode.value,
      ).text;
    }
    paintCheckoutLocation();
  }
  function openLocation(fromCheckout = false) {
    let seed;
    if (fromCheckout && $("#checkout-form")) {
      const form = $("#checkout-form");
      seed = Object.fromEntries(
        ["address", "city", "state", "pincode"].map((name) => [
          name,
          form.elements[name].value,
        ]),
      );
      seed.point = locationMatchesForm(state.checkoutLocation)
        ? state.checkoutLocation.point
        : null;
    }
    openDialog("delivery-dialog");
    window.BlunderLocation.open(seed);
  }
  function configureLocation() {
    window.BlunderLocation.configure({
      checkAvailability: checkDelivery,
      readPin: () => read("pin", ""),
      request:
        hasAPI && state.config.mapsAvailable
          ? (kind, payload, signal) =>
              api(`/api/maps/${kind}`, payload, { signal })
          : undefined,
      onSelect: (selection, action) => {
        save("pin", selection?.pincode || "");
        $("#delivery-label").textContent = selection
          ? `${selection.city || "Delivery area"} · ${selection.pincode}`
          : "Check your delivery area";
        if ($("#checkout-dialog").open) applyDeliverySelection(selection);
        if (action === "confirm") {
          closeDialog($("#delivery-dialog"));
          toast("Delivery address saved for this tab.", false);
        }
      },
    });
    const selection = window.BlunderLocation.getSelection();
    if (selection)
      $("#delivery-label").textContent =
        `${selection.city || "Delivery area"} · ${selection.pincode}`;
  }
  function renderCheckout() {
    if (!state.cart.length) return;
    const t = totals(),
      enabled = state.config.checkoutEnabled;
    const methods = enabled ? state.config.paymentMethods : ["cod"];
    $("#checkout-content").innerHTML =
      `<form id="checkout-form"><div class="checkout-layout"><div class="checkout-form"><h3>01 &nbsp; Your details</h3><div class="field-grid"><div class="field field-wide"><label for="customer-name">Full name</label><input id="customer-name" name="name" autocomplete="name" minlength="2" maxlength="80" required></div><div class="field"><label for="customer-email">Email address</label><input id="customer-email" name="email" type="email" autocomplete="email" maxlength="160" required></div><div class="field"><label for="customer-phone">Mobile number</label><input id="customer-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel-national" pattern="[6-9][0-9]{9}" maxlength="10" placeholder="10-digit mobile number" required></div></div><h3>02 &nbsp; Where to?</h3><div id="checkout-location" class="checkout-location"></div><div class="field-grid"><div class="field field-wide"><label for="customer-address">House / flat, building & street</label><textarea id="customer-address" name="address" autocomplete="street-address" minlength="8" maxlength="220" required></textarea></div><div class="field"><label for="customer-city">City</label><input id="customer-city" name="city" autocomplete="address-level2" minlength="2" maxlength="80" required></div><div class="field"><label for="customer-state">State</label><input id="customer-state" name="state" autocomplete="address-level1" minlength="2" maxlength="80" required></div><div class="field field-wide"><label for="customer-pin">PIN code</label><input id="customer-pin" name="pincode" inputmode="numeric" autocomplete="postal-code" pattern="[1-9][0-9]{5}" maxlength="6" value="${esc(read("pin", ""))}" required><small id="checkout-delivery">${esc(state.config.shipping.estimate)}</small></div></div><h3>03 &nbsp; Pay your way</h3>${methods.map((method, i) => `<label class="payment-option"><input type="radio" name="method" value="${method}" ${i === 0 ? "checked" : ""}><span><strong>${method === "cod" ? "Cash on Delivery" : state.config.paymentMode === "test" ? "Online payment · Test mode" : "Pay online"}</strong><small>${method === "cod" ? "Pay when your order reaches you. The store confirms your request before dispatch." : "UPI, cards and supported payment methods via Razorpay."}</small></span></label>`).join("")}<p class="notice ${enabled ? "success" : ""}">${enabled ? "Confirm your details below. The store receives your order automatically; you do not need to send a separate message." : "Ordering is temporarily unavailable. Your basket is saved; please check back shortly."}</p></div><aside class="checkout-summary"><h3>Your little finds <span>(${count()})</span></h3>${t.items.map((i) => `<div class="bag-line"><img src="${esc(i.image)}" alt="" width="46" height="50"><div><h3>${esc(i.name)}</h3><p>${esc(i.pack)} × ${i.quantity}</p></div><strong>${money(i.price * i.quantity)}</strong></div>`).join("")}<details class="coupon-section"><summary>Have an offer code?</summary><div class="coupon-row"><label class="sr-only" for="coupon">Offer code</label><input id="coupon" placeholder="Enter code" value="${esc(state.coupon)}" maxlength="30"><button type="button" data-action="coupon">Apply</button></div><p class="coupon-feedback" id="coupon-feedback" role="status"></p></details><div id="checkout-totals">${totalRows(t)}</div><button class="button button-dark" type="submit" id="place-order" ${!enabled ? "disabled" : ""}>${methods[0] === "cod" ? "Confirm COD order" : "Continue to payment"} ${icon("arrow")}</button><small>By placing an order, you agree to the store’s <button type="button" class="inline-link" data-policy="terms">terms</button> and <button type="button" class="inline-link" data-policy="privacy">privacy policy</button>.</small><div id="checkout-message" class="checkout-message" role="status"></div></aside></div></form>`;
    applyDeliverySelection(window.BlunderLocation.getSelection());
    closeDialog($("#bag-dialog"));
    openDialog("checkout-dialog");
  }
  function savedOrders() {
    const entries = read("orders", []);
    return Array.isArray(entries)
      ? entries
          .filter(
            (o) =>
              /^BL-[A-F0-9]{14}$/.test(o?.id) &&
              /^[a-f0-9]{64}$/.test(o?.token),
          )
          .slice(0, 30)
      : [];
  }
  function rememberOrder(order, token) {
    save(
      "orders",
      [
        { id: order.id, token, createdAt: order.createdAt },
        ...savedOrders().filter((o) => o.id !== order.id),
      ].slice(0, 30),
    );
  }
  async function placeOrder(form) {
    if (state.checkoutBusy || !state.config.checkoutEnabled) return;
    if (!form.reportValidity()) return;
    const data = new FormData(form),
      customer = Object.fromEntries(
        ["name", "email", "phone", "address", "city", "state", "pincode"].map(
          (key) => [key, String(data.get(key)).trim()],
        ),
      );
    if (locationMatchesForm(state.checkoutLocation))
      customer.location = { ...state.checkoutLocation.point };
    const check = checkDelivery(customer.pincode),
      feedback = $("#checkout-message");
    if (!check.valid) {
      feedback.innerHTML = `<p class="notice error">${esc(check.text)}</p>`;
      return;
    }
    state.checkoutBusy = true;
    $("#place-order").disabled = true;
    feedback.textContent = "Preparing your order…";
    const payload = {
      items: state.cart.map((i) => ({ ...i })),
      coupon: state.coupon,
      customer,
      method: data.get("method"),
    };
    const fingerprint = [
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify(payload)),
        ),
      ),
    ]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    let checkout;
    try {
      checkout = JSON.parse(sessionStorage.getItem("blunder:checkout"));
    } catch {
      /* Private browsing. */
    }
    if (checkout?.fingerprint !== fingerprint)
      checkout = { fingerprint, key: crypto.randomUUID() };
    try {
      sessionStorage.setItem("blunder:checkout", JSON.stringify(checkout));
    } catch {
      /* The current request still has an idempotency key. */
    }
    try {
      const order = await api("/api/orders", payload, { key: checkout.key });
      rememberOrder(order, order.accessToken);
      state.activeOrder = order;
      state.orderToken = order.accessToken;
      feedback.textContent = "";
      if (order.method === "cod") {
        clearCompletedBag(order);
        closeDialog($("#checkout-dialog"));
        showOrder(order, order.accessToken);
      } else {
        closeDialog($("#checkout-dialog"));
        showOrder(order, order.accessToken);
        await startPayment(order, order.accessToken, order.keyId);
      }
    } catch (error) {
      if (error.code === "CHECKOUT_RESTART") {
        try {
          sessionStorage.removeItem("blunder:checkout");
        } catch {}
      }
      feedback.innerHTML = `<p class="notice error">${esc(error.message)}</p>`;
    } finally {
      state.checkoutBusy = false;
      if ($("#place-order"))
        $("#place-order").disabled = !state.config.checkoutEnabled;
    }
  }
  function clearCompletedBag(order) {
    const stored = read("cleared-orders", []);
    const cleared = Array.isArray(stored)
      ? stored.filter((id) => typeof id === "string")
      : [];
    if (cleared.includes(order.id)) return;
    window.AakashAccount?.save('orders', order.id, {id:order.id,status:order.status,items:order.items.map(i=>({name:i.name,quantity:i.quantity})),createdAt:order.createdAt});
    state.cart = state.cart
      .map((item) => ({
        ...item,
        quantity: Math.max(
          0,
          item.quantity -
            (order.items.find(
              (line) =>
                line.productId === item.productId &&
                line.variantId === item.variantId,
            )?.quantity || 0),
        ),
      }))
      .filter((item) => item.quantity > 0);
    save("cleared-orders", [order.id, ...cleared].slice(0, 100));
    state.quote = null;
    state.coupon = "";
    save("bag", state.cart);
    paintCounts();
    renderProducts();
    try {
      sessionStorage.removeItem("blunder:checkout");
    } catch {
      /* Optional storage. */
    }
  }
  let razorpayScript;
  async function startPayment(order, token, keyId = state.config.paymentKeyId) {
    if (!keyId) {
      toast("Online payments are not currently available.", false);
      return;
    }
    try {
      if (!window.Razorpay) {
        if (!razorpayScript)
          razorpayScript = new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = "https://checkout.razorpay.com/v1/checkout.js";
            const timer = setTimeout(() => {
              script.remove();
              reject(
                new Error(
                  "The payment window could not load. Check your connection and try again.",
                ),
              );
            }, 15000);
            script.onload = () => {
              clearTimeout(timer);
              resolve();
            };
            script.onerror = () => {
              clearTimeout(timer);
              script.remove();
              reject(
                new Error(
                  "The payment window could not load. You can retry from Your orders.",
                ),
              );
            };
            document.head.append(script);
          }).catch((error) => {
            razorpayScript = null;
            throw error;
          });
        await razorpayScript;
      }
      closeDialog($("#orders-dialog"));
      const payment = new window.Razorpay({
        key: keyId,
        amount: order.total,
        currency: "INR",
        order_id: order.gatewayOrderId,
        name: "Blunder",
        description: order.id,
        prefill: {
          name: order.customer.name,
          email: order.customer.email,
          contact: order.customer.phone,
        },
        theme: { color: "#263d2b" },
        timeout: 600,
        handler: async (response) => {
          try {
            const verified = await api(
              `/api/orders/${order.id}/verify`,
              response,
              { token },
            );
            if (["paid", "paid_review"].includes(verified.status))
              clearCompletedBag(verified);
            showOrder(verified, token);
            if (verified.status === "pending") pollOrder(verified.id, token);
          } catch {
            showOrder(order, token);
            $("#order-feedback").textContent =
              "Payment verification is still pending. We will check your order status again; do not pay twice.";
            pollOrder(order.id, token);
          }
        },
        modal: {
          ondismiss: () => {
            showOrder(state.activeOrder || order, token);
            pollOrder(order.id, token);
          },
        },
      });
      payment.on("payment.failed", () => {
        toast(
          "Payment was not completed. You can retry from Your orders.",
          false,
        );
      });
      payment.open();
    } catch (error) {
      showOrder(order, token);
      $("#order-feedback").textContent = error.message;
    }
  }
  function ordersList() {
    clearTimeout(pollTimer);
    const orders = savedOrders();
    $("#orders-content").innerHTML =
      `<p class="orders-intro">Your orders are private. Orders placed on this device appear here; use your reference and private access code to find an order from another device.</p>${orders.length ? orders.map((o) => `<button class="order-list-card" data-order="${esc(o.id)}"><span><strong>${esc(o.id)}</strong><span>${new Date(o.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}</span></span>${icon("arrow")}</button>`).join("") : '<p class="notice">No orders on this device yet. Your first little basket is waiting.</p>'}<form class="lookup-form" id="lookup-form"><h3>Find an order</h3><label for="lookup-reference">Order reference</label><input id="lookup-reference" name="reference" placeholder="BL-…" pattern="BL-[A-Fa-f0-9]{14}" required><label for="lookup-code">Private access code</label><input id="lookup-code" name="code" type="password" autocomplete="off" minlength="64" maxlength="64" required><button class="button button-dark">Find my order ${icon("arrow")}</button><p id="lookup-feedback" role="status"></p></form>`;
    openDialog("orders-dialog");
  }
  const statusCopy = {
    cod_pending: [
      "Your basket is on the list.",
      "Your Cash on Delivery order has been saved for the store. Seller alerts are handled automatically; you do not need to send a message. We will confirm delivery before dispatch. No online payment has been taken.",
    ],
    cod_confirmed: [
      "Your order is confirmed.",
      "Your order is being prepared. Pay the order total when it arrives.",
    ],
    paid: [
      "Good things are on the way.",
      "Your payment is confirmed. You can check delivery progress here.",
    ],
    pending: [
      "One more little step.",
      "Your order is saved, but payment is not confirmed yet. Complete payment or check the status below.",
    ],
    paid_review: [
      "Payment received. We’re reviewing it.",
      "Your payment arrived after the stock reservation expired. The store must confirm fulfilment or arrange a refund. Please contact support.",
    ],
    expired: [
      "This order has expired.",
      "Your stock reservation has ended. If you completed payment, refresh your status or contact the store before paying again.",
    ],
    cancelled: [
      "Order cancelled.",
      "Your Cash on Delivery request has been cancelled. No payment is due.",
    ],
    refunded: [
      "Your refund has been processed.",
      "The payment provider has processed your refund. Your bank determines when it appears in your account.",
    ],
    failed: [
      "Payment could not be started.",
      "No payment was confirmed. Please try a new checkout.",
    ],
  };
  function showOrder(order, token) {
    clearTimeout(pollTimer);
    state.activeOrder = order;
    state.orderToken = token;
    $("#orders-title").textContent = "Your order.";
    const copy = statusCopy[order.status] || [
      "Your order",
      "Checking the latest order details.",
    ];
    $("#orders-content").innerHTML =
      `<div class="order-success"><div class="success-icon">${icon(["paid", "cod_confirmed"].includes(order.status) ? "check" : "box")}</div><h3>${copy[0]}</h3><p>${copy[1]}</p></div><div class="order-reference"><span>${esc(order.id)}</span><button data-action="copy-order">Copy reference</button></div><div class="order-details"><h4>Delivery status</h4><p>${esc(order.fulfillment === "unfulfilled" ? "Not dispatched yet" : order.fulfillment === "shipped" ? "Dispatched" : "Delivered")}${order.tracking && /^https:\/\//.test(order.tracking) ? ` · <a href="${esc(order.tracking)}" target="_blank" rel="noopener">Track delivery ↗</a>` : ""}</p><h4>Delivery address</h4><p>${esc(order.customer.name)}<br>${esc(order.customer.address)}<br>${esc(order.customer.city)}, ${esc(order.customer.state)} ${esc(order.customer.pincode)}</p>${directions(order.customer.location) ? `<a class="order-map-link" href="${directions(order.customer.location)}" target="_blank" rel="noopener">${icon("pin")} Open delivery directions</a>` : ""}</div>${order.items.map((i) => `<div class="bag-line"><img src="${esc(i.image)}" alt=""><div><h3>${esc(i.name)}</h3><p>${esc(i.pack)} × ${i.quantity}</p></div><strong>${money(i.price * i.quantity)}</strong></div>`).join("")}${totalRows(order, false)}<p class="orders-intro">${order.method === "cod" ? (order.status === "paid" ? "Cash on Delivery payment recorded." : "Cash on Delivery · Pay only when your order is delivered.") : "Online payment via Razorpay."}</p><div class="order-actions"><button class="button button-dark" data-action="refresh-order">Refresh status ${icon("arrow")}</button>${order.status === "pending" ? `<button class="button button-outline" data-action="retry-payment">Complete payment</button>` : ""}<button class="button button-outline" data-action="receipt">Download order details</button>${order.method === "cod" && ["cod_pending", "cod_confirmed"].includes(order.status) && order.fulfillment === "unfulfilled" ? '<button class="text-button" data-action="cancel-order">Cancel COD order</button>' : ""}</div><p id="order-feedback" class="orders-intro" role="status"></p><details class="private-code"><summary>Your private order access code</summary><p>Keep this code private. It lets you view this order on another device.</p><code>${esc(token)}</code><button class="text-button" data-action="copy-code">Copy private code</button></details><button class="text-button" data-action="orders">Back to your orders ${icon("arrow")}</button>`;
    openDialog("orders-dialog");
  }
  async function fetchOrder(id, token) {
    if (!hasAPI)
      throw new Error("Order tracking will open when the store launches.");
    const order = await api(`/api/orders/${id}`, undefined, { token });
    rememberOrder(order, token);
    showOrder(order, token);
    return order;
  }
  function pollOrder(id, token, remaining = 8) {
    clearTimeout(pollTimer);
    if (!remaining || !$("#orders-dialog").open) return;
    pollTimer = setTimeout(async () => {
      try {
        const order = await api(`/api/orders/${id}`, undefined, { token });
        if (["paid", "paid_review", "refunded"].includes(order.status)) {
          clearCompletedBag(order);
          showOrder(order, token);
          return;
        }
      } catch {
        /* Keep the last honest status when offline. */
      }
      pollOrder(id, token, remaining - 1);
    }, 5000);
  }
  async function copy(text, feedback) {
    try {
      await navigator.clipboard.writeText(text);
      toast(feedback, false);
    } catch {
      toast(
        "Copy is unavailable here. You can select the reference or access code shown above.",
        false,
      );
    }
  }
  function downloadReceipt() {
    const o = state.activeOrder;
    const body = `BLUNDER · ORDER DETAILS\n${o.id}\nStatus: ${o.status}\nPayment: ${o.method === "cod" ? "Cash on Delivery" : "Razorpay"}\n\n${o.items.map((i) => `${i.name} · ${i.pack} × ${i.quantity} — ${money(i.price * i.quantity)}`).join("\n")}\n\nProducts: ${money(o.subtotal)}\nDiscount: ${money(o.discount)}\nDelivery: ${money(o.shipping)}\nTotal: ${money(o.total)}\n\nDeliver to:\n${o.customer.name}\n${o.customer.address}\n${o.customer.city}, ${o.customer.state} ${o.customer.pincode}\n${directions(o.customer.location) ? `Delivery pin: ${directions(o.customer.location)}\n` : ""}\nThis is an order summary, not a tax invoice.\n`;
    const url = URL.createObjectURL(
      new Blob([body], { type: "text/plain;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${o.id}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.hasAttribute("data-close")) {
      closeDialog(button.closest("dialog"));
      return;
    }
    if (!state.config)
      return toast("The shop is loading. Please try again in a moment.", false);
    if (button.dataset.category || button.dataset.filter) {
      state.category = button.dataset.category || button.dataset.filter;
      state.savedOnly = false;
      state.query = "";
      renderProducts(true);
      if (button.dataset.category) scrollShop();
      return;
    }
    if (button.dataset.detail) return detail(button.dataset.detail);
    if (button.dataset.add)
      return mutateCart(
        button.dataset.add,
        button.dataset.variant || "standard",
        1,
      );
    if (button.dataset.quantity)
      return mutateCart(
        button.dataset.id,
        button.dataset.variant,
        Number(button.dataset.quantity),
      );
    if (button.dataset.remove)
      return mutateCart(button.dataset.remove, button.dataset.variant, -10);
    if (button.dataset.save) {
      const id = button.dataset.save;
      state.saved = state.saved.includes(id)
        ? state.saved.filter((x) => x !== id)
        : [...state.saved, id];
      save("saved", state.saved);
      paintCounts();
      $$(`[data-save="${id}"]`).forEach((b) => {
        b.setAttribute("aria-pressed", state.saved.includes(id));
        if (b.classList.contains("wish-button"))
          b.setAttribute(
            "aria-label",
            `${state.saved.includes(id) ? "Unsave" : "Save"} ${product(id).name}`,
          );
      });
      if (state.savedOnly) renderProducts(true);
      toast(
        state.saved.includes(id)
          ? "Saved for another little day."
          : "Removed from saved items.",
        false,
      );
      return;
    }
    if (button.dataset.chooseVariant) {
      state.detailVariant = button.dataset.chooseVariant;
      $$(".variant-options button").forEach((b) =>
        b.setAttribute("aria-pressed", b === button),
      );
      updateDetailAvailability();
      return;
    }
    if (button.dataset.policy) return policy(button.dataset.policy);
    if (button.dataset.order) {
      const saved = savedOrders().find((o) => o.id === button.dataset.order);
      try {
        await fetchOrder(saved.id, saved.token);
      } catch (error) {
        toast(error.message, false);
      }
      return;
    }
    const action = button.dataset.action;
    if (action === "bag") {
      $("#toast").hidden = true;
      renderBag();
      openDialog("bag-dialog");
    }
    if (action === "continue") {
      closeDialog(button.closest("dialog"));
      scrollShop();
    }
    if (action === "reset") resetFilters();
    if (action === "clear-search") {
      state.query = "";
      renderProducts(true);
      $("#search").focus();
    }
    if (action === "ten") {
      state.category = "all";
      state.query = "";
      state.savedOnly = false;
      state.maxPrice = 10;
      renderProducts(true);
      scrollShop();
    }
    if (action === "saved") {
      state.savedOnly = !state.savedOnly;
      state.category = "all";
      state.query = "";
      state.maxPrice = 50;
      renderProducts(true);
      scrollShop();
    }
    if (action === "delivery") openLocation();
    if (action === "checkout-location") openLocation(true);
    if (action === "support") policy("support");
    if (action === "detail-add") {
      mutateCart(state.detailProduct, state.detailVariant, 1);
      closeDialog($("#product-dialog"));
      renderBag();
      openDialog("bag-dialog");
    }
    if (action === "product-ai") {
      const item = product(state.detailProduct);
      closeDialog($("#product-dialog"));
      window.AakashAssistant?.open(
        `Tell me about ${item.name} (${item.pack}) and suggest a useful pairing from this catalogue.`,
      );
    }
    if (action === "checkout") renderCheckout();
    if (action === "orders") ordersList();
    if (action === "coupon") {
      const code = $("#coupon").value.trim().toUpperCase();
      try {
        if (!hasAPI)
          throw new Error(
            "Offer codes will be available when the store opens.",
          );
        state.quote = await api("/api/quote", {
          items: state.cart,
          coupon: code,
        });
        state.coupon = code;
        $("#checkout-totals").innerHTML = totalRows(state.quote);
        $("#coupon-feedback").textContent = code
          ? `${code} applied.`
          : "Offer code removed.";
      } catch (error) {
        $("#coupon-feedback").textContent = error.message;
      }
    }
    if (action === "refresh-order") {
      button.disabled = true;
      try {
        await fetchOrder(state.activeOrder.id, state.orderToken);
      } catch (error) {
        $("#order-feedback").textContent = error.message;
      } finally {
        button.disabled = false;
      }
    }
    if (action === "retry-payment")
      await startPayment(state.activeOrder, state.orderToken);
    if (action === "copy-order")
      copy(state.activeOrder.id, "Order reference copied.");
    if (action === "copy-code")
      copy(state.orderToken, "Private access code copied. Keep it safe.");
    if (action === "receipt") downloadReceipt();
    if (action === "cancel-order") {
      if (button.dataset.confirm !== "yes") {
        button.dataset.confirm = "yes";
        button.textContent = "Confirm cancellation";
        return;
      }
      button.disabled = true;
      try {
        const order = await api(
          `/api/orders/${state.activeOrder.id}/cancel`,
          {},
          { token: state.orderToken },
        );
        showOrder(order, state.orderToken);
      } catch (error) {
        $("#order-feedback").textContent = error.message;
        button.disabled = false;
      }
    }
  });
  document.addEventListener("submit", async (event) => {
    if (event.target.id === "search-form") {
      event.preventDefault();
      clearTimeout(searchTimer);
      state.query = $("#search").value.trim();
      renderProducts(true);
      scrollShop();
    }
    if (event.target.id === "checkout-form") {
      event.preventDefault();
      await placeOrder(event.target);
    }
    if (event.target.id === "lookup-form") {
      event.preventDefault();
      const id = $("#lookup-reference").value.trim().toUpperCase(),
        token = $("#lookup-code").value.trim();
      const button = event.target.querySelector("button");
      button.disabled = true;
      try {
        await fetchOrder(id, token);
      } catch (error) {
        $("#lookup-feedback").textContent = error.message;
      } finally {
        button.disabled = false;
      }
    }
  });
  $("#search").addEventListener("input", (event) => {
    clearTimeout(searchTimer);
    $(".search-clear").hidden = !event.target.value;
    searchTimer = setTimeout(() => {
      state.query = event.target.value.trim();
      renderProducts();
    }, 180);
  });
  $("#sort").addEventListener("change", (event) => {
    state.sort = event.target.value;
    renderProducts(true);
  });
  $("#price-filter").addEventListener("change", (event) => {
    state.maxPrice = Number(event.target.value);
    renderProducts(true);
  });
  document.addEventListener("change", (event) => {
    if (
      ["customer-pin", "customer-city", "customer-state"].includes(
        event.target.id,
      ) &&
      state.checkoutLocation?.point &&
      !locationMatchesForm(state.checkoutLocation)
    ) {
      state.checkoutLocation = null;
      paintCheckoutLocation();
    }
    if (event.target.name === "method")
      $("#place-order").innerHTML =
        `${event.target.value === "cod" ? "Confirm COD order" : "Continue to payment"} ${icon("arrow")}`;
    if (event.target.id === "customer-pin")
      $("#checkout-delivery").textContent = checkDelivery(
        event.target.value,
      ).text;
  });
  function observeReveals() {
    if (!entranceObserver) return;
    $$(
      ".category-card,.product-card,.section-intro,.shop-heading,.everyday-story,.service-strip>button",
    ).forEach((element, index) => {
      if (element.dataset.revealed) return;
      element.dataset.revealed = "queued";
      element.dataset.delay = (index % 4) * 65;
      entranceObserver.observe(element);
    });
  }
  function setupMotion() {
    if (reduced.matches || typeof IntersectionObserver !== "function") return;
    entranceObserver = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entranceObserver.unobserve(entry.target);
          entry.target.dataset.revealed = "yes";
          if (!entry.target.contains(document.activeElement))
            animate(
              entry.target,
              [
                { opacity: 0, translate: "0 26px" },
                { opacity: 1, translate: "0 0" },
              ],
              {
                duration: 650,
                delay: Number(entry.target.dataset.delay) || 0,
                easing: "cubic-bezier(.22,1,.36,1)",
                fill: "backwards",
              },
            );
        }),
      { threshold: 0.08 },
    );
    $$(".hero-reveal,.headline-line").forEach((element, i) =>
      animate(
        element,
        [
          { opacity: 0, translate: "0 24px", clipPath: "inset(0 0 100% 0)" },
          { opacity: 1, translate: "0 0", clipPath: "inset(0 0 0 0)" },
        ],
        {
          duration: 850,
          delay: i * 90,
          easing: "cubic-bezier(.22,1,.36,1)",
          fill: "backwards",
        },
      ),
    );
    animate(
      $(".hero-scene"),
      [
        { opacity: 0, clipPath: "inset(12% 8% 12% 8% round 40px)" },
        { opacity: 1, clipPath: "inset(0 0 0 0 round 8px)" },
      ],
      {
        duration: 1100,
        delay: 150,
        easing: "cubic-bezier(.22,1,.36,1)",
        fill: "backwards",
      },
    );
    $$(".scene-produce,.grocery-bag,.hero-price").forEach((element, i) =>
      animate(
        element,
        [
          { opacity: 0, translate: "0 65px", scale: 0.75 },
          { opacity: 1, translate: "0 0", scale: 1 },
        ],
        {
          duration: 1300,
          delay: 280 + i * 90,
          easing: "cubic-bezier(.16,1,.3,1)",
          fill: "backwards",
        },
      ),
    );
    observeReveals();
  }
  let pointerFrame = 0,
    scrollFrame = 0;
  $(".hero-scene").addEventListener("pointermove", (event) => {
    if (
      reduced.matches ||
      !finePointer.matches ||
      event.pointerType !== "mouse"
    )
      return;
    cancelAnimationFrame(pointerFrame);
    pointerFrame = requestAnimationFrame(() => {
      const rect = $(".hero-scene").getBoundingClientRect();
      $(".hero-scene").style.setProperty(
        "--scene-x",
        `${(event.clientX - rect.left - rect.width / 2) * 0.04}px`,
      );
      $(".hero-scene").style.setProperty(
        "--scene-y",
        `${(event.clientY - rect.top - rect.height / 2) * 0.04}px`,
      );
    });
  });
  const resetScene = () => {
    cancelAnimationFrame(pointerFrame);
    $(".hero-scene").style.removeProperty("--scene-x");
    $(".hero-scene").style.removeProperty("--scene-y");
  };
  $(".hero-scene").addEventListener("pointerleave", resetScene);
  window.addEventListener("blur", resetScene);
  window.addEventListener(
    "scroll",
    () => {
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        $(".site-header").classList.toggle("scrolled", scrollY > 20);
        if (!reduced.matches)
          $(".brand-ribbon").style.setProperty(
            "--ribbon-x",
            `${-35 - Math.min(170, scrollY * 0.12)}px`,
          );
        scrollFrame = 0;
      });
    },
    { passive: true },
  );
  reduced.addEventListener("change", () => {
    if (reduced.matches) {
      animations.forEach((a) => a.cancel());
      animations.clear();
      entranceObserver?.disconnect();
      entranceObserver = null;
      resetScene();
    } else {
      setupMotion();
    }
  });
  document.addEventListener("focusin", (event) => {
    animations.forEach((animation) => {
      if (animation.effect?.target?.contains(event.target)) animation.cancel();
    });
  });
  async function init() {
    setupMotion();
    $("#year").textContent = new Date().getFullYear();
    try {
      if (apiOrigin || !location.hostname.endsWith("github.io")) {
        try {
          state.config = await api("/api/store");
          hasAPI = true;
        } catch {
          /* Static storefronts preserve browsing and the basket when the order API is unavailable. */
        }
      }
      if (!state.config) {
        const [catalogResponse, configResponse] = await Promise.all([
          fetch("data/catalog.json", { cache: "no-cache" }),
          fetch("data/store.json", { cache: "no-cache" }),
        ]);
        if (!catalogResponse.ok || !configResponse.ok)
          throw new Error("The product selection could not be loaded.");
        const [products, config] = await Promise.all([
          catalogResponse.json(),
          configResponse.json(),
        ]);
        state.config = {
          ...config,
          products,
          checkoutEnabled: false,
          paymentMethods: [],
          paymentMode: "live",
        };
      }
      state.products = state.config.products;
      window.BlunderAICart = () => state.cart.map(i => ({productId:i.productId, variantId:i.variantId, quantity:i.quantity}));
      window.BlunderAIContext = () => ({
        checkoutEnabled: state.config.checkoutEnabled,
        currency: "INR",
        pricesIn: "paise",
        shipping: {
          standard: state.config.shipping.standard,
          freeAbove: state.config.shipping.freeAbove,
          estimate: state.config.shipping.estimate,
        },
        policies: {
          shipping: state.config.policies.shipping,
          returns: state.config.policies.returns,
        },
        products: state.products.map(
          ({ id, name, price, pack, category, description }) => ({
            id,
            name,
            price,
            pack,
            category,
            description,
          }),
        ),
      });
      const bag = read("bag", []),
        saved = read("saved", []);
      state.cart = Array.isArray(bag)
        ? bag
            .filter(
              (i) =>
                product(i?.productId)?.variants.some(
                  (v) => v.id === i.variantId,
                ) &&
                Number.isInteger(i.quantity) &&
                i.quantity > 0 &&
                i.quantity <= 10,
            )
            .slice(0, 30)
        : [];
      state.cart = state.cart.filter(
        (item, index, all) =>
          all.findIndex(
            (x) =>
              keyFor(x.productId, x.variantId) ===
              keyFor(item.productId, item.variantId),
          ) === index,
      );
      state.saved = Array.isArray(saved)
        ? [...new Set(saved.filter((id) => product(id)))]
        : [];
      const params = new URLSearchParams(location.search);
      if (
        ["Vegetables", "Fruits", "Dairy & bakery", "Pantry"].includes(
          params.get("category"),
        )
      )
        state.category = params.get("category");
      state.query = (params.get("q") || "").slice(0, 100);
      state.savedOnly = params.get("saved") === "1";
      if (["5", "10"].includes(params.get("max")))
        state.maxPrice = Number(params.get("max"));
      paintCounts();
      renderProducts();
      if (state.config.checkoutEnabled)
        $("#store-status").textContent =
          state.config.paymentMode === "test"
            ? "PAYMENT TEST MODE · NO REAL ONLINE CHARGE"
            : "YOUR EVERYDAY STORE · NOW OPEN";
      if (read("pin", ""))
        $("#delivery-label").textContent = `Delivery to ${read("pin", "")}`;
      configureLocation();
      if (params.get("product")) detail(params.get("product"));
    } catch (error) {
      $("#result-count").textContent = "We couldn’t load the shop.";
      $("#product-grid").innerHTML =
        `<p class="notice error">${esc(error.message)} Refresh the page to try again.</p>`;
    }
  }
  init();
})();
