/** Typed seams for future corridor, scheme and exposure overlays. */
export interface CorridorOverlay {
  id: string;
  label: string;
  geometry: GeoJSON.Geometry;
  authority?: string;
  corridorType?: 'krn' | 'satn' | 'lcwip' | 'other';
  properties?: Record<string, unknown>;
}

export interface SchemeOverlay {
  id: string;
  label: string;
  geometry: GeoJSON.Geometry;
  schemeType: 'tcr' | 'crsts' | 'walking' | 'cycling' | 'crossing' | '20mph' | 'liveable-neighbourhood' | 'other';
  interventionDate?: string;
  beforePeriod?: { start: number; end: number };
  afterPeriod?: { start: number; end: number };
  properties?: Record<string, unknown>;
}

export interface ExposureMeasure {
  source: string;
  year: number;
  metric: 'traffic-count' | 'vehicle-miles' | 'walking-count' | 'cycling-count' | 'other';
  value: number;
  unit: string;
  geometry?: GeoJSON.Geometry;
}

