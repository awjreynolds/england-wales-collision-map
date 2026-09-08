import { useEffect, useRef } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type StyleSpecification } from 'maplibre-gl';
import type { AnalysisGroup, BBox, CollisionDetail, DatasetManifest, SchoolRecord, ViewPayload } from '../../service/contract';
import { pointFeatureToGeoJson } from '../app/data';
import { SEVERITY_STYLES } from '../domain/config';
import 'maplibre-gl/dist/maplibre-gl.css';

interface MapViewProps {
  view: ViewPayload | null;
  manifest: DatasetManifest;
  initialBBox: BBox | null;
  initialZoom: number;
  schools: SchoolRecord[];
  analysisGroups: AnalysisGroup[];
  resetSignal: number;
  focusBBox: BBox | null;
  selectedCollisionId: string | null;
  selectedPoint: [number, number] | null;
  selectedAnalysisGroup: AnalysisGroup | null;
  detail: CollisionDetail | null;
  onBoundsChange: (bbox: BBox, zoom: number) => void;
  onAggregateClick: (bbox: BBox) => void;
  onCollisionClick: (id: string, point: [number, number]) => void;
  onAnalysisGroupClick: (group: AnalysisGroup) => void;
  onPopupClose: () => void;
  onSchoolClick: (school: SchoolRecord) => void;
}

const MAP_STYLE: StyleSpecification = {
  version: 8,
  sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '&copy; OpenStreetMap contributors' } },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

const emptyCollection = (): GeoJSON.FeatureCollection<GeoJSON.Point, Record<string, unknown>> => ({ type: 'FeatureCollection', features: [] });
const analysisGeoJson = (groups: AnalysisGroup[]): GeoJSON.FeatureCollection<GeoJSON.Point, Record<string, unknown>> => ({
  type: 'FeatureCollection',
  features: groups.map((group) => ({ type: 'Feature', id: group.id, geometry: { type: 'Point', coordinates: [group.anchor.longitude, group.anchor.latitude] }, properties: { ...group, kind: 'analysis' } as unknown as Record<string, unknown> })),
});
const schoolsGeoJson = (schools: SchoolRecord[]): GeoJSON.FeatureCollection<GeoJSON.Point, Record<string, unknown>> => ({
  type: 'FeatureCollection',
  features: schools.map((school) => ({ type: 'Feature', id: school.id, geometry: { type: 'Point', coordinates: [school.longitude, school.latitude] }, properties: school as unknown as Record<string, unknown> })),
});
const addDetail = (root: HTMLElement, label: string, value: unknown): void => {
  if (value === null || value === undefined || value === '') return;
  const row = document.createElement('div'); row.className = 'popup-row';
  const dt = document.createElement('dt'); dt.textContent = label;
  const dd = document.createElement('dd'); dd.textContent = String(value);
  row.append(dt, dd); root.append(row);
};
const detailPopup = (detail: CollisionDetail): HTMLElement => {
  const root = document.createElement('article'); root.className = 'map-popup';
  const title = document.createElement('h3'); title.textContent = detail.roadName ?? 'Reported collision'; root.append(title);
  const list = document.createElement('dl');
  addDetail(list, 'Date', detail.date ?? detail.year);
  addDetail(list, 'Severity', detail.severity[0].toUpperCase() + detail.severity.slice(1));
  addDetail(list, 'Authority', detail.authorityName ?? detail.authorityCode);
  addDetail(list, 'Casualties', detail.casualtyCount);
  addDetail(list, 'Fatalities', detail.fatalities);
  addDetail(list, 'Seriously injured', detail.seriousCasualties);
  addDetail(list, 'Road', detail.roadNumber ? `${detail.roadNumber}${detail.roadName ? ` · ${detail.roadName}` : ''}` : detail.roadName);
  root.append(list); return root;
};
const nullableMetric = (metric: { value: number | null; unknownRecords: number }): string => {
  if (metric.value === null) return metric.unknownRecords ? `Not recorded (${metric.unknownRecords})` : 'Not recorded';
  return metric.unknownRecords ? `${metric.value} (${metric.unknownRecords} not recorded)` : String(metric.value);
};
const analysisGroupPopup = (group: AnalysisGroup): HTMLElement => {
  const root = document.createElement('article'); root.className = 'map-popup';
  const title = document.createElement('h3'); title.textContent = 'Persistent collision location'; root.append(title);
  const list = document.createElement('dl');
  addDetail(list, 'Recurrence', `${group.collisions} collisions across ${group.yearsRepresented.join(', ')}`);
  addDetail(list, 'Collision harm', `${group.harm.collisionSeverity.fatal} fatal · ${group.harm.collisionSeverity.serious} serious · ${group.harm.collisionSeverity.slight} slight`);
  addDetail(list, 'KSI collisions', group.harm.ksiCollisions);
  addDetail(list, 'Casualties', nullableMetric(group.harm.casualties.total));
  addDetail(list, 'Fatalities', nullableMetric(group.harm.casualties.fatalities));
  addDetail(list, 'Seriously injured', nullableMetric(group.harm.casualties.serious));
  addDetail(list, 'Slightly injured', nullableMetric(group.harm.casualties.slight));
  const nearest = group.schoolProximity.nearestSchool;
  addDetail(list, 'Nearest listed school', nearest ? `${Math.round(nearest.distanceMetres)}m · ${nearest.school.name}` : 'No listed school within 1km');
  root.append(list);
  const note = document.createElement('p'); note.className = 'popup-note'; note.textContent = 'School distance is measured from the group anchor. The whole group may extend beyond the anchor radius.'; root.append(note);
  return root;
};
const mapBBox = (map: MapLibreMap): BBox => { const b = map.getBounds(); return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() }; };
const propertyBBox = (value: unknown): BBox | null => {
  const candidate = typeof value === 'string' ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })() : value;
  if (!candidate || typeof candidate !== 'object') return null;
  const bbox = candidate as Partial<BBox>;
  return [bbox.west, bbox.south, bbox.east, bbox.north].every((item) => typeof item === 'number' && Number.isFinite(item)) ? { west: bbox.west!, south: bbox.south!, east: bbox.east!, north: bbox.north! } : null;
};
const ensureSource = (map: MapLibreMap, id: string, data: GeoJSON.GeoJSON, options?: Record<string, unknown>): void => {
  if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data, ...(options ?? {}) } as maplibregl.GeoJSONSourceSpecification);
};
type PendingCameraAction = { kind: 'reset'; order: number } | { kind: 'focus'; order: number; bbox: BBox };

export const MapView = ({ view, manifest, initialBBox, initialZoom, schools, analysisGroups, resetSignal, focusBBox, selectedCollisionId, selectedPoint, selectedAnalysisGroup, detail, onBoundsChange, onAggregateClick, onCollisionClick, onAnalysisGroupClick, onPopupClose, onSchoolClick }: MapViewProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const readyRef = useRef(false);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const popupCloseHandlerRef = useRef<(() => void) | null>(null);
  const callbacks = useRef({ onBoundsChange, onAggregateClick, onCollisionClick, onAnalysisGroupClick, onPopupClose, onSchoolClick });
  callbacks.current = { onBoundsChange, onAggregateClick, onCollisionClick, onAnalysisGroupClick, onPopupClose, onSchoolClick };
  const schoolsRef = useRef(schools);
  schoolsRef.current = schools;
  const viewRef = useRef(view);
  viewRef.current = view;
  const analysisRef = useRef(analysisGroups);
  analysisRef.current = analysisGroups;
  const selectedPointRef = useRef(selectedPoint);
  selectedPointRef.current = selectedPoint;
  const pendingCameraActionRef = useRef<PendingCameraAction | null>(null);

  useEffect(() => {
    if (resetSignal === 0) return;
    const order = (pendingCameraActionRef.current?.order ?? 0) + 1;
    pendingCameraActionRef.current = { kind: 'reset', order };
  }, [resetSignal]);
  useEffect(() => {
    if (!focusBBox) return;
    const order = (pendingCameraActionRef.current?.order ?? 0) + 1;
    pendingCameraActionRef.current = { kind: 'focus', order, bbox: focusBBox };
  }, [focusBBox]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined;
    const camera = initialBBox ?? manifest.extent;
    const map = new maplibregl.Map({ container: containerRef.current, style: MAP_STYLE, center: [(camera.west + camera.east) / 2, (camera.south + camera.north) / 2], zoom: initialZoom, minZoom: 3, maxZoom: 18, attributionControl: false, dragRotate: false, pitchWithRotate: false, cooperativeGestures: false });
    mapRef.current = map; map.touchZoomRotate.disableRotation(); map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right'); map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    const report = () => callbacks.current.onBoundsChange(mapBBox(map), map.getZoom());
    map.on('load', () => {
      ensureSource(map, 'view', emptyCollection(), { cluster: false });
      ensureSource(map, 'analysis', analysisGeoJson([]));
      ensureSource(map, 'schools', schoolsGeoJson([]));
      const viewSource = map.getSource('view') as GeoJSONSource | undefined;
      if (viewSource && viewRef.current) viewSource.setData(pointFeatureToGeoJson(viewRef.current));
      const analysisSource = map.getSource('analysis') as GeoJSONSource | undefined;
      if (analysisSource) analysisSource.setData(analysisGeoJson(analysisRef.current));
      const schoolSource = map.getSource('schools') as GeoJSONSource | undefined;
      if (schoolSource) schoolSource.setData(schoolsGeoJson(schoolsRef.current));
      map.addLayer({ id: 'analysis-ring', type: 'circle', source: 'analysis', paint: { 'circle-color': '#6d28d9', 'circle-radius': ['interpolate', ['linear'], ['get', 'collisions'], 3, 9, 10, 16, 25, 26], 'circle-opacity': .22, 'circle-stroke-color': '#5b21b6', 'circle-stroke-width': 2 } });
      map.addLayer({ id: 'analysis-label', type: 'symbol', source: 'analysis', layout: { 'text-field': ['to-string', ['get', 'collisions']], 'text-size': 11 }, paint: { 'text-color': '#4c1d95' } });
      map.addLayer({ id: 'school-points', type: 'circle', source: 'schools', layout: { visibility: map.getZoom() >= 8 ? 'visible' : 'none' }, paint: { 'circle-color': '#2563eb', 'circle-radius': 5.5, 'circle-stroke-color': '#dbeafe', 'circle-stroke-width': 2, 'circle-opacity': .9 } });
      map.addLayer({ id: 'aggregate-points', type: 'circle', source: 'view', filter: ['==', ['get', 'kind'], 'aggregate'], paint: { 'circle-color': '#244b69', 'circle-radius': ['interpolate', ['linear'], ['get', 'count'], 1, 6, 20, 13, 100, 22, 1000, 30], 'circle-opacity': .78, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } });
      map.addLayer({ id: 'aggregate-label', type: 'symbol', source: 'view', filter: ['==', ['get', 'kind'], 'aggregate'], layout: { 'text-field': ['to-string', ['get', 'count']], 'text-size': 11 }, paint: { 'text-color': '#fff' } });
      map.addLayer({ id: 'collision-points', type: 'circle', source: 'view', filter: ['==', ['get', 'kind'], 'collision'], paint: { 'circle-color': ['match', ['get', 'severity'], 'fatal', SEVERITY_STYLES.fatal.colour, 'serious', SEVERITY_STYLES.serious.colour, 'slight', SEVERITY_STYLES.slight.colour, SEVERITY_STYLES.unknown.colour], 'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 3.5, 12, 5, 18, 7], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1, 'circle-opacity': .9 } });
      readyRef.current = true;
      const pendingCameraAction = pendingCameraActionRef.current;
      if (pendingCameraAction?.kind === 'reset') {
        map.fitBounds([[manifest.extent.west, manifest.extent.south], [manifest.extent.east, manifest.extent.north]], { padding: 36, maxZoom: 8, duration: 0 });
      } else if (pendingCameraAction?.kind === 'focus') {
        const pendingFocus = pendingCameraAction.bbox;
        map.fitBounds([[pendingFocus.west, pendingFocus.south], [pendingFocus.east, pendingFocus.north]], { padding: 80, maxZoom: 16, duration: 0 });
      }
      report();
    });
    map.on('moveend', () => { report(); if (map.getLayer('school-points')) map.setLayoutProperty('school-points', 'visibility', map.getZoom() >= 8 ? 'visible' : 'none'); });
    map.on('click', (event) => {
      const features = map.queryRenderedFeatures(event.point, { layers: ['school-points', 'analysis-ring', 'analysis-label', 'collision-points', 'aggregate-points'] });
      const feature = features[0]; if (!feature || feature.geometry.type !== 'Point') return;
      const point = feature.geometry.coordinates as [number, number];
      if (feature.layer?.id === 'school-points') {
        const id = String(feature.properties?.id ?? feature.id ?? ''); const school = schoolsRef.current.find((candidate) => candidate.id === id); if (school) callbacks.current.onSchoolClick(school); return;
      }
      if (feature.layer?.id === 'aggregate-points') {
        const bbox = propertyBBox(feature.properties?.bbox); if (bbox) callbacks.current.onAggregateClick(bbox); return;
      }
      if (feature.layer?.id === 'analysis-ring' || feature.layer?.id === 'analysis-label') {
        const id = String(feature.properties?.id ?? feature.id ?? '');
        const group = analysisRef.current.find((candidate) => candidate.id === id);
        if (group) callbacks.current.onAnalysisGroupClick(group);
        return;
      }
      const id = String(feature.properties?.id ?? feature.id ?? ''); if (id) callbacks.current.onCollisionClick(id, point);
    });
    for (const layer of ['school-points', 'analysis-ring', 'analysis-label', 'collision-points', 'aggregate-points']) { map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; }); map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; }); }
    return () => { const popup = popupRef.current; if (popup && popupCloseHandlerRef.current) popup.off('close', popupCloseHandlerRef.current); popupCloseHandlerRef.current = null; popupRef.current = null; popup?.remove(); map.remove(); mapRef.current = null; readyRef.current = false; };
  }, [manifest.extent, initialBBox, initialZoom]);

  useEffect(() => {
    const map = mapRef.current; if (!map || !readyRef.current) return;
    const source = map.getSource('view') as GeoJSONSource | undefined; if (source && view) source.setData(pointFeatureToGeoJson(view));
  }, [view]);
  useEffect(() => { const map = mapRef.current; if (!map || !readyRef.current) return; const source = map.getSource('analysis') as GeoJSONSource | undefined; source?.setData(analysisGeoJson(analysisGroups)); }, [analysisGroups]);
  useEffect(() => { const map = mapRef.current; if (!map || !readyRef.current) return; const source = map.getSource('schools') as GeoJSONSource | undefined; source?.setData(schoolsGeoJson(schools)); }, [schools]);
  useEffect(() => { const map = mapRef.current; if (!map || !readyRef.current || resetSignal === 0) return; map.fitBounds([[manifest.extent.west, manifest.extent.south], [manifest.extent.east, manifest.extent.north]], { padding: 36, maxZoom: 8, duration: 650 }); }, [resetSignal, manifest.extent]);
  useEffect(() => { const map = mapRef.current; if (!map || !readyRef.current || !focusBBox) return; map.fitBounds([[focusBBox.west, focusBBox.south], [focusBBox.east, focusBBox.north]], { padding: 80, maxZoom: 16, duration: 650 }); }, [focusBBox]);
  useEffect(() => {
    const map = mapRef.current; if (!map || !readyRef.current) return;
    const oldPopup = popupRef.current;
    if (oldPopup && popupCloseHandlerRef.current) oldPopup.off('close', popupCloseHandlerRef.current);
    popupCloseHandlerRef.current = null; popupRef.current = null; oldPopup?.remove();
    if (selectedAnalysisGroup) {
      const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '350px' }).setLngLat([selectedAnalysisGroup.anchor.longitude, selectedAnalysisGroup.anchor.latitude]).setDOMContent(analysisGroupPopup(selectedAnalysisGroup));
      const closeHandler = () => { popupRef.current = null; popupCloseHandlerRef.current = null; callbacks.current.onPopupClose(); };
      popup.on('close', closeHandler); popupCloseHandlerRef.current = closeHandler; popupRef.current = popup.addTo(map);
      return;
    }
    if (detail && selectedCollisionId && selectedPointRef.current) {
      const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '330px' }).setLngLat(selectedPointRef.current).setDOMContent(detailPopup(detail));
      const closeHandler = () => { popupRef.current = null; popupCloseHandlerRef.current = null; callbacks.current.onPopupClose(); };
      popup.on('close', closeHandler); popupCloseHandlerRef.current = closeHandler; popupRef.current = popup.addTo(map);
    }
  }, [detail, selectedAnalysisGroup, selectedCollisionId, selectedPoint]);
  return <div ref={containerRef} className="map-canvas" role="application" aria-label="Interactive map of reported road injury collisions" />;
};
