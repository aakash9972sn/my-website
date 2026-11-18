import { StoreError } from "./commerce.mjs";

// One shared queue per server instance, including requests from different visitors.
// Explicit searches only: no public-service autocomplete or bulk tile fetching.
export function createGeocoder({
  baseURL = process.env.GEOCODER_URL || "https://nominatim.openstreetmap.org/",
  origin = process.env.PUBLIC_ORIGIN || "http://localhost:3000",
  fetchImpl = fetch,
  interval = 1100,
} = {}) {
  const base = new URL(baseURL.endsWith("/") ? baseURL : baseURL + "/");
  if (base.protocol !== "https:")
    throw new Error("GEOCODER_URL must use HTTPS.");
  const cache = new Map(),
    inflight = new Map();
  let queue = Promise.resolve(),
    nextRequest = 0,
    waiting = 0;
  function compact(value) {
    if (!value || value.lat === "" || value.lon === "") return null;
    const latitude = Number(value.lat),
      longitude = Number(value.lon);
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    )
      return null;
    const address = {};
    for (const name of [
      "house_number",
      "road",
      "pedestrian",
      "residential",
      "neighbourhood",
      "quarter",
      "suburb",
      "village",
      "city",
      "town",
      "municipality",
      "county",
      "state_district",
      "state",
      "region",
      "postcode",
      "country_code",
    ])
      if (typeof value.address?.[name] === "string")
        address[name] = value.address[name].slice(0, 100);
    return {
      lat: latitude.toFixed(6),
      lon: longitude.toFixed(6),
      display_name: String(
        value.display_name || value.name || "Selected area",
      ).slice(0, 350),
      name: String(value.name || "").slice(0, 100),
      address,
    };
  }
  function lookup(kind, input) {
    const url = new URL(kind, base);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("accept-language", "en");
    if (kind === "search") {
      if (
        typeof input?.query !== "string" ||
        input.query.trim().length < 3 ||
        input.query.trim().length > 180 ||
        /[\u0000-\u001f]/.test(input.query)
      )
        throw new StoreError(
          "Enter an area, landmark or PIN code (3–180 characters).",
        );
      url.searchParams.set("q", input.query.trim());
      url.searchParams.set("limit", "5");
      url.searchParams.set("countrycodes", "in");
    } else if (kind === "reverse") {
      if (
        typeof input?.latitude !== "number" ||
        typeof input?.longitude !== "number" ||
        !Number.isFinite(input.latitude) ||
        !Number.isFinite(input.longitude) ||
        Math.abs(input.latitude) > 90 ||
        Math.abs(input.longitude) > 180
      )
        throw new StoreError("Choose a valid map location.");
      url.searchParams.set("lat", input.latitude.toFixed(6));
      url.searchParams.set("lon", input.longitude.toFixed(6));
      url.searchParams.set("zoom", "18");
    } else throw new StoreError("Unknown map request.", 404);
    const key = url.href,
      cached = cache.get(key);
    if (cached && cached.expires > Date.now())
      return Promise.resolve(cached.value);
    if (inflight.has(key)) return inflight.get(key);
    if (waiting >= 8)
      throw new StoreError(
        "Address search is busy. Please retry shortly or enter your address manually.",
        429,
      );
    waiting += 1;
    const run = async () => {
      const pause = Math.max(0, nextRequest - Date.now());
      if (pause) await new Promise((resolve) => setTimeout(resolve, pause));
      nextRequest = Date.now() + interval;
      let response;
      try {
        response = await fetchImpl(url, {
          signal: AbortSignal.timeout(8000),
          headers: {
            Accept: "application/json",
            "User-Agent": `BlunderStore/2.1 (+${origin})`,
          },
        });
      } catch {
        throw new StoreError(
          "Address lookup is unavailable. You can still enter your address manually.",
          502,
        );
      }
      if (!response.ok)
        throw new StoreError(
          "Address lookup is unavailable. Please retry later or type your address.",
          response.status === 429 ? 429 : 502,
        );
      let data;
      try {
        data = await response.json();
      } catch {
        throw new StoreError(
          "Address lookup returned an invalid response. Please enter your address manually.",
          502,
        );
      }
      const result =
        kind === "search"
          ? Array.isArray(data)
            ? data.slice(0, 5).map(compact).filter(Boolean)
            : []
          : compact(data);
      if (cache.size >= 200) cache.delete(cache.keys().next().value);
      cache.set(key, { expires: Date.now() + 3600000, value: result });
      return result;
    };
    const pending = queue.then(run, run).finally(() => {
      waiting -= 1;
      inflight.delete(key);
    });
    queue = pending.catch(() => {});
    inflight.set(key, pending);
    return pending;
  }
  return { lookup };
}
