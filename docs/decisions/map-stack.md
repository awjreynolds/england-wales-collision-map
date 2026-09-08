# Map stack evaluation

The user identified the map in `agentic-krn-compiler` as a successful responsive reference. Inspection of its static review map and generator confirms Leaflet 1.9.4 with OpenStreetMap raster tiles, plain JavaScript, a persistent map instance, scrollable sidebar and a narrow-screen CSS breakpoint. These are useful design precedents; the collision observatory should not add framework work to every pan or zoom.

Leaflet remains a credible alternative, especially for straightforward raster maps and modest vector overlays. Its Canvas renderer avoids separate SVG paths, but scalable point clustering requires an additional implementation or library. MapLibre supplies styled point layers and GeoJSON clustering directly, at the cost of a larger bundle and a WebGL requirement. React can manage the filters and derived summaries without owning individual map points. Neither React nor MapLibre alone guarantees responsiveness.

The implementation decision must therefore be supported by a full regional dataset browser check, a stable map instance across filter changes, no per-collision DOM elements, and a usable narrow-screen layout. Keep metric concentration grouping independent from screen-space display clustering and from map movement. Exchange with KRN/SATN is through GeoJSON and domain identifiers, not a shared rendering framework.

Primary technical references:

- [Leaflet reference: Canvas and map options](https://leafletjs.com/reference)
- [MapLibre: optimizing large GeoJSON datasets](https://maplibre.org/maplibre-gl-js/docs/guides/large-data/)
- [MapLibre: create and style clusters](https://maplibre.org/maplibre-gl-js/docs/examples/create-and-style-clusters/)

Final choice and measured checks are recorded in the README and verification report when the running implementation is available.
