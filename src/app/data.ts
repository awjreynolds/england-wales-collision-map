import type {
  AnalysisPayload,
  ApiResponse,
  BBox,
  CollisionDetail,
  DatasetManifest,
  QueryFilters,
  SchoolsPayload,
  SummaryPayload,
  ViewPayload,
} from '../../service/contract';

const configuredApi = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim();
export const API_BASE_URL = (configuredApi || '/api').replace(/\/$/, '');

export interface QueryOptions {
  filters: QueryFilters;
  bbox?: BBox;
  zoom?: number;
  radiusMetres?: number;
  schoolDistanceMetres?: 500 | 1000;
  schoolId?: string;
  harmFilter?: 'all' | 'ksi' | 'repeated-ksi' | 'slight-only';
  query?: string;
  limit?: number;
  offset?: number;
}

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

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = status;
  }
}

const request = async <T>(path: string, options: QueryOptions | undefined, signal?: AbortSignal): Promise<ApiResponse<T>> => {
  const suffix = options ? queryString(options) : '';
  const response = await fetch(`${API_BASE_URL}${path}${suffix ? `?${suffix}` : ''}`, { signal, headers: { Accept: 'application/json' } });
  const body = await response.json() as ApiResponse<T> & { error?: { code?: string; message?: string } };
  if (!response.ok || body.error) throw new ApiRequestError(body.error?.message ?? `Request failed (${response.status})`, body.error?.code ?? 'request_failed', response.status);
  return body as ApiResponse<T>;
};

export const loadManifest = async (signal?: AbortSignal): Promise<ApiResponse<DatasetManifest>> => request<DatasetManifest>('/manifest', undefined, signal);
export const loadView = async (options: QueryOptions, signal?: AbortSignal): Promise<ApiResponse<ViewPayload>> => request<ViewPayload>('/view', options, signal);
export const loadSummary = async (options: QueryOptions, signal?: AbortSignal): Promise<ApiResponse<SummaryPayload>> => request<SummaryPayload>('/summary', options, signal);
export const loadAnalysis = async (options: QueryOptions, signal?: AbortSignal): Promise<ApiResponse<AnalysisPayload>> => request<AnalysisPayload>('/analysis', options, signal);
export const loadCollisionDetail = async (id: string, signal?: AbortSignal): Promise<ApiResponse<CollisionDetail>> => request<CollisionDetail>(`/collision/${encodeURIComponent(id)}`, undefined, signal);
export const loadSchools = async (options: QueryOptions, signal?: AbortSignal): Promise<ApiResponse<SchoolsPayload>> => request<SchoolsPayload>('/schools', options, signal);

export const pointFeatureToGeoJson = (view: ViewPayload): GeoJSON.FeatureCollection<GeoJSON.Point, Record<string, unknown>> => ({
  type: 'FeatureCollection',
  features: view.features.features.map((feature) => ({
    type: 'Feature', id: feature.id, geometry: feature.geometry,
    properties: feature.properties as unknown as Record<string, unknown>,
  })),
});
