import { useEffect, useRef } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type MapGeoJSONFeature, type StyleSpecification } from 'maplibre-gl';
import type { BoundaryGeoJson, CollisionRecord, PersistentLocation } from '../domain/model';
import { SEVERITY_STYLES, OBSERVATORY_CONFIG } from '../domain/config';
import type { ViewportBounds } from '../domain/viewport';
import 'maplibre-gl/dist/maplibre-gl.css';

interface MapViewProps {
  records: CollisionRecord[];
  regionRecords: CollisionRecord[];
  locations: PersistentLocation[];
  boundaries: BoundaryGeoJson | null;
  resetViewSignal: number;
  focusLocation: PersistentLocation | null;
  showPersistentLocations: boolean;
  onLocationSelect: (location: PersistentLocation) => void;
  onViewportBoundsChange: (bounds: ViewportBounds) => void;
}

const MAP_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: OBSERVATORY_CONFIG.mapAttribution,
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

const sourceData = (records: CollisionRecord[]): GeoJSON.FeatureCollection<GeoJSON.Point, Record<string, unknown>> => {
  return {
    type: 'FeatureCollection',
    features: records.map((record) => ({
      type: 'Feature',
      id: record.id,
      geometry: { type: 'Point', coordinates: [record.longitude, record.latitude] },
      properties: { id: record.id, severity: record.severity },
    })),
  };
};

const hotspotData = (locations: PersistentLocation[]): GeoJSON.FeatureCollection<GeoJSON.Point, Record<string, unknown>> => ({
  type: 'FeatureCollection',
  features: locations.map((location) => ({
    type: 'Feature',
    id: location.id,
    geometry: { type: 'Point', coordinates: [location.longitude, location.latitude] },
    properties: location as unknown as Record<string, unknown>,
  })),
});

const valueLabel = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
};

const addDetail = (list: HTMLElement, label: string, value: unknown): void => {
  const text = valueLabel(value);
  if (!text) return;
  const row = document.createElement('div');
  row.className = 'popup-row';
  const key = document.createElement('dt');
  key.textContent = label;
  const detail = document.createElement('dd');
  detail.textContent = text;
  row.append(key, detail);
  list.append(row);
};

const collisionPopup = (record: CollisionRecord): HTMLElement => {
  const root = document.createElement('article');
  root.className = 'map-popup';
  const title = document.createElement('h3');
  title.textContent = record.roadName || record.roadNumber || 'Reported collision';
  root.append(title);
  const list = document.createElement('dl');
  addDetail(list, 'Date', record.date ?? (record.year ? String(record.year) : null));
  addDetail(list, 'Severity', SEVERITY_STYLES[record.severity].label);
  addDetail(list, 'Authority', record.localAuthority);
  addDetail(list, 'Road number', record.roadNumber);
  addDetail(list, 'Speed limit', record.speedLimit === null ? null : `${record.speedLimit} mph`);
  addDetail(list, 'Junction detail (DfT code)', record.junctionDetail);
  addDetail(list, 'Casualties', record.casualtyCount);
  addDetail(list, 'Pedestrian involvement', record.pedestrianInvolved === null ? 'Not recorded' : record.pedestrianInvolved ? 'Yes' : 'No');
  addDetail(list, 'Cycle involvement', record.cycleInvolved === null ? 'Not recorded' : record.cycleInvolved ? 'Yes' : 'No');
  addDetail(list, 'Motorcycle involvement', record.motorcycleInvolved === null ? 'Not recorded' : record.motorcycleInvolved ? 'Yes' : 'No');
  root.append(list);
  return root;
};

const locationPopup = (location: PersistentLocation): HTMLElement => {
  const root = document.createElement('article');
  root.className = 'map-popup';
  const title = document.createElement('h3');
  title.textContent = 'Persistent collision location';
  root.append(title);
  const list = document.createElement('dl');
  const involvementLabel = (known: number, unknown: number): string => unknown > 0
    ? `${known} known · ${unknown} not recorded`
    : String(known);
  addDetail(list, 'Collisions', location.collisions);
  addDetail(list, 'Years represented', location.years.join(', '));
  addDetail(list, 'Fatal collisions', location.fatalCollisions);
  addDetail(list, 'Serious collisions', location.seriousCollisions);
  addDetail(list, 'Slight collisions', location.slightCollisions);
  addDetail(list, 'Pedestrian-involved', involvementLabel(location.pedestrianInvolved, location.pedestrianUnknown));
  addDetail(list, 'Cycle-involved', involvementLabel(location.cycleInvolved, location.cycleUnknown));
  addDetail(list, 'Motorcycle-involved', involvementLabel(location.motorcycleInvolved, location.motorcycleUnknown));
  root.append(list);
  return root;
};

const mapBoundsFromFeatures = (records: CollisionRecord[]): maplibregl.LngLatBounds | null => {
  if (!records.length) return null;
  const bounds = new maplibregl.LngLatBounds();
  records.forEach((record) => bounds.extend([record.longitude, record.latitude]));
  return bounds;
};

const viewportBoundsFromMap = (map: MapLibreMap): ViewportBounds => {
  const bounds = map.getBounds();
  return {
    west: bounds.getWest(),
    east: bounds.getEast(),
    south: bounds.getSouth(),
    north: bounds.getNorth(),
  };
};

const ensureSource = (map: MapLibreMap, id: string, data: GeoJSON.GeoJSON, options?: Record<string, unknown>): void => {
  if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data, ...(options ?? {}) } as maplibregl.GeoJSONSourceSpecification);
};

export const MapView = ({ records, regionRecords, locations, boundaries, resetViewSignal, focusLocation, showPersistentLocations, onLocationSelect, onViewportBoundsChange }: MapViewProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const mapReadyRef = useRef(false);
  const pendingMapTasksRef = useRef<Array<() => void>>([]);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const regionBoundsRef = useRef<maplibregl.LngLatBounds | null>(null);
  const regionRecordsRef = useRef(regionRecords);
  const onLocationSelectRef = useRef(onLocationSelect);
  const onViewportBoundsChangeRef = useRef(onViewportBoundsChange);
  const recordsRef = useRef(records);
  const locationsRef = useRef(locations);
  onLocationSelectRef.current = onLocationSelect;
  onViewportBoundsChangeRef.current = onViewportBoundsChange;
  recordsRef.current = records;
  locationsRef.current = locations;
  regionRecordsRef.current = regionRecords;

  const runWhenMapReady = (task: () => void): void => {
    if (mapReadyRef.current) task();
    else pendingMapTasksRef.current.push(task);
  };

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: OBSERVATORY_CONFIG.map.centre,
      zoom: OBSERVATORY_CONFIG.map.zoom,
      minZoom: OBSERVATORY_CONFIG.map.minZoom,
      maxZoom: OBSERVATORY_CONFIG.map.maxZoom,
      attributionControl: false,
      cooperativeGestures: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    });
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    map.keyboard?.disableRotation();
    const reportViewportBounds = () => onViewportBoundsChangeRef.current(viewportBoundsFromMap(map));
    const openPopup = (coordinates: [number, number], content: HTMLElement): void => {
      popupRef.current?.remove();
      const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '320px' })
        .setLngLat(coordinates)
        .setDOMContent(content)
        .addTo(map);
      popupRef.current = popup;
    };
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    map.on('load', () => {
      ensureSource(map, 'collisions', sourceData(records), { cluster: true, clusterMaxZoom: 13, clusterRadius: 55 });
      ensureSource(map, 'persistent-locations', hotspotData(locations));
      if (boundaries) ensureSource(map, 'boundaries', boundaries as unknown as GeoJSON.GeoJSON);
      if (boundaries) {
        map.addLayer({ id: 'boundary-fill', type: 'fill', source: 'boundaries', paint: { 'fill-color': '#64748b', 'fill-opacity': 0.03 } });
        map.addLayer({ id: 'boundary-line', type: 'line', source: 'boundaries', paint: { 'line-color': '#475569', 'line-width': 1.3, 'line-dasharray': [3, 3], 'line-opacity': 0.75 } });
      }
      map.addLayer({
        id: 'persistent-locations',
        type: 'circle',
        source: 'persistent-locations',
        layout: { visibility: showPersistentLocations ? 'visible' : 'none' },
        paint: {
          'circle-color': '#6d28d9',
          'circle-radius': ['interpolate', ['linear'], ['get', 'collisions'], 3, 8, 8, 15, 20, 25],
          'circle-opacity': 0.22,
          'circle-stroke-color': '#5b21b6',
          'circle-stroke-width': 2,
        },
      });
      map.addLayer({
        id: 'collision-clusters',
        type: 'circle',
        source: 'collisions',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#132238',
          'circle-radius': ['step', ['get', 'point_count'], 17, 20, 21, 100, 26],
          'circle-stroke-color': '#f8fafc',
          'circle-stroke-width': 2,
        },
      });
      map.addLayer({
        id: 'collision-cluster-count',
        type: 'symbol',
        source: 'collisions',
        filter: ['has', 'point_count'],
        layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12 },
        paint: { 'text-color': '#ffffff' },
      });
      map.addLayer({
        id: 'collision-points',
        type: 'circle',
        source: 'collisions',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': ['match', ['get', 'severity'], 'fatal', SEVERITY_STYLES.fatal.colour, 'serious', SEVERITY_STYLES.serious.colour, 'slight', SEVERITY_STYLES.slight.colour, SEVERITY_STYLES.unknown.colour],
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 3.5, 13, 5, 18, 7],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1,
          'circle-opacity': 0.9,
        },
      });
      const bounds = regionBoundsRef.current ?? mapBoundsFromFeatures(regionRecords);
      if (bounds && !bounds.isEmpty()) map.fitBounds(bounds, { padding: 48, maxZoom: 12, duration: 0 });
      mapReadyRef.current = true;
      reportViewportBounds();
      const pendingTasks = pendingMapTasksRef.current.splice(0);
      pendingTasks.forEach((task) => task());
    });

    // One map-level click handler gives overlapping layers a deterministic priority
    // and ensures a new popup always replaces the previous one.
    map.on('click', (event) => {
      const features = map.queryRenderedFeatures(event.point, { layers: ['persistent-locations', 'collision-points', 'collision-clusters'] });
      const persistentFeature = features.find((feature) => feature.layer?.id === 'persistent-locations');
      const collisionFeature = features.find((feature) => feature.layer?.id === 'collision-points');
      const clusterFeature = features.find((feature) => feature.layer?.id === 'collision-clusters');
      const pointCoordinates = (feature: MapGeoJSONFeature | undefined): [number, number] | null => {
        if (!feature || feature.geometry.type !== 'Point') return null;
        return feature.geometry.coordinates as [number, number];
      };

      // A selected persistent location represents the aggregate the user enabled,
      // so it wins when its larger marker overlaps an individual collision point.
      if (persistentFeature) {
        const id = String(persistentFeature.properties?.id ?? persistentFeature.id ?? '');
        const location = locationsRef.current.find((candidate) => candidate.id === id);
        const coordinates = pointCoordinates(persistentFeature);
        if (location && coordinates) {
          onLocationSelectRef.current(location);
          openPopup(coordinates, locationPopup(location));
          return;
        }
      }
      if (collisionFeature) {
        const id = String(collisionFeature.properties?.id ?? collisionFeature.id ?? '');
        const record = recordsRef.current.find((candidate) => candidate.id === id);
        const coordinates = pointCoordinates(collisionFeature);
        if (record && coordinates) {
          openPopup(coordinates, collisionPopup(record));
          return;
        }
      }
      if (clusterFeature) {
        const clusterId = clusterFeature.properties?.cluster_id;
        const source = map.getSource('collisions') as GeoJSONSource | undefined;
        const coordinates = pointCoordinates(clusterFeature);
        if (source && typeof clusterId === 'number' && coordinates) {
          popupRef.current?.remove();
          popupRef.current = null;
          source.getClusterExpansionZoom(clusterId).then((zoom) => {
            map.easeTo({ center: coordinates, zoom });
          }).catch(() => undefined);
          return;
        }
      }
      popupRef.current?.remove();
      popupRef.current = null;
    });
    map.on('moveend', reportViewportBounds);
    for (const layer of ['collision-clusters', 'collision-points', 'persistent-locations']) {
      map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
    }

    if (containerRef.current && 'ResizeObserver' in window) {
      const observer = new ResizeObserver(() => map.resize());
      observer.observe(containerRef.current);
      return () => {
        observer.disconnect();
        popupRef.current?.remove();
        popupRef.current = null;
        mapReadyRef.current = false;
        pendingMapTasksRef.current = [];
        map.remove();
        mapRef.current = null;
      };
    }
    const resize = () => map.resize();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      popupRef.current?.remove();
      popupRef.current = null;
      mapReadyRef.current = false;
      pendingMapTasksRef.current = [];
      map.remove();
      mapRef.current = null;
    };
    // Initial inputs are intentionally captured by event handlers; live data is
    // updated below without recreating the expensive WebGL map instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const update = () => {
      const currentMap = mapRef.current;
      if (!currentMap) return;
      popupRef.current?.remove();
      popupRef.current = null;
      const source = currentMap.getSource('collisions') as GeoJSONSource | undefined;
      if (source) source.setData(sourceData(records));
      const hotspotSource = currentMap.getSource('persistent-locations') as GeoJSONSource | undefined;
      if (hotspotSource) hotspotSource.setData(hotspotData(locations));
      if (boundaries && !currentMap.getSource('boundaries')) {
        ensureSource(currentMap, 'boundaries', boundaries as unknown as GeoJSON.GeoJSON);
        if (!currentMap.getLayer('boundary-fill')) currentMap.addLayer({ id: 'boundary-fill', type: 'fill', source: 'boundaries', paint: { 'fill-color': '#64748b', 'fill-opacity': 0.03 } });
        if (!currentMap.getLayer('boundary-line')) currentMap.addLayer({ id: 'boundary-line', type: 'line', source: 'boundaries', paint: { 'line-color': '#475569', 'line-width': 1.3, 'line-dasharray': [3, 3], 'line-opacity': 0.75 } });
      }
    };
    runWhenMapReady(update);
  }, [records, locations, boundaries]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || resetViewSignal === 0) return;
    runWhenMapReady(() => {
      const currentMap = mapRef.current;
      if (!currentMap) return;
      popupRef.current?.remove();
      popupRef.current = null;
      const bounds = regionBoundsRef.current ?? mapBoundsFromFeatures(regionRecordsRef.current);
      if (bounds && !bounds.isEmpty()) currentMap.fitBounds(bounds, { padding: 48, maxZoom: 12, duration: 700 });
      else currentMap.easeTo({ center: OBSERVATORY_CONFIG.map.centre, zoom: OBSERVATORY_CONFIG.map.zoom });
    });
  }, [resetViewSignal]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    runWhenMapReady(() => {
      const currentMap = mapRef.current;
      if (!currentMap || !currentMap.getLayer('persistent-locations')) return;
      currentMap.setLayoutProperty('persistent-locations', 'visibility', showPersistentLocations ? 'visible' : 'none');
      if (!showPersistentLocations) {
        popupRef.current?.remove();
        popupRef.current = null;
      }
    });
  }, [showPersistentLocations]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusLocation) return;
    runWhenMapReady(() => {
      const currentMap = mapRef.current;
      if (!currentMap) return;
      currentMap.easeTo({ center: [focusLocation.longitude, focusLocation.latitude], zoom: Math.max(currentMap.getZoom(), 15), duration: 650 });
    });
  }, [focusLocation]);

  useEffect(() => {
    if (!regionBoundsRef.current) regionBoundsRef.current = mapBoundsFromFeatures(regionRecords);
  }, [regionRecords]);

  return <div ref={containerRef} className="map-canvas" role="application" aria-label="Interactive map of reported road injury collisions" />;
};
