# Map stack evaluation

The user identified the map in `agentic-krn-compiler` as a successful responsive reference. Inspection of its static review map and generator confirms Leaflet 1.9.4 with OpenStreetMap raster tiles, plain JavaScript, a persistent map instance, scrollable sidebar and a narrow-screen CSS breakpoint. These are useful design precedents; the collision observatory should not add framework work to every pan or zoom.

Leaflet remains a credible alternative, especially for straightforward raster maps and modest vector overlays. Its Canvas renderer avoids separate SVG paths, but scalable point clustering requires an additional implementation or library. MapLibre supplies styled point layers and GeoJSON clustering directly, at the cost of a larger bundle and a WebGL requirement. React can manage the filters and derived summaries without owning individual map points. Neither React nor MapLibre alone guarantees responsiveness.

The implementation decision must therefore be supported by a full regional dataset browser check, a stable map instance across filter changes, no per-collision DOM elements, and a usable narrow-screen layout. Keep metric concentration grouping independent from screen-space display clustering and from map movement. Exchange with KRN/SATN is through GeoJSON and domain identifiers, not a shared rendering framework.

Primary technical references:

- [Leaflet reference: Canvas and map options](https://leafletjs.com/reference)
- [MapLibre: optimizing large GeoJSON datasets](https://maplibre.org/maplibre-gl-js/docs/guides/large-data/)
- [MapLibre: create and style clusters](https://maplibre.org/maplibre-gl-js/docs/examples/create-and-style-clusters/)

Final choice and measured checks are recorded in the README and verification report when the running implementation is available.

## Selected implementation

Use React + TypeScript + Vite for controls and static packaging, and MapLibre GL JS for the map. React does not render a component or DOM marker per collision. MapLibre renders points and cluster counts as layers and handles display clustering. The map has a stable lifetime; domain filtering and metre-based analysis are memoized separately from panning. Raster OpenStreetMap tiles supply context without an API key.

This retains the prompt's preferred stack after critically comparing the working Leaflet reference. The justification is built-in layer styling and point clustering plus a clear GeoJSON path for future corridor overlays. The tradeoffs are a larger initial JavaScript payload and a WebGL requirement; Leaflet would remain a reasonable alternative for a simpler viewer or WebGL-constrained devices. This is not a claim that MapLibre is universally faster than Leaflet.

Browser verification uses the actual 8,033-record regional snapshot. Initial testing exposed and corrected an unconstrained desktop map height, illustrating why passing a build is not evidence of responsiveness. At 390px width the map remains above the longer panels and the page does not overflow horizontally. Metric grouping was measured separately from rendering; timings are machine-specific and recorded in the verification report after final fixes.
