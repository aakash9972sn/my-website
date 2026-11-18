// Leave blank when this site and its API run on the same Node server.
// For GitHub Pages, set the HTTPS URL of your deployed backend, without /api.
window.BLUNDER_API_ORIGIN = "";

// OpenStreetMap defaults are suitable for a small, low-traffic storefront.
// For a larger launch, configure licensed tiles and a Nominatim-compatible
// geocoder (also update the server CSP for any new browser-facing origins).
window.BLUNDER_MAPS = {
  tileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  searchUrl: "https://nominatim.openstreetmap.org/search",
  reverseUrl: "https://nominatim.openstreetmap.org/reverse",
};
