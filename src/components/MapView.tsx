import { useEffect, useRef } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type PointLike, type StyleSpecification } from 'maplibre-gl';
import type { AnalysisGroup, BBox, CollisionDetail, DatasetManifest, SchoolRecord, ViewPayload } from '../../service/contract';
import { SEVERITY_STYLES } from '../domain/config';
import { layoutScreenMarkers, showIndividualMarkers, type ScreenMarker, type ScreenMarkerGroup } from '../domain/screenMarkers';
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
const aggregateRadius = (count: number): number => count <= 20 ? 6 + (Math.max(1, count) - 1) * (7 / 19) : count <= 100 ? 13 + (count - 20) * (9 / 80) : 22 + Math.min(8, (count - 100) * (8 / 900));
const analysisRadius = (collisions: number): number => collisions <= 10 ? 10 + Math.max(0, collisions - 3) * (7 / 7) : 17 + Math.min(10, (collisions - 10) * (10 / 15));
const collisionRadius = (zoom: number): number => zoom <= 5 ? 3.5 : zoom >= 12 ? 5 : 3.5 + (zoom - 5) * (1.5 / 7);
const pointMarker = (marker: Omit<ScreenMarker, 'x' | 'y'>, map: MapLibreMap): ScreenMarker => {
  const point = map.project([marker.longitude, marker.latitude]);
  return { ...marker, x: point.x, y: point.y };
};
const viewMarkers = (view: ViewPayload | null, map: MapLibreMap): ScreenMarker[] => {
  if (!view) return [];
  const zoom = map.getZoom();
  const individualMarkers = showIndividualMarkers(view.mode);
  return view.features.features.map((feature) => {
    const properties = feature.properties;
    const [longitude, latitude] = feature.geometry.coordinates;
    if (properties.kind === 'aggregate') return pointMarker({ id: String(feature.id ?? `aggregate:${longitude}:${latitude}`), longitude, latitude, kind: 'aggregate', radius: aggregateRadius(properties.count) + 1, weight: Math.max(1, properties.count), collisionCount: properties.count, bounds: properties.bbox, label: individualMarkers ? '' : String(properties.count), data: properties }, map);
    return pointMarker({ id: String(feature.id ?? properties.id), longitude, latitude, kind: 'collision', radius: collisionRadius(zoom) + 1, weight: 1, collisionCount: 1, label: '', severity: properties.severity, data: properties }, map);
  });
};
const analysisMarkers = (groups: AnalysisGroup[], map: MapLibreMap): ScreenMarker[] => groups.map((group) => pointMarker({ id: `analysis:${group.id}`, longitude: group.anchor.longitude, latitude: group.anchor.latitude, kind: 'analysis', radius: analysisRadius(group.collisions) + 3, weight: Math.max(1, group.collisions), label: String(group.collisions), data: group }, map));
const schoolMarkers = (schools: SchoolRecord[], map: MapLibreMap): ScreenMarker[] => map.getZoom() < 8 ? [] : schools.map((school) => pointMarker({ id: `school:${school.id}`, longitude: school.longitude, latitude: school.latitude, kind: 'school', radius: 7.5, weight: 1, label: '', data: school }, map));
const displayGeoJson = (groups: ScreenMarkerGroup[], map: MapLibreMap): GeoJSON.FeatureCollection<GeoJSON.Point, Record<string, unknown>> => ({
  type: 'FeatureCollection',
  features: groups.map((group) => {
    const point = map.unproject([group.x, group.y]);
    const member = group.members.length === 1 ? group.members[0] : undefined;
    const strokeWidth = group.kind === 'analysis' ? 3 : group.kind === 'school' ? 2 : 1;
    return { type: 'Feature', id: group.id, geometry: { type: 'Point', coordinates: [point.lng, point.lat] }, properties: {
      id: group.id,
      displayKind: group.kind,
      severity: member?.severity ?? 'unknown',
      paintRadius: Math.max(2, group.radius - strokeWidth),
      strokeWidth,
      label: group.label,
      memberCount: group.members.length,
      collisionCount: group.collisionCount,
      aggregateCount: group.counts.aggregate,
      hotspotCount: group.counts.analysis,
      schoolCount: group.counts.school,
      bounds: JSON.stringify(group.bounds),
    } as Record<string, unknown> };
  }),
});
const collisionPickerGroup = (members: ScreenMarker[], source: ScreenMarkerGroup): ScreenMarkerGroup => {
  const counts = members.reduce((result, member) => {
    result[member.kind] += 1;
    return result;
  }, { collision: 0, aggregate: 0, analysis: 0, school: 0 });
  const collisionCount = members.reduce((count, member) => count + (member.kind === 'collision' ? 1 : member.kind === 'aggregate' ? member.collisionCount ?? 0 : 0), 0);
  return {
    ...source,
    id: `collision-picker:${members.map((member) => member.id).sort().join('|')}`,
    kind: 'cluster',
    members,
    counts,
    collisionCount,
    label: '',
  };
};
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
const collisionSummaryPopup = (member: ScreenMarker, clicked = false): HTMLElement => {
  const root = document.createElement('article'); root.className = 'map-popup';
  const title = document.createElement('h3'); title.textContent = 'Reported collision'; root.append(title);
  const data = member.data as { year?: unknown; severity?: unknown; authorityName?: unknown; authorityCode?: unknown } | undefined;
  const list = document.createElement('dl');
  addDetail(list, 'Year', data?.year);
  addDetail(list, 'Severity', typeof data?.severity === 'string' ? data.severity[0].toUpperCase() + data.severity.slice(1) : data?.severity);
  addDetail(list, 'Authority', data?.authorityName ?? data?.authorityCode);
  addDetail(list, 'Collision ID', member.id);
  root.append(list);
  const note = document.createElement('p'); note.className = 'popup-note'; note.textContent = clicked ? 'Loading linked casualty and vehicle evidence…' : 'Click for full collision details.'; root.append(note);
  return root;
};
const schoolPopup = (school: SchoolRecord): HTMLElement => {
  const root = document.createElement('article'); root.className = 'map-popup';
  const title = document.createElement('h3'); title.textContent = school.name; root.append(title);
  const list = document.createElement('dl');
  addDetail(list, 'Phase', school.phase);
  addDetail(list, 'Status', school.status);
  addDetail(list, 'Country', school.country);
  root.append(list);
  return root;
};
const aggregatePopup = (member: ScreenMarker, onZoom: (() => void) | null): HTMLElement => {
  const root = document.createElement('article'); root.className = 'map-popup';
  const title = document.createElement('h3'); title.textContent = 'Aggregated collisions'; root.append(title);
  const data = member.data as { count?: unknown; collisionSeverity?: { fatal?: unknown; serious?: unknown; slight?: unknown; unknown?: unknown }; ksiCollisions?: unknown; yearsRepresented?: unknown[] } | undefined;
  const list = document.createElement('dl');
  addDetail(list, 'Collision count', data?.count ?? member.collisionCount);
  addDetail(list, 'Years', data?.yearsRepresented?.join(' · '));
  if (data?.collisionSeverity) addDetail(list, 'Collision harm', `${data.collisionSeverity.fatal ?? 0} fatal · ${data.collisionSeverity.serious ?? 0} serious · ${data.collisionSeverity.slight ?? 0} slight`);
  addDetail(list, 'KSI collisions', data?.ksiCollisions);
  root.append(list);
  if (onZoom) {
    const zoom = document.createElement('button'); zoom.type = 'button'; zoom.className = 'text-button'; zoom.textContent = 'Zoom to this area'; zoom.addEventListener('click', onZoom); root.append(zoom);
  }
  return root;
};
const nullableMetric = (metric: { value: number | null; unknownRecords: number }): string => {
  if (metric.value === null) return metric.unknownRecords ? `Not recorded (${metric.unknownRecords})` : 'Not recorded';
  return metric.unknownRecords ? `${metric.value} (${metric.unknownRecords} not recorded)` : String(metric.value);
};
const analysisGroupPopup = (group: AnalysisGroup): HTMLElement => {
  const root = document.createElement('article'); root.className = 'map-popup';
  const title = document.createElement('h3'); title.textContent = 'Persistent collision site'; root.append(title);
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
const groupedMarkerPopup = (group: ScreenMarkerGroup, onZoom: (() => void) | null, onMember: (member: ScreenMarker) => void): HTMLElement => {
  const root = document.createElement('article'); root.className = 'map-popup';
  const title = document.createElement('h3'); title.textContent = 'Markers grouped for display'; root.append(title);
  const list = document.createElement('dl');
  addDetail(list, 'Map collisions', group.collisionCount);
  addDetail(list, 'Persistent collision sites', group.counts.analysis);
  addDetail(list, 'Listed schools', group.counts.school);
  root.append(list);
  if (onZoom) {
    const zoom = document.createElement('button'); zoom.type = 'button'; zoom.className = 'text-button'; zoom.textContent = 'Zoom to this area'; zoom.addEventListener('click', onZoom); root.append(zoom);
  }
  const members = document.createElement('div'); members.className = 'group-member-list';
  let shown = 0;
  const renderMembers = () => {
    members.replaceChildren();
    const visibleMembers = group.members.slice(0, shown + 12);
    shown = visibleMembers.length;
    for (const member of visibleMembers) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button';
      const data = member.data as { name?: string; count?: number; collisions?: number } | undefined;
      button.textContent = member.kind === 'school' ? data?.name ?? member.id : member.kind === 'analysis' ? `${data?.collisions ?? member.weight} collisions at persistent site` : member.kind === 'aggregate' ? `${data?.count ?? member.collisionCount ?? member.weight} collision cell` : `Collision ${member.id}`;
      button.addEventListener('click', () => onMember(member)); members.append(button);
    }
    if (shown < group.members.length) {
      const more = document.createElement('button'); more.type = 'button'; more.className = 'text-button'; more.textContent = `Show more markers (${group.members.length - shown} remaining)`; more.addEventListener('click', renderMembers); members.append(more);
    }
  };
  renderMembers();
  root.append(members);
  const note = document.createElement('p'); note.className = 'popup-note'; note.textContent = 'Counts are retained by marker type; persistent collision site members are not added to map collision totals.'; root.append(note);
  return root;
};
const mapBBox = (map: MapLibreMap): BBox => { const b = map.getBounds(); return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() }; };
const propertyBBox = (value: unknown): BBox | null => {
  const candidate = typeof value === 'string' ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })() : value;
  if (!candidate || typeof candidate !== 'object') return null;
  const bbox = candidate as Partial<BBox>;
  return [bbox.west, bbox.south, bbox.east, bbox.north].every((item) => typeof item === 'number' && Number.isFinite(item)) ? { west: bbox.west!, south: bbox.south!, east: bbox.east!, north: bbox.north! } : null;
};
const safeGroupBBox = (bbox: BBox): BBox => {
  const longitudePadding = Math.max(0.005, (bbox.east - bbox.west) * 0.1);
  const latitudePadding = Math.max(0.005, (bbox.north - bbox.south) * 0.1);
  return { west: bbox.west - longitudePadding, south: bbox.south - latitudePadding, east: bbox.east + longitudePadding, north: bbox.north + latitudePadding };
};
const ensureSource = (map: MapLibreMap, id: string, data: GeoJSON.GeoJSON, options?: Record<string, unknown>): void => {
  if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data, ...(options ?? {}) } as maplibregl.GeoJSONSourceSpecification);
};
type PendingCameraAction = { kind: 'reset'; order: number } | { kind: 'focus'; order: number; bbox: BBox };
type PopupMode = 'hover' | 'grouped' | 'analysis' | 'detail' | 'collision-summary' | 'school' | 'aggregate';
type PopupSpec = { mode: PopupMode; key: string; point: [number, number]; content: HTMLElement; pinned: boolean };

export const MapView = ({ view, manifest, initialBBox, initialZoom, schools, analysisGroups, resetSignal, focusBBox, selectedCollisionId, selectedPoint, selectedAnalysisGroup, detail, onBoundsChange, onAggregateClick, onCollisionClick, onAnalysisGroupClick, onPopupClose, onSchoolClick }: MapViewProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const readyRef = useRef(false);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const popupCloseHandlerRef = useRef<(() => void) | null>(null);
  const popupModeRef = useRef<PopupMode | null>(null);
  const popupKeyRef = useRef<string | null>(null);
  const popupPinnedRef = useRef(false);
  const popupPointerCleanupRef = useRef<(() => void) | null>(null);
  const hoverInsidePopupRef = useRef(false);
  const hoverTimerRef = useRef<number | null>(null);
  const hoverCloseTimerRef = useRef<number | null>(null);
  const hoverPendingKeyRef = useRef<string | null>(null);
  const activeInteractionRef = useRef<string | null>(null);
  const selectedAnalysisPropKeyRef = useRef<string | null>(null);
  const selectedCollisionPropIdRef = useRef<string | null>(null);
  const popupRenderRef = useRef<((spec: PopupSpec) => void) | null>(null);
  const popupDismissRef = useRef<((notify?: boolean) => void) | null>(null);
  const callbacks = useRef({ onBoundsChange, onAggregateClick, onCollisionClick, onAnalysisGroupClick, onPopupClose, onSchoolClick });
  callbacks.current = { onBoundsChange, onAggregateClick, onCollisionClick, onAnalysisGroupClick, onPopupClose, onSchoolClick };
  const schoolsRef = useRef(schools);
  schoolsRef.current = schools;
  const viewRef = useRef(view);
  viewRef.current = view;
  const analysisRef = useRef(analysisGroups);
  analysisRef.current = analysisGroups;
  const displayGroupsRef = useRef(new Map<string, ScreenMarkerGroup>());
  const scheduleLayoutRef = useRef<((reveal?: boolean) => void) | null>(null);
  const hideDisplayRef = useRef<(() => void) | null>(null);
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
    const map = new maplibregl.Map({ container: containerRef.current, style: MAP_STYLE, center: [(camera.west + camera.east) / 2, (camera.south + camera.north) / 2], zoom: initialZoom, minZoom: 3, maxZoom: 18, attributionControl: false, dragRotate: false, pitchWithRotate: false, cooperativeGestures: false, fadeDuration: 0 });
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    const hideDisplay = () => {
      layoutGeneration += 1;
      if (map.getLayer('display-circles')) {
        map.setPaintProperty('display-circles', 'circle-opacity-transition', { duration: 0, delay: 0 });
        map.setPaintProperty('display-circles', 'circle-stroke-opacity-transition', { duration: 0, delay: 0 });
        map.setPaintProperty('display-circles', 'circle-opacity', 0);
        map.setPaintProperty('display-circles', 'circle-stroke-opacity', 0);
      }
      if (map.getLayer('display-label')) {
        map.setPaintProperty('display-label', 'text-opacity-transition', { duration: 0, delay: 0 });
        map.setPaintProperty('display-label', 'text-opacity', 0);
      }
    };
    const revealDisplay = () => {
      if (map.isMoving()) return;
      if (map.getLayer('display-circles')) {
        map.setPaintProperty('display-circles', 'circle-opacity-transition', { duration: 0, delay: 0 });
        map.setPaintProperty('display-circles', 'circle-stroke-opacity-transition', { duration: 0, delay: 0 });
        map.setPaintProperty('display-circles', 'circle-opacity', ['match', ['get', 'displayKind'], 'analysis', .42, 'aggregate', .78, 'cluster', .78, .9]);
        map.setPaintProperty('display-circles', 'circle-stroke-opacity', 1);
      }
      if (map.getLayer('display-label')) {
        map.setPaintProperty('display-label', 'text-opacity-transition', { duration: 0, delay: 0 });
        map.setPaintProperty('display-label', 'text-opacity', 1);
      }
    };
    const updateDisplay = (): Promise<void> | undefined => {
      if (!readyRef.current) return undefined;
      const markers = [...viewMarkers(viewRef.current, map), ...analysisMarkers(analysisRef.current, map), ...schoolMarkers(schoolsRef.current, map)];
      const groups = layoutScreenMarkers(markers, { individualMarkers: showIndividualMarkers(viewRef.current?.mode ?? 'aggregates'), gap: 6, maxGroupRadius: 26, maxGroupSpan: 72, clusterDistance: 34, maxDisplayDisplacement: 8 });
      displayGroupsRef.current = new Map(groups.map((group) => [group.id, group]));
      const source = map.getSource('display') as GeoJSONSource | undefined;
      return source?.setData(displayGeoJson(groups, map), true);
    };
    let layoutFrame = 0;
    let revealAfterLayout = false;
    let layoutGeneration = 0;
    const scheduleLayout = (reveal = false) => {
      revealAfterLayout = revealAfterLayout || reveal;
      if (layoutFrame) return;
      layoutFrame = requestAnimationFrame(() => {
        layoutFrame = 0;
        const generation = ++layoutGeneration;
        const sourceReady = updateDisplay();
        sourceReady?.then(() => {
          const revealAfterRender = () => {
            if (generation !== layoutGeneration || !revealAfterLayout) return;
            if (map.isMoving() || !map.isSourceLoaded('display')) {
              map.once('render', revealAfterRender);
              return;
            }
            revealAfterLayout = false;
            revealDisplay();
          };
          map.once('render', revealAfterRender);
        }).catch(() => {
          if (generation === layoutGeneration) revealAfterLayout = false;
        });
      });
    };
    scheduleLayoutRef.current = scheduleLayout;
    hideDisplayRef.current = hideDisplay;
    const report = () => callbacks.current.onBoundsChange(mapBBox(map), map.getZoom());
    const onMoveStart = () => { hideDisplay(); if (!popupPinnedRef.current) popupDismissRef.current?.(); };
    const onMove = () => scheduleLayout();
    const onMoveEnd = () => { report(); scheduleLayout(true); };
    const onWindowResize = () => { hideDisplay(); map.resize(); scheduleLayout(true); };

    map.on('load', () => {
      ensureSource(map, 'display', emptyCollection());
      map.addLayer({ id: 'display-circles', type: 'circle', source: 'display', paint: {
        'circle-color': ['match', ['get', 'displayKind'], 'aggregate', '#244b69', 'cluster', '#244b69', 'analysis', '#7c3aed', 'school', '#2563eb', ['match', ['get', 'severity'], 'fatal', SEVERITY_STYLES.fatal.colour, 'serious', SEVERITY_STYLES.serious.colour, 'slight', SEVERITY_STYLES.slight.colour, SEVERITY_STYLES.unknown.colour]],
        'circle-radius': ['get', 'paintRadius'],
        'circle-opacity': ['match', ['get', 'displayKind'], 'analysis', .42, 'aggregate', .78, 'cluster', .78, .9],
        'circle-stroke-color': ['match', ['get', 'displayKind'], 'analysis', '#4c1d95', 'school', '#dbeafe', '#fff'],
        'circle-stroke-width': ['get', 'strokeWidth'],
      } });
      map.addLayer({ id: 'display-label', type: 'symbol', source: 'display', filter: ['!=', ['get', 'label'], ''], layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': '#fff', 'text-halo-color': '#17253a', 'text-halo-width': 1.5 } });
      readyRef.current = true;
      const pendingCameraAction = pendingCameraActionRef.current;
      if (pendingCameraAction?.kind === 'reset') {
        map.fitBounds([[manifest.extent.west, manifest.extent.south], [manifest.extent.east, manifest.extent.north]], { padding: 36, maxZoom: 8, duration: 0 });
      } else if (pendingCameraAction?.kind === 'focus') {
        const pendingFocus = pendingCameraAction.bbox;
        map.fitBounds([[pendingFocus.west, pendingFocus.south], [pendingFocus.east, pendingFocus.north]], { padding: 80, maxZoom: 16, duration: 0 });
      }
      hideDisplay();
      scheduleLayout(true);
      report();
    });
    map.on('movestart', onMoveStart);
    map.on('move', onMove);
    map.on('moveend', onMoveEnd);
    window.addEventListener('resize', onWindowResize);
    type Hit = { group: ScreenMarkerGroup; point: [number, number] };
    const hitAt = (point: PointLike): Hit | null => {
      const features = map.queryRenderedFeatures(point, { layers: ['display-circles', 'display-label'] });
      const hitGroups = [...new Map(features
        .filter((feature) => feature.geometry.type === 'Point')
        .map((feature) => [String(feature.properties?.id ?? feature.id ?? ''), displayGroupsRef.current.get(String(feature.properties?.id ?? feature.id ?? ''))] as const)
        .filter((entry): entry is readonly [string, ScreenMarkerGroup] => Boolean(entry[1]))).values()];
      const feature = features.find((candidate) => candidate.geometry.type === 'Point');
      if (!feature || feature.geometry.type !== 'Point' || !hitGroups.length) return null;
      const hitMembers = [...new Map(hitGroups.flatMap((hitGroup) => hitGroup.members).map((member) => [member.id, member] as const)).values()];
      const primaryGroup = hitGroups.find((hitGroup) => hitGroup.members.some((member) => member.kind === 'collision')) ?? hitGroups[0];
      const group = primaryGroup.members.length === 1 && hitMembers.length > 1 ? collisionPickerGroup(hitMembers, primaryGroup) : primaryGroup;
      return group ? { group, point: feature.geometry.coordinates as [number, number] } : null;
    };
    const isSelectionMode = (mode: PopupMode | null): boolean => mode === 'analysis' || mode === 'detail' || mode === 'collision-summary';
    const clearHoverTimer = () => {
      if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    };
    const clearHoverCloseTimer = () => {
      if (hoverCloseTimerRef.current !== null) window.clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    };
    const dismissPopup = (notify = false) => {
      clearHoverTimer();
      clearHoverCloseTimer();
      hoverPendingKeyRef.current = null;
      hoverInsidePopupRef.current = false;
      const popup = popupRef.current;
      const mode = popupModeRef.current;
      if (!popup) {
        popupPinnedRef.current = false;
        popupKeyRef.current = null;
        popupModeRef.current = null;
        activeInteractionRef.current = null;
        return;
      }
      if (popupCloseHandlerRef.current) popup.off('close', popupCloseHandlerRef.current);
      popupPointerCleanupRef.current?.();
      popupPointerCleanupRef.current = null;
      popupCloseHandlerRef.current = null;
      popupRef.current = null;
      popupKeyRef.current = null;
      popupModeRef.current = null;
      popupPinnedRef.current = false;
      activeInteractionRef.current = null;
      popup.remove();
      if (notify && isSelectionMode(mode)) callbacks.current.onPopupClose();
    };
    popupDismissRef.current = dismissPopup;
    const attachPopupPointer = (popup: maplibregl.Popup) => {
      popupPointerCleanupRef.current?.();
      popupPointerCleanupRef.current = null;
      if (popupModeRef.current !== 'hover') return;
      const element = popup.getElement();
      if (!element) return;
      const onEnter = () => { hoverInsidePopupRef.current = true; clearHoverCloseTimer(); };
      const onLeave = () => {
        hoverInsidePopupRef.current = false;
        if (!popupPinnedRef.current) {
          clearHoverCloseTimer();
          hoverCloseTimerRef.current = window.setTimeout(() => {
            hoverCloseTimerRef.current = null;
            if (!popupPinnedRef.current && !hoverInsidePopupRef.current && popupModeRef.current === 'hover') dismissPopup();
          }, 240);
        }
      };
      element.addEventListener('mouseenter', onEnter);
      element.addEventListener('mouseleave', onLeave);
      popupPointerCleanupRef.current = () => { element.removeEventListener('mouseenter', onEnter); element.removeEventListener('mouseleave', onLeave); };
    };
    const renderPopup = (spec: PopupSpec) => {
      const existing = popupRef.current;
      if (existing && popupKeyRef.current === spec.key) {
        existing.setLngLat(spec.point).setDOMContent(spec.content);
        popupModeRef.current = spec.mode;
        popupPinnedRef.current = popupPinnedRef.current || spec.pinned;
        attachPopupPointer(existing);
        return;
      }
      const interaction = activeInteractionRef.current;
      dismissPopup();
      activeInteractionRef.current = interaction;
      const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: spec.mode === 'detail' ? '330px' : '350px' }).setLngLat(spec.point).setDOMContent(spec.content);
      const closeHandler = () => {
        if (popupRef.current !== popup) return;
        const mode = popupModeRef.current;
        popupPointerCleanupRef.current?.();
        popupPointerCleanupRef.current = null;
        popupCloseHandlerRef.current = null;
        popupRef.current = null;
        popupKeyRef.current = null;
        popupModeRef.current = null;
        popupPinnedRef.current = false;
        activeInteractionRef.current = null;
        if (isSelectionMode(mode)) callbacks.current.onPopupClose();
      };
      popup.on('close', closeHandler);
      popupCloseHandlerRef.current = closeHandler;
      popupKeyRef.current = spec.key;
      popupModeRef.current = spec.mode;
      popupPinnedRef.current = spec.pinned;
      popupRef.current = popup.addTo(map);
      attachPopupPointer(popup);
    };
    popupRenderRef.current = renderPopup;
    const popupKeyForMember = (member: ScreenMarker): string => `${member.kind}:${member.id}`;
    const prepareClick = (mode: PopupMode, key: string) => {
      const previousMode = popupModeRef.current;
      const previousKey = popupKeyRef.current;
      if (popupPinnedRef.current && isSelectionMode(previousMode) && (previousMode !== mode || previousKey !== key) && mode !== 'analysis' && mode !== 'collision-summary') callbacks.current.onPopupClose();
      activeInteractionRef.current = key;
    };
    const handleMarkerClick = (member: ScreenMarker, point: [number, number]) => {
      const key = popupKeyForMember(member);
      if (member.kind === 'school') {
        const schoolId = member.id.slice('school:'.length);
        const school = schoolsRef.current.find((candidate) => candidate.id === schoolId) ?? member.data as SchoolRecord | undefined;
        if (!school) return;
        prepareClick('school', key);
        renderPopup({ mode: 'school', key, point, content: schoolPopup(school), pinned: true });
        callbacks.current.onSchoolClick(school);
        return;
      }
      if (member.kind === 'analysis') {
        const analysisId = member.id.slice('analysis:'.length);
        const analysis = analysisRef.current.find((candidate) => candidate.id === analysisId) ?? member.data as AnalysisGroup | undefined;
        if (!analysis) return;
        prepareClick('analysis', key);
        renderPopup({ mode: 'analysis', key, point, content: analysisGroupPopup(analysis), pinned: true });
        callbacks.current.onAnalysisGroupClick(analysis);
        return;
      }
      if (member.kind === 'aggregate') {
        const data = member.data as { bbox?: unknown } | undefined;
        const bbox = propertyBBox(data?.bbox);
        prepareClick('aggregate', key);
        renderPopup({ mode: 'aggregate', key, point, content: aggregatePopup(member, bbox ? () => callbacks.current.onAggregateClick(bbox) : null), pinned: true });
        return;
      }
      prepareClick('collision-summary', key);
      renderPopup({ mode: 'collision-summary', key, point, content: collisionSummaryPopup(member, true), pinned: true });
      callbacks.current.onCollisionClick(member.id, [member.longitude, member.latitude]);
    };
    const hoverPopupFor = (hit: Hit) => {
      const { group, point } = hit;
      if (group.members.length > 1) {
        const bounds = safeGroupBBox(group.bounds);
        renderPopup({ mode: 'hover', key: `hover:${group.id}`, point, content: groupedMarkerPopup(group, () => callbacks.current.onAggregateClick(bounds), (member) => handleMarkerClick(member, [member.longitude, member.latitude])), pinned: false });
        return;
      }
      const member = group.members[0];
      if (member.kind === 'school') {
        const school = schoolsRef.current.find((candidate) => candidate.id === member.id.slice('school:'.length)) ?? member.data as SchoolRecord | undefined;
        if (school) renderPopup({ mode: 'hover', key: `hover:${member.id}`, point, content: schoolPopup(school), pinned: false });
      } else if (member.kind === 'analysis') {
        const analysis = analysisRef.current.find((candidate) => candidate.id === member.id.slice('analysis:'.length)) ?? member.data as AnalysisGroup | undefined;
        if (analysis) renderPopup({ mode: 'hover', key: `hover:${member.id}`, point, content: analysisGroupPopup(analysis), pinned: false });
      } else if (member.kind === 'aggregate') {
        const data = member.data as { bbox?: unknown } | undefined;
        const bbox = propertyBBox(data?.bbox);
        renderPopup({ mode: 'hover', key: `hover:${member.id}`, point, content: aggregatePopup(member, bbox ? () => callbacks.current.onAggregateClick(bbox) : null), pinned: false });
      } else {
        renderPopup({ mode: 'hover', key: `hover:${member.id}`, point, content: collisionSummaryPopup(member), pinned: false });
      }
    };
    const scheduleHoverClose = () => {
      if (popupPinnedRef.current) return;
      clearHoverTimer();
      clearHoverCloseTimer();
      hoverPendingKeyRef.current = null;
      hoverCloseTimerRef.current = window.setTimeout(() => {
        hoverCloseTimerRef.current = null;
        if (!popupPinnedRef.current && !hoverInsidePopupRef.current && popupModeRef.current === 'hover') dismissPopup();
      }, 240);
    };
    const onMouseMove = (event: maplibregl.MapMouseEvent) => {
      if (popupPinnedRef.current) return;
      const hit = hitAt(event.point);
      if (!hit) { scheduleHoverClose(); return; }
      const key = `hover:${hit.group.id}`;
      clearHoverCloseTimer();
      if (popupModeRef.current === 'hover' && popupKeyRef.current === key) return;
      if (hoverPendingKeyRef.current === key) return;
      clearHoverTimer();
      hoverPendingKeyRef.current = key;
      hoverTimerRef.current = window.setTimeout(() => {
        hoverTimerRef.current = null;
        hoverPendingKeyRef.current = null;
        if (!popupPinnedRef.current) hoverPopupFor(hit);
      }, 140);
    };
    const onMapMouseOut = () => scheduleHoverClose();
    const onMapClick = (event: maplibregl.MapMouseEvent) => {
      clearHoverTimer();
      const hit = hitAt(event.point);
      if (!hit) { dismissPopup(true); return; }
      hoverPendingKeyRef.current = null;
      const { group, point } = hit;
      if (group.members.length > 1) {
        const bounds = safeGroupBBox(group.bounds);
        prepareClick('grouped', `group:${group.id}`);
        renderPopup({ mode: 'grouped', key: `group:${group.id}`, point, content: groupedMarkerPopup(group, () => callbacks.current.onAggregateClick(bounds), (member) => handleMarkerClick(member, [member.longitude, member.latitude])), pinned: true });
        return;
      }
      handleMarkerClick(group.members[0], point);
    };
    map.on('click', onMapClick);
    map.on('mousemove', onMouseMove);
    map.on('mouseout', onMapMouseOut);
    map.on('mouseleave', onMapMouseOut);
    for (const layer of ['display-circles', 'display-label']) {
      const onEnter = () => { map.getCanvas().style.cursor = 'pointer'; clearHoverCloseTimer(); };
      const onLeave = (event: maplibregl.MapMouseEvent) => { map.getCanvas().style.cursor = hitAt(event.point) ? 'pointer' : ''; };
      map.on('mouseenter', layer, onEnter);
      map.on('mouseleave', layer, onLeave);
    }
    return () => {
      if (layoutFrame) cancelAnimationFrame(layoutFrame);
      window.removeEventListener('resize', onWindowResize);
      map.off('click', onMapClick);
      map.off('mousemove', onMouseMove);
      map.off('mouseout', onMapMouseOut);
      map.off('mouseleave', onMapMouseOut);
      clearHoverTimer();
      clearHoverCloseTimer();
      popupRenderRef.current = null;
      popupDismissRef.current = null;
      scheduleLayoutRef.current = null;
      hideDisplayRef.current = null;
      displayGroupsRef.current.clear();
      const popup = popupRef.current;
      if (popup && popupCloseHandlerRef.current) popup.off('close', popupCloseHandlerRef.current);
      popupPointerCleanupRef.current?.();
      popupPointerCleanupRef.current = null;
      popupCloseHandlerRef.current = null; popupModeRef.current = null; popupKeyRef.current = null; popupPinnedRef.current = false; activeInteractionRef.current = null; popupRef.current = null; popup?.remove();
      map.remove(); mapRef.current = null; readyRef.current = false;
    };
  }, [manifest.extent, initialBBox, initialZoom]);

  useEffect(() => {
    if (popupModeRef.current === 'hover') popupDismissRef.current?.();
    if (!mapRef.current || !readyRef.current) return;
    hideDisplayRef.current?.();
    scheduleLayoutRef.current?.(true);
  }, [view, analysisGroups, schools]);
  useEffect(() => { const map = mapRef.current; if (!map || !readyRef.current || resetSignal === 0) return; map.fitBounds([[manifest.extent.west, manifest.extent.south], [manifest.extent.east, manifest.extent.north]], { padding: 36, maxZoom: 8, duration: 650 }); }, [resetSignal, manifest.extent]);
  useEffect(() => { const map = mapRef.current; if (!map || !readyRef.current || !focusBBox) return; map.fitBounds([[focusBBox.west, focusBBox.south], [focusBBox.east, focusBBox.north]], { padding: 80, maxZoom: 16, duration: 650 }); }, [focusBBox]);
  useEffect(() => {
    const map = mapRef.current; if (!map || !readyRef.current) return;
    const activeInteraction = activeInteractionRef.current;
    const selectedAnalysisKey = selectedAnalysisGroup ? `analysis:${selectedAnalysisGroup.id}` : null;
    const selectedAnalysisChanged = selectedAnalysisKey !== selectedAnalysisPropKeyRef.current;
    const previousSelectedCollisionId = selectedCollisionPropIdRef.current;
    selectedAnalysisPropKeyRef.current = selectedAnalysisKey;
    selectedCollisionPropIdRef.current = selectedCollisionId;
    if (selectedAnalysisGroup) {
      const key = `analysis:${selectedAnalysisGroup.id}`;
      if (selectedAnalysisChanged || !activeInteraction || activeInteraction === key || popupModeRef.current === 'analysis') {
        activeInteractionRef.current = key;
        popupRenderRef.current?.({ mode: 'analysis', key, point: [selectedAnalysisGroup.anchor.longitude, selectedAnalysisGroup.anchor.latitude], content: analysisGroupPopup(selectedAnalysisGroup), pinned: true });
      }
      return;
    }
    if (popupModeRef.current === 'analysis' && activeInteraction?.startsWith('analysis:')) popupDismissRef.current?.();
    if (detail && selectedCollisionId && selectedPointRef.current) {
      const key = `collision:${selectedCollisionId}`;
      if (!activeInteraction || activeInteraction === key || activeInteraction.startsWith('collision:')) popupRenderRef.current?.({ mode: 'detail', key, point: selectedPointRef.current, content: detailPopup(detail), pinned: true });
    } else if (popupModeRef.current === 'detail' && activeInteraction?.startsWith('collision:')) {
      popupDismissRef.current?.();
    } else if (popupModeRef.current === 'collision-summary' && activeInteraction?.startsWith('collision:') && previousSelectedCollisionId !== null && selectedCollisionId === null) {
      popupDismissRef.current?.();
    }
  }, [detail, selectedAnalysisGroup, selectedCollisionId, selectedPoint]);
  return <div ref={containerRef} className="map-canvas" role="application" aria-label="Interactive map of reported road injury collisions" />;
};
