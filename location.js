"use strict";
(() => {
  const $ = (selector) => document.querySelector(selector);
  const dialog = $("#delivery-dialog");
  const fieldIds = {
    address: "location-address",
    city: "location-city",
    state: "location-state",
    pincode: "delivery-pin",
  };
  const settings = window.BLUNDER_MAPS || {};
  const cache = new Map();
  let mapLoaded = false,
    previewQuery = "Delhi Technological University, Delhi, India",
    point = null,
    selected = null;
  let boundArea = {},
    callbacks = {},
    sequence = 0,
    controller = null,
    nextRequestAt = 0,
    queue = Promise.resolve();

  function validPoint(value) {
    return (
      value &&
      typeof value.latitude === "number" &&
      typeof value.longitude === "number" &&
      Number.isFinite(value.latitude) &&
      Number.isFinite(value.longitude) &&
      Math.abs(value.latitude) <= 90 &&
      Math.abs(value.longitude) <= 180
    );
  }
  function cleanSelection(value) {
    if (!value || !/^[1-9]\d{5}$/.test(value.pincode)) return null;
    const result = {};
    for (const [name, limit] of [
      ["address", 220],
      ["city", 80],
      ["state", 80],
      ["pincode", 6],
    ]) {
      if (
        typeof value[name] !== "string" ||
        value[name].trim().replace(/\s+/g, " ").length > limit ||
        /[\u0000-\u0008\u000e-\u001f]/.test(value[name])
      )
        return null;
      result[name] = value[name].trim().replace(/\s+/g, " ");
    }
    result.point = validPoint(value.point)
      ? {
          latitude: Number(value.point.latitude.toFixed(6)),
          longitude: Number(value.point.longitude.toFixed(6)),
        }
      : null;
    return result;
  }
  try {
    selected = cleanSelection(
      JSON.parse(sessionStorage.getItem("blunder:delivery-location")),
    );
  } catch {
    /* Private tabs may not allow storage. */
  }
  function getSelection() {
    return selected
      ? { ...selected, point: selected.point ? { ...selected.point } : null }
      : null;
  }
  function status(message) {
    $("#location-status").textContent = message;
  }
  function busy(value) {
    $("#location-search-button").disabled = value;
    $("#location-gps").disabled = value;
    $("#location-confirm").disabled = value;
    $("#location-search-form").setAttribute("aria-busy", String(value));
  }
  function cancelPending() {
    sequence += 1;
    controller?.abort();
    controller = null;
    busy(false);
  }
  function fields() {
    return Object.fromEntries(
      Object.entries(fieldIds).map(([name, id]) => [
        name,
        $("#" + id).value.trim(),
      ]),
    );
  }
  function setFields(value = {}) {
    boundArea = {
      city: value.city || "",
      state: value.state || "",
      pincode: value.pincode || "",
    };
    for (const [name, id] of Object.entries(fieldIds))
      $("#" + id).value = value[name] || "";
    $("#delivery-result").textContent = "";
  }
  // Keyless Google Maps share-style iframe. It is VIEW-ONLY for our checkout:
  // cross-origin iframe interaction cannot supply a selected point or Places data.
  function googleMapUrl(query, zoom = 14) {
    return "https://maps.google.com/maps?q=" +
      encodeURIComponent(String(query || "Delhi Technological University, Delhi, India").slice(0, 180)) +
      "&z=" + (zoom === 16 ? "16" : "14") + "&hl=en&output=embed";
  }
  function googleSearchUrl(query) {
    return "https://www.google.com/maps/search/?api=1&query=" +
      encodeURIComponent(String(query || "Delhi Technological University, Delhi, India").slice(0, 180));
  }
  function googleRouteUrl(location) {
    return "https://www.google.com/maps/dir/?api=1&destination=" +
      encodeURIComponent(location.latitude.toFixed(6) + "," + location.longitude.toFixed(6));
  }
  function showPreview(query, zoom = 14) {
    previewQuery = String(query || "Delhi Technological University, Delhi, India").slice(0, 180);
    const frame = $("#delivery-map");
    if (!mapLoaded) return;
    const nextUrl = googleMapUrl(previewQuery, zoom);
    if (frame.getAttribute("src") !== nextUrl) frame.setAttribute("src", nextUrl);
    $("#location-centre").href = googleSearchUrl(previewQuery);
    $("#map-unavailable").hidden = true;
  }
  function updatePoint(next, move = true) {
    point = validPoint(next)
      ? {
          latitude: Number(next.latitude.toFixed(6)),
          longitude: Number(next.longitude.toFixed(6)),
        }
      : null;
    $("#location-coordinates").hidden = !point;
    $("#location-coordinates").textContent = point
      ? "Selected delivery point · " + point.latitude.toFixed(5) + ", " + point.longitude.toFixed(5)
      : "";
    const route = $("#location-route");
    route.hidden = !point;
    if (point) {
      route.href = googleRouteUrl(point);
      if (move) showPreview(point.latitude + "," + point.longitude, 16);
    }
  }
  function ensureMap() {
    if (mapLoaded) return;
    mapLoaded = true;
    showPreview(previewQuery);
  }
  function normalise(raw) {
    if (!raw || raw.lat === "" || raw.lon === "") return null;
    const location = { latitude: Number(raw.lat), longitude: Number(raw.lon) };
    if (!validPoint(location)) return null;
    const address =
      raw.address && typeof raw.address === "object" ? raw.address : {};
    const unique = (values) => [
      ...new Set(
        values
          .filter((value) => typeof value === "string" && value.trim())
          .map((value) => value.trim()),
      ),
    ];
    const street = unique([
      address.house_number,
      address.road || address.pedestrian || address.residential,
      address.neighbourhood || address.quarter,
      address.suburb || address.village,
    ]).join(", ");
    const city =
      address.city ||
      address.town ||
      address.village ||
      address.municipality ||
      address.county ||
      address.state_district ||
      "";
    const postal =
      String(address.postcode || "").match(/\b[1-9]\d{5}\b/)?.[0] || "";
    return {
      point: location,
      label: String(
        raw.display_name || raw.name || street || "Selected map point",
      ).slice(0, 350),
      address: (street || String(raw.name || "")).slice(0, 220),
      city: String(city).slice(0, 80),
      state: String(address.state || address.region || "").slice(0, 80),
      pincode:
        String(address.country_code || "in").toLowerCase() === "in"
          ? postal
          : "",
    };
  }
  async function directRequest(kind, payload, signal) {
    const url = new URL(
      kind === "search"
        ? settings.searchUrl || "https://nominatim.openstreetmap.org/search"
        : settings.reverseUrl || "https://nominatim.openstreetmap.org/reverse",
    );
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("accept-language", "en");
    if (kind === "search") {
      url.searchParams.set("q", payload.query);
      url.searchParams.set("countrycodes", "in");
      url.searchParams.set("limit", "5");
    } else {
      url.searchParams.set("lat", payload.latitude);
      url.searchParams.set("lon", payload.longitude);
      url.searchParams.set("zoom", "18");
    }
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal,
      referrerPolicy: "strict-origin-when-cross-origin",
    });
    if (!response.ok)
      throw new Error(
        response.status === 429
          ? "Address search is busy. Please wait a moment or enter your address manually."
          : "Address search is unavailable. You can still choose a map point and type your address.",
      );
    return response.json();
  }
  function request(kind, payload, signal) {
    const key = JSON.stringify([kind, payload]);
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < 3600000)
      return Promise.resolve(cached.value);
    const work = async () => {
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const wait = Math.max(0, nextRequestAt - Date.now());
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      nextRequestAt = Date.now() + 1100;
      const value = callbacks.request
        ? await callbacks.request(kind, payload, signal)
        : await directRequest(kind, payload, signal);
      if (cache.size >= 100) cache.delete(cache.keys().next().value);
      cache.set(key, { at: Date.now(), value });
      return value;
    };
    const result = queue.then(work, work);
    queue = result.catch(() => {});
    return result;
  }
  function beginRequest() {
    cancelPending();
    controller = new AbortController();
    return {
      id: sequence,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(14000)]),
    };
  }
  function showAvailability() {
    const pin = $("#delivery-pin");
    if (!pin.reportValidity()) return null;
    const result = callbacks.checkAvailability?.(pin.value.trim()) || {
      valid: false,
      text: "Delivery will be confirmed before ordering.",
    };
    $("#delivery-result").textContent = result.text;
    $("#delivery-result").dataset.available = String(
      result.available ?? result.valid,
    );
    return result;
  }
  async function choosePoint(next) {
    if (!validPoint(next) || !dialog.open) return;
    const operation = beginRequest();
    updatePoint(next);
    setFields();
    $("#location-results").hidden = true;
    status("Finding the address for your delivery pin…");
    busy(true);
    try {
      const result = normalise(
        await request("reverse", point, operation.signal),
      );
      if (operation.id !== sequence || !dialog.open) return;
      if (result) {
        setFields(result);
        status(
          result.pincode
            ? "Pin selected. Check the address and add your house or flat number."
            : "Pin selected. Enter the missing address details and the delivery PIN code.",
        );
      } else
        status(
          "Pin selected. We couldn’t find an address here; please enter it manually.",
        );
    } catch (error) {
      if (
        operation.id === sequence &&
        dialog.open &&
        error.name !== "AbortError"
      )
        status(
          "Your pin is selected. Address lookup is unavailable; please enter the address and PIN manually.",
        );
    } finally {
      if (operation.id === sequence) {
        busy(false);
        if ($("#delivery-pin").value) showAvailability();
      }
    }
  }
  async function search(event) {
    event.preventDefault();
    const query = $("#location-search").value.trim();
    if (query.length < 3) return;
    const operation = beginRequest();
    busy(true);
    const results = $("#location-results");
    results.replaceChildren();
    results.hidden = true;
    showPreview(query);
    status("Showing the area in Google Maps and looking up matching addresses…");
    try {
      const response = await request("search", { query }, operation.signal);
      if (operation.id !== sequence || !dialog.open) return;
      const matches = Array.isArray(response)
        ? response.slice(0, 5).map(normalise).filter(Boolean)
        : [];
      if (!matches.length) {
        status(
          "No matching areas found. Try a nearby landmark or enter your address manually.",
        );
        return;
      }
      for (const match of matches) {
        const li = document.createElement("li"),
          button = document.createElement("button"),
          label = document.createElement("span"),
          strong = document.createElement("b"),
          small = document.createElement("small");
        button.type = "button";
        strong.textContent = match.address || match.city || "Selected area";
        small.textContent = match.label;
        label.append(strong, small);
        button.append(label);
        li.append(button);
        results.append(li);
        button.addEventListener("click", () => {
          cancelPending();
          updatePoint(match.point);
          setFields(match);
          results.hidden = true;
          status(
            "Area selected. Google Maps previews this point; confirm your house / flat number below.",
          );
          if (match.pincode) showAvailability();
          $("#location-address").focus({ preventScroll: true });
        });
      }
      results.hidden = false;
      status(
        `${matches.length} matching area${matches.length === 1 ? "" : "s"}. Select a result to fill your delivery address.`,
      );
    } catch (error) {
      if (operation.id === sequence && dialog.open)
        status(
          ["AbortError", "TimeoutError"].includes(error.name)
            ? "Address search timed out. Please retry or enter your address manually."
            : error.message,
        );
    } finally {
      if (operation.id === sequence) busy(false);
    }
  }
  function locate() {
    if (!navigator.geolocation || !window.isSecureContext) {
      status(
        "Current location needs a secure browser connection. Search for your area or enter the address manually.",
      );
      return;
    }
    cancelPending();
    const id = sequence;
    busy(true);
    status("Waiting for your browser’s location permission…");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (id !== sequence || !dialog.open) return;
        busy(false);
        choosePoint({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
      },
      (error) => {
        if (id !== sequence || !dialog.open) return;
        busy(false);
        status(
          error.code === 1
            ? "Location access was denied. You can allow it in browser settings, search for your area, or enter your address manually."
            : error.code === 3
              ? "Your location took too long to arrive. Try again or search for your area."
              : "Your current location is unavailable. Search for your area or type your address.",
        );
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    );
  }
  function open(seed) {
    cancelPending();
    const initial = seed ||
      selected || { pincode: callbacks.readPin?.() || "" };
    setFields(initial);
    $("#location-search").value = "";
    $("#location-results").hidden = true;
    status("Search and select an address, use GPS or enter delivery details manually. The Google Maps preview does not fill the address when tapped.");
    ensureMap();
    updatePoint(initial.point || null);
    if (point) showPreview(point.latitude + "," + point.longitude, 16);
    else if (initial.city || initial.address) showPreview([initial.address, initial.city, initial.state].filter(Boolean).join(", "));
    else showPreview("Delhi Technological University, Delhi, India");
    if (initial.pincode) showAvailability();
  }
  function confirm(event) {
    event.preventDefault();
    if (!$("#delivery-form").reportValidity()) return;
    showAvailability();
    selected = cleanSelection({ ...fields(), point });
    if (!selected) return;
    try {
      sessionStorage.setItem(
        "blunder:delivery-location",
        JSON.stringify(selected),
      );
    } catch {
      /* Keep the current tab's in-memory choice. */
    }
    callbacks.onSelect?.(getSelection(), "confirm");
  }
  function clear() {
    cancelPending();
    selected = null;
    updatePoint(null);
    setFields();
    try {
      sessionStorage.removeItem("blunder:delivery-location");
    } catch {
      /* No persisted choice. */
    }
    showPreview("Delhi Technological University, Delhi, India");
    status("Location cleared. Search a place or enter your address.");
    callbacks.onSelect?.(null, "clear");
  }
  $("#location-search-form").addEventListener("submit", search);
  $("#delivery-form").addEventListener("submit", confirm);
  $("#location-gps").addEventListener("click", locate);
  document.querySelectorAll("[data-location-preset]").forEach(button => {
    button.addEventListener("click", () => {
      const query = button.dataset.locationPreset;
      $("#location-search").value = query;
      showPreview(query);
      search({ preventDefault() {} });
    });
  });
  $("#location-check-pin").addEventListener("click", showAvailability);
  $("#location-clear").addEventListener("click", clear);
  for (const [name, id] of Object.entries(fieldIds))
    $("#" + id).addEventListener("input", () => {
      cancelPending();
      if (
        name !== "address" &&
        point &&
        boundArea[name] &&
        $("#" + id)
          .value.trim()
          .toLowerCase() !== boundArea[name].trim().toLowerCase()
      ) {
        updatePoint(null);
        status(
          "The delivery area changed. Choose a new map pin, or continue with the typed address.",
        );
      }
      $("#delivery-result").textContent = "";
    });
  dialog.addEventListener("close", cancelPending);
  window.BlunderLocation = {
    configure: (options) => {
      callbacks = options;
    },
    open,
    getSelection,
  };
})();
