// Google Maps preview is embedded in the delivery dialog without a Maps Platform API key.
// Address search and reverse lookup remain Nominatim-based; full Google Places
// autocomplete, distance matrix and live ETA require separate enabled APIs.
// Keep these endpoints for the existing address-to-checkout workflow.
window.BLUNDER_MAPS = {
  searchUrl: "https://nominatim.openstreetmap.org/search",
  reverseUrl: "https://nominatim.openstreetmap.org/reverse",
};
// Leave blank when this site and its API run on the same Node server.
// For GitHub Pages, set the HTTPS URL of your deployed backend, without /api.
window.BLUNDER_API_ORIGIN = "";


// Optional public URL of YOUR deployed Node backend, never an API key.
// On GitHub Pages you must set this to the HTTPS origin of your Node deployment.
// Leave blank only when served from the same Node server.
window.BLUNDER_AI_API_ORIGIN = "";
