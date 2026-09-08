import type {
  AnalysisPayload,
  ApiResponse,
  CollisionDetail,
  DatasetManifest,
  SchoolsPayload,
  SummaryPayload,
  ViewPayload,
} from '../../service/contract';
import {
  StaticDataError,
  loadStaticAnalysis,
  loadStaticCollisionDetail,
  loadStaticManifest,
  loadStaticSchools,
  loadStaticSummary,
  loadStaticView,
  type StaticQueryOptions,
} from '../static/runtime';

export type QueryOptions = StaticQueryOptions;

const append = (params: URLSearchParams, key: string, values: string | number | undefined): void => {
  if (values !== undefined && values !== '') params.set(key, String(values));
};

export const queryString = (options: QueryOptions = { filters: { years: [], authorities: [], severities: [], pedestrian: 'all', cycle: 'all', motorcycle: 'all' } }): string => {
  const params = new URLSearchParams();
  if (options.filters.years.length) params.set('years', options.filters.years.join(','));
  if (options.filters.authorities.length) params.set('authorities', options.filters.authorities.join(','));
  if (options.filters.country) params.set('country', options.filters.country);
  if (options.filters.severities.length) params.set('severity', options.filters.severities.join(','));
  for (const key of ['pedestrian', 'cycle', 'motorcycle'] as const) if (options.filters[key] !== 'all') params.set(key, options.filters[key]);
  if (options.bbox) params.set('bbox', [options.bbox.west, options.bbox.south, options.bbox.east, options.bbox.north].join(','));
  // MapLibre reports fractional zoom values, while the Worker contract uses
  // bounded integer zoom keys for deterministic aggregation/cache behaviour.
  if (options.zoom !== undefined) params.set('zoom', String(Math.max(0, Math.min(22, Math.round(options.zoom)))));
  append(params, 'radius', options.radiusMetres);
  append(params, 'schoolDistance', options.schoolDistanceMetres);
  append(params, 'schoolId', options.schoolId);
  if (options.harmFilter && options.harmFilter !== 'all') params.set('harm', options.harmFilter);
  append(params, 'q', options.query);
  append(params, 'limit', options.limit);
  append(params, 'offset', options.offset);
  return params.toString();
};

/** Compatibility name retained for callers that previously handled Worker HTTP errors. */
export { StaticDataError as ApiRequestError };

export const loadManifest = (signal?: AbortSignal): Promise<ApiResponse<DatasetManifest>> => loadStaticManifest(signal);
export const loadView = (options: QueryOptions, signal?: AbortSignal): Promise<ApiResponse<ViewPayload>> => loadStaticView(options, signal);
export const loadSummary = (options: QueryOptions, signal?: AbortSignal): Promise<ApiResponse<SummaryPayload>> => loadStaticSummary(options, signal);
export const loadAnalysis = (options: QueryOptions, signal?: AbortSignal): Promise<ApiResponse<AnalysisPayload>> => loadStaticAnalysis(options, signal);
export const loadCollisionDetail = (id: string, signal?: AbortSignal): Promise<ApiResponse<CollisionDetail>> => loadStaticCollisionDetail(id, signal);
export const loadSchools = (options: QueryOptions, signal?: AbortSignal): Promise<ApiResponse<SchoolsPayload>> => loadStaticSchools(options, signal);

export const pointFeatureToGeoJson = (view: ViewPayload): GeoJSON.FeatureCollection<GeoJSON.Point, Record<string, unknown>> => ({
  type: 'FeatureCollection',
  features: view.features.features.map((feature) => ({
    type: 'Feature', id: feature.id, geometry: feature.geometry,
    properties: feature.properties as unknown as Record<string, unknown>,
  })),
});
