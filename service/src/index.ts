import {
  API_VERSION,
  MAX_ANALYSIS_RECORDS,
  MAX_VIEW_FEATURES,
  MAX_VIEW_RESPONSE_BYTES,
  QueryParseError,
  makeRequestKey,
  makeResponse,
  parseQuery,
  type AnalysisPayload,
  type BBox,
  type DatasetManifest,
  type GeoJsonFeatureCollection,
  type GeoJsonFeature,
  type ParsedQuery,
  type SummaryPayload,
  type ViewPayload,
} from '../contract';
import { buildAnalysis } from './analysis';
import { readDetailEvidence } from './detail';
import {
  DataUnavailableError,
  aggregateFeatures,
  pointFeatures,
  queryCollisionDetail,
  queryCollisionRows,
  queryDynamicAggregates,
  queryPrecomputedAggregates,
  querySchools,
  querySummary,
  countFilteredRecords,
  isDefaultFilters,
  readManifest,
  readSchoolCoverageProvenance,
} from './query';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string | number | boolean>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const headersFor = (cacheControl: string): Headers => {
  const headers = new Headers(CORS_HEADERS);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', cacheControl);
  return headers;
};

const json = (value: unknown, status = 200, cacheControl = 'public, max-age=300'): Response => {
  const headers = headersFor(cacheControl);
  return new Response(JSON.stringify(value), { status, headers });
};

const requestKeyForError = (url: URL): string => JSON.stringify({ path: url.pathname, query: url.search });

const errorResponse = (error: unknown, url: URL, requestKey = requestKeyForError(url)): Response => {
  if (error instanceof QueryParseError) {
    return json({ version: API_VERSION, requestKey, error: { code: error.code, message: error.message, ...(error.parameter ? { details: { parameter: error.parameter } } : {}) } }, 400, 'no-store');
  }
  if (error instanceof HttpError) {
    return json({ version: API_VERSION, requestKey, error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }, error.status, 'no-store');
  }
  if (error instanceof DataUnavailableError) {
    return json({ version: API_VERSION, requestKey, error: { code: error.code, message: error.message } }, error.status, 'no-store');
  }
  console.error('national query request failed', error);
  return json({ version: API_VERSION, requestKey, error: { code: 'internal_error', message: 'The national query service could not complete the request.' } }, 500, 'no-store');
};

const extentForView = (query: ParsedQuery, manifest: DatasetManifest): BBox => query.bbox ?? manifest.extent;

const bboxWidth = (bbox: BBox): number => bbox.world === true ? 360 : bbox.east >= bbox.west ? bbox.east - bbox.west : bbox.east + 360 - bbox.west;

const longitudeInBBox = (longitude: number, bbox: BBox): boolean => bbox.world === true || (bbox.east >= bbox.west ? longitude >= bbox.west && longitude <= bbox.east : longitude >= bbox.west || longitude <= bbox.east);
const containsExtent = (bbox: BBox, extent: BBox): boolean => {
  if (bbox.south > extent.south || bbox.north < extent.north) return false;
  if (bbox.world === true) return true;
  return bboxWidth(bbox) >= bboxWidth(extent) && longitudeInBBox(extent.west, bbox) && longitudeInBBox(extent.east, bbox);
};

const initialCellDegrees = (bbox: BBox, zoom: number | undefined): number => {
  const height = bbox.north - bbox.south;
  const width = bboxWidth(bbox);
  const viewportScale = Math.max(width / 45, height / 30, 0.01);
  const zoomScale = zoom === undefined ? 1 : Math.pow(2, Math.max(0, 8 - zoom));
  return Math.max(0.01, Math.min(180, viewportScale * zoomScale));
};

const roundedCellDegrees = (value: number): number => {
  const exponent = Math.floor(Math.log10(Math.max(value, 0.01)));
  const unit = Math.pow(10, exponent);
  const rounded = Math.ceil(value / unit) * unit;
  return Math.max(0.01, Math.min(180, Number(rounded.toFixed(6))));
};

const featureCollection = <P>(features: Array<GeoJsonFeature<P>>): GeoJsonFeatureCollection<P> => ({
  type: 'FeatureCollection',
  features,
});

const responseBytes = (datasetVersion: string, requestKey: string, data: ViewPayload): number => new TextEncoder().encode(JSON.stringify(makeResponse(datasetVersion, requestKey, data))).byteLength;
const workerCache = (): Cache | undefined => {
  if (typeof caches === 'undefined') return undefined;
  return (caches as unknown as { default?: Cache }).default;
};

const queryView = async (env: Env, query: ParsedQuery, manifest: DatasetManifest, requestKey: string): Promise<ViewPayload> => {
  const bounds = extentForView(query, manifest);
  const nationalDefault = isDefaultFilters(query.filters) && (query.bbox === undefined || containsExtent(query.bbox, manifest.extent));
  const summaryQuery = nationalDefault ? { ...query, bbox: undefined, zoom: undefined } : query;
  const recordCount = nationalDefault
    ? (await querySummary(env.DB, summaryQuery, manifest.datasetVersion)).metrics.collisions
    : await countFilteredRecords(env.DB, query.filters, query.bbox, manifest.datasetVersion);
  const pointModeAllowed = (query.zoom ?? 8) >= 13;
  if (pointModeAllowed && recordCount <= MAX_VIEW_FEATURES) {
    const rows = await queryCollisionRows(env.DB, query.filters, query.bbox, MAX_VIEW_FEATURES + 1, manifest.datasetVersion);
    if (rows.length <= MAX_VIEW_FEATURES) {
      const features = pointFeatures(rows);
      const payload: ViewPayload = {
        mode: 'points',
        features: featureCollection(features),
        recordCount,
        featureCount: features.length,
        complete: true,
        bounds,
        filters: query.filters,
        zoom: query.zoom ?? 8,
      };
      if (responseBytes(manifest.datasetVersion, requestKey, payload) <= MAX_VIEW_RESPONSE_BYTES) return payload;
    }
  }

  let cellDegrees = nationalDefault ? 1 : roundedCellDegrees(initialCellDegrees(bounds, query.zoom));
  let features: ReturnType<typeof aggregateFeatures> = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const rows = nationalDefault && Number.isInteger(cellDegrees) && [1, 2, 4].includes(cellDegrees)
      ? await queryPrecomputedAggregates(env.DB, manifest.datasetVersion, manifest.extent, cellDegrees)
      : await queryDynamicAggregates(env.DB, query.filters, query.bbox, cellDegrees, manifest.datasetVersion);
    features = aggregateFeatures(rows, cellDegrees);
    const payload: ViewPayload = {
      mode: 'aggregates',
      features: featureCollection(features),
      recordCount,
      featureCount: features.length,
      complete: true,
      aggregateCellDegrees: cellDegrees,
      bounds,
      filters: query.filters,
      zoom: query.zoom ?? 8,
    };
    if (features.length <= MAX_VIEW_FEATURES && responseBytes(manifest.datasetVersion, requestKey, payload) <= MAX_VIEW_RESPONSE_BYTES) return payload;
    cellDegrees = Math.min(180, Number((cellDegrees * 2).toFixed(6)));
  }
  throw new HttpError(503, 'view_too_dense', 'The selected view could not be reduced below the response limits.', {
    featureLimit: MAX_VIEW_FEATURES,
    featureCount: features.length,
  });
};

const parsePath = (pathname: string): { route: string; id?: string } => {
  const clean = pathname.replace(/\/+$/, '') || '/';
  const withoutApi = clean === '/api' ? '/' : clean.replace(/^\/api(?=\/|$)/, '') || '/';
  if (withoutApi.startsWith('/collision/')) {
    const encodedId = withoutApi.slice('/collision/'.length);
    let id: string;
    try { id = decodeURIComponent(encodedId); } catch { throw new HttpError(400, 'invalid_collision_id', 'Collision id is invalid.'); }
    const hasControlCharacter = Array.from(id).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    });
    if (!id || id.includes('/') || id.length > 120 || hasControlCharacter) throw new HttpError(400, 'invalid_collision_id', 'Collision id is invalid.');
    return { route: '/collision', id };
  }
  return { route: withoutApi };
};

const handle = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: new Headers(CORS_HEADERS) });
  if (request.method !== 'GET') return errorResponse(new HttpError(405, 'method_not_allowed', 'Only GET requests are supported.'), url);
  const { route, id } = parsePath(url.pathname);
  const query = parseQuery(url);
  const requestKey = makeRequestKey(route, query, {
    ...(id ? { id } : {}),
    ...(route === '/schools' && url.searchParams.has('q') ? { query: url.searchParams.get('q') ?? '' } : {}),
    ...(route === '/schools' && query.limit !== undefined ? { limit: query.limit } : {}),
    ...(route === '/schools' && query.offset !== undefined ? { offset: query.offset } : {}),
  });

  if (route === '/manifest') {
    const manifest = await readManifest(env.DB);
    return json(makeResponse(manifest.datasetVersion, requestKey, manifest));
  }

  const manifest = await readManifest(env.DB);
  if (route === '/summary') {
    const summaryQuery = query.bbox && containsExtent(query.bbox, manifest.extent) ? { ...query, bbox: undefined, zoom: undefined } : query;
    const result = await querySummary(env.DB, summaryQuery, manifest.datasetVersion);
    const data: SummaryPayload = { scope: { ...(query.bbox ? { bbox: query.bbox } : {}), filters: query.filters }, metrics: result.metrics, exact: true, precomputed: result.precomputed };
    return json(makeResponse(manifest.datasetVersion, requestKey, data));
  }

  if (route === '/view') {
    const data = await queryView(env, query, manifest, requestKey);
    return json(makeResponse(manifest.datasetVersion, requestKey, data));
  }

  if (route === '/collision') {
    const detail = await queryCollisionDetail(env.DB, id as string, manifest.datasetVersion);
    if (!detail) throw new HttpError(404, 'collision_not_found', 'Collision was not found in the active dataset.');
    const detailEvidence = await readDetailEvidence(env.DB, id as string);
    if (!detailEvidence) throw new HttpError(503, 'detail_unavailable', 'Full source evidence for this collision is temporarily unavailable.');
    return json(makeResponse(manifest.datasetVersion, requestKey, { ...detail, evidence: detailEvidence }), 200, 'public, max-age=3600');
  }

  if (route === '/schools') {
    const q = url.searchParams.get('q')?.trim() || undefined;
    const schools = await querySchools(env.DB, q, query.bbox, query.limit ?? 200, query.offset ?? 0, query.filters.country);
    const data = {
      schools,
      ...(query.bbox ? { bounds: query.bbox } : {}),
      ...(q ? { query: q } : {}),
      exact: true as const,
      coverage: await readSchoolCoverageProvenance(env.DB),
    };
    return json(makeResponse(manifest.datasetVersion, requestKey, data), 200, 'public, max-age=3600');
  }

  if (route === '/analysis') {
    if (!query.bbox) throw new HttpError(400, 'bbox_required', 'Analysis requires an explicit bbox.');
    const inputRecords = await countFilteredRecords(env.DB, query.filters, query.bbox, manifest.datasetVersion);
    if (inputRecords > MAX_ANALYSIS_RECORDS) throw new HttpError(413, 'analysis_limit_exceeded', 'Narrow the analysis area or filters before running persistent-location analysis.', { recordLimit: MAX_ANALYSIS_RECORDS, matchedRecords: inputRecords });
    const rows = await queryCollisionRows(env.DB, query.filters, query.bbox, MAX_ANALYSIS_RECORDS, manifest.datasetVersion);
    const result = await buildAnalysis(env.DB, rows, query);
    const data: AnalysisPayload = {
      scope: { bbox: query.bbox, filters: query.filters, radiusMetres: query.radiusMetres, harmFilter: query.harmFilter, ...(query.schoolId ? { selectedSchoolId: query.schoolId } : {}) },
      groups: result.groups,
      schoolCoverage: result.schoolCoverage,
      schoolCoverageProvenance: await readSchoolCoverageProvenance(env.DB),
      inputRecords,
      complete: true,
      edgeWarning: result.edgeWarning,
      limits: { recordLimit: MAX_ANALYSIS_RECORDS, returnedRecords: rows.length },
    };
    return json(makeResponse(manifest.datasetVersion, requestKey, data));
  }

  throw new HttpError(404, 'route_not_found', 'The requested national query route does not exist.');
};

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method !== 'GET' || url.pathname.endsWith('/manifest')) return await handle(request, env);
      const manifest = await readManifest(env.DB);
      const cacheUrl = new URL(url);
      cacheUrl.searchParams.set('__dataset', manifest.datasetVersion);
      const cacheKey = new Request(cacheUrl.toString(), request);
      const cache = workerCache();
      if (!cache) return await handle(request, env);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
      const response = await handle(request, env);
      if (response.ok && response.headers.get('Cache-Control')?.startsWith('public')) {
        if (ctx) ctx.waitUntil(cache.put(cacheKey, response.clone()));
      }
      return response;
    } catch (error) {
      return errorResponse(error, url);
    }
  },
};

export { handle };
