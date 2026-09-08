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
import type {
  StaticEvidenceRecord,
  StaticCollisionRecord,
  StaticManifest,
  StaticOverview,
  StaticCellOverview,
  StaticRecordTile,
  StaticSchoolCatalogue,
  StaticSchoolRecord,
} from './contract';
import { staticRecordToDetail } from './engine';
import { parseFacetDimensions, selectCells, summarizeFacets } from './engine';
import { StaticWorkerClient } from './worker-client';

export interface StaticQueryOptions {
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

export class StaticDataError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code = 'static_data_unavailable', status = 503) {
    super(message);
    this.name = 'StaticDataError';
    this.code = code;
    this.status = status;
  }
}

const basePath = (): string => {
  const base = (import.meta.env.BASE_URL as string | undefined) ?? '/';
  return `${base.replace(/\/+$/, '')}/data/national/`;
};

const withVersion = (path: string, version: string, artifactHash?: string): string => {
  const normalized = path.replace(/^\/+/, '');
  const hash = artifactHash ? `&h=${encodeURIComponent(artifactHash)}` : '';
  return `${basePath()}${normalized}?v=${encodeURIComponent(version)}${hash}`;
};

const responseKey = (path: string, options?: StaticQueryOptions): string => `${path}?${options ? JSON.stringify(options) : ''}`;

const abortError = (): Error => Object.assign(new Error('The static data request was aborted.'), { name: 'AbortError' });

const raceAbort = async <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return promise;
  if (signal.aborted) throw abortError();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { signal.removeEventListener('abort', onAbort); reject(abortError()); };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => { signal.removeEventListener('abort', onAbort); resolve(value); }, (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
};

const toHex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

const sha256 = async (bytes: ArrayBuffer): Promise<string | null> => {
  if (!globalThis.crypto?.subtle) return null;
  return toHex(await globalThis.crypto.subtle.digest('SHA-256', bytes));
};

type ExpectedArtifact = { sha256: string; uncompressedBytes?: number; uncompressedSha256?: string };

const stripPath = (path: string): string => path.replace(/^\/+/, '').replace(/^data\/national\//, '');

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const asString = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;

const asNumber = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const countKnown = (schools: StaticSchoolRecord[], country: StaticSchoolRecord['country'], field: 'status' | 'phase'): number =>
  schools.filter((school) => school.country === country && Boolean(school[field].trim())).length;

const sourceFor = (provenance: Record<string, unknown>, name: string): Record<string, unknown> => {
  const sources = Array.isArray(provenance.sources) ? provenance.sources : [];
  return asRecord(sources.find((source) => asString(asRecord(source).name)?.includes(name)));
};

const schoolCoverageFromCatalogue = (catalogue: StaticSchoolCatalogue): SchoolsPayload['coverage'] => {
  const provenance = asRecord(catalogue.provenance);
  const counts = asRecord(provenance.counts);
  const englandCounts = asRecord(counts.england);
  const walesMaintainedCounts = asRecord(counts.walesMaintained);
  const walesPruCounts = asRecord(counts.walesPru);
  const englandSource = sourceFor(provenance, 'GIAS');
  const walesSource = sourceFor(provenance, 'Welsh Government DataMapWales maintained schools');
  const coverage = asRecord(provenance.coverage);
  const walesNote = asString(coverage.note);
  const walesSchools = catalogue.schools.filter((school) => school.country === 'Wales');
  return [
    {
      country: 'England',
      publisher: 'Department for Education',
      dataset: 'Get Information about Schools',
      ...(asString(englandSource.url) ? { sourceUrl: asString(englandSource.url) } : {}),
      ...(asString(englandSource.retrievedAt) ? { retrievedAt: asString(englandSource.retrievedAt) } : {}),
      totalRows: asNumber(englandCounts.sourceRows) ?? catalogue.schools.filter((school) => school.country === 'England').length,
      coordinateRows: catalogue.schools.filter((school) => school.country === 'England' && Number.isFinite(school.lat) && Number.isFinite(school.lon)).length,
      statusKnownRows: countKnown(catalogue.schools, 'England', 'status'),
      phaseKnownRows: countKnown(catalogue.schools, 'England', 'phase'),
    },
    {
      country: 'Wales',
      publisher: 'Welsh Government',
      dataset: 'DataMapWales maintained schools and pupil referral units',
      ...(asString(walesSource.url) ? { sourceUrl: asString(walesSource.url) } : {}),
      ...(asString(walesSource.retrievedAt) ? { retrievedAt: asString(walesSource.retrievedAt) } : {}),
      totalRows: (asNumber(walesMaintainedCounts.sourceRows) ?? 0) + (asNumber(walesPruCounts.sourceRows) ?? 0) || walesSchools.length,
      coordinateRows: walesSchools.filter((school) => Number.isFinite(school.lat) && Number.isFinite(school.lon)).length,
      statusKnownRows: countKnown(catalogue.schools, 'Wales', 'status'),
      phaseKnownRows: countKnown(catalogue.schools, 'Wales', 'phase'),
      ...(walesNote ? { note: walesNote } : {}),
    },
  ];
};

const authorityBoundsFromOverview = (overview: StaticOverview): Map<string, BBox> => {
  const bounds = new Map<string, BBox>();
  Object.values(overview.cells).forEach((cell) => {
    Object.keys(cell.facets).forEach((key) => {
      const dimensions = parseFacetDimensions(key);
      if (!dimensions) return;
      const current = bounds.get(dimensions.authorityCode);
      bounds.set(dimensions.authorityCode, current ? {
        west: Math.min(current.west, cell.bounds.west),
        south: Math.min(current.south, cell.bounds.south),
        east: Math.max(current.east, cell.bounds.east),
        north: Math.max(current.north, cell.bounds.north),
      } : { ...cell.bounds });
    });
  });
  return bounds;
};

const qualityNoticesFromManifest = (manifest: StaticManifest): DatasetManifest['qualityNotices'] => {
  const notices: DatasetManifest['qualityNotices'] = [
    {
      id: 'reported-collisions',
      title: 'Reported personal-injury collisions',
      text: 'STATS19 records reported personal-injury collisions on public roads; it is not a census of every road incident.',
    },
    {
      id: 'coordinate-scope',
      title: 'Mappable collision scope',
      text: 'Collisions without valid England or Wales coordinates remain in the source detail artifact and are excluded from map queries.',
    },
    {
      id: 'detail-storage',
      title: 'On-demand source evidence',
      text: 'Joined collision, casualty and vehicle evidence is gzip-compressed in separate chunks and loaded only for a collision detail request.',
    },
  ];
  const nationalManifest = asRecord(manifest.provenance.nationalManifest);
  const limitations = Array.isArray(nationalManifest.limitations) ? nationalManifest.limitations : [];
  limitations.forEach((value, index) => {
    const text = asString(value);
    if (!text || /excluded from version control/i.test(text) || notices.some((notice) => notice.text === text)) return;
    notices.push({ id: `national-limitation-${index + 1}`, title: 'Source limitation', text });
  });
  return notices;
};

export class StaticDataRuntime {
  private static readonly MAX_TILE_CACHE = 48;
  private static readonly MAX_EVIDENCE_CACHE = 4;
  private static readonly MAX_RECORD_INDEX = 50_000;
  private readonly worker = new StaticWorkerClient();
  private manifestPromise: Promise<StaticManifest> | null = null;
  private overviewPromise: Promise<StaticOverview> | null = null;
  private schoolsPromise: Promise<StaticSchoolCatalogue> | null = null;
  private readonly tileCache = new Map<string, Promise<StaticRecordTile>>();
  private readonly evidenceCache = new Map<string, Promise<StaticEvidenceRecord[]>>();
  private readonly recordsById = new Map<string, StaticCollisionRecord>();
  private initializedWorker: Promise<void> | null = null;

  private expectedArtifact(manifest: StaticManifest, path: string): ExpectedArtifact | undefined {
    const normalized = stripPath(path);
    return Object.values(manifest.artifacts).find((artifact) => stripPath(artifact.path) === normalized);
  }

  private async fetchBytes(path: string, manifest: StaticManifest | null, signal?: AbortSignal): Promise<{ bytes: ArrayBuffer; gzip: boolean }> {
    const version = manifest?.datasetVersion ?? 'manifest';
    const expected = manifest ? this.expectedArtifact(manifest, path) : undefined;
    const response = await fetch(withVersion(path, version, expected?.sha256), { signal: manifest ? undefined : signal, headers: { Accept: 'application/json, application/gzip' }, cache: manifest ? 'default' : 'no-store' });
    if (!response.ok) throw new StaticDataError(`Static data request failed (${response.status}).`, 'request_failed', response.status);
    const bytes = await response.arrayBuffer();
    const view = new Uint8Array(bytes);
    const gzip = view.length >= 2 && view[0] === 0x1f && view[1] === 0x8b;
    if (expected && gzip) {
      const actual = await sha256(bytes);
      if (!actual) throw new StaticDataError('This browser cannot verify static artifact integrity (Web Crypto is unavailable).', 'crypto_unsupported');
      if (actual !== expected.sha256) throw new StaticDataError(`Static artifact hash mismatch for ${stripPath(path)}.`, 'artifact_hash_mismatch');
    } else if (expected && !gzip) {
      const actual = await sha256(bytes);
      if (!actual) throw new StaticDataError('This browser cannot verify static artifact integrity (Web Crypto is unavailable).', 'crypto_unsupported');
      if (!expected.uncompressedSha256) throw new StaticDataError(`Static artifact ${stripPath(path)} lacks a decoded-content checksum.`, 'artifact_hash_missing');
      if (actual !== expected.uncompressedSha256) throw new StaticDataError(`Static artifact hash mismatch for decoded ${stripPath(path)}.`, 'artifact_hash_mismatch');
      if (expected.uncompressedBytes !== undefined && bytes.byteLength !== expected.uncompressedBytes) throw new StaticDataError(`Static artifact size mismatch for decoded ${stripPath(path)}.`, 'artifact_hash_mismatch');
    }
    return { bytes, gzip };
  }

  private async fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${basePath()}${path.replace(/^\/+/, '')}?fresh=${Date.now()}`, { headers: { Accept: 'application/json' }, cache: 'no-store', signal });
    if (!response.ok) throw new StaticDataError(`Static manifest request failed (${response.status}).`, 'manifest_failed', response.status);
    try { return await response.json() as T; } catch { throw new StaticDataError('The static national manifest is not valid JSON.', 'manifest_invalid'); }
  }

  private async decodeGzip<T>(path: string, signal?: AbortSignal): Promise<T> {
    const manifest = await this.loadStaticManifest(signal);
    const artifact = await this.fetchBytes(path, manifest, signal);
    if (!artifact.gzip) {
      try { return JSON.parse(new TextDecoder().decode(artifact.bytes)) as T; } catch { throw new StaticDataError(`Static decoded artifact ${stripPath(path)} could not be parsed.`, 'artifact_invalid'); }
    }
    const Decompression = globalThis.DecompressionStream;
    if (!Decompression) throw new StaticDataError('This browser cannot decompress the static national data (DecompressionStream is unavailable).', 'gzip_unsupported');
    try {
      const stream = new Blob([artifact.bytes]).stream().pipeThrough(new Decompression('gzip'));
      const text = await new Response(stream).text();
      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof StaticDataError) throw error;
      throw new StaticDataError(`Static gzip artifact ${stripPath(path)} could not be decoded.`, 'artifact_invalid');
    }
  }

  private async loadStaticManifest(signal?: AbortSignal): Promise<StaticManifest> {
    if (!this.manifestPromise) {
      // The shared promise must not be owned by one component mount. React
      // StrictMode and a fast filter change can abort the first waiter while
      // a second waiter still needs the same immutable manifest.
      this.manifestPromise = this.fetchJson<StaticManifest>('manifest.json').then((manifest) => {
        if (manifest.schemaVersion !== 'weca-static-national/v1') throw new StaticDataError('The static national manifest has an unsupported schema.', 'manifest_schema');
        return manifest;
      }).catch((error) => { this.manifestPromise = null; throw error; });
    }
    return raceAbort(this.manifestPromise, signal);
  }

  private async loadOverview(signal?: AbortSignal): Promise<StaticOverview> {
    if (!this.overviewPromise) {
      this.overviewPromise = this.decodeGzip<StaticOverview>('overview.json.gz').then((overview) => {
        if (!overview || overview.schemaVersion !== 'weca-static-national/v1') throw new StaticDataError('The static national overview has an unsupported schema.', 'overview_schema');
        return overview;
      }).catch((error) => { this.overviewPromise = null; throw error; });
    }
    return raceAbort(this.overviewPromise, signal);
  }

  private async ensureWorker(signal?: AbortSignal): Promise<{ manifest: StaticManifest; overview: StaticOverview }> {
    const [manifest, overview] = await Promise.all([this.loadStaticManifest(signal), this.loadOverview(signal)]);
    if (!this.initializedWorker || !this.worker.isInitialized) {
      this.initializedWorker = this.worker.initialize(overview).then(() => undefined).catch((error) => { this.initializedWorker = null; throw error; });
    }
    await raceAbort(this.initializedWorker, signal);
    return { manifest, overview };
  }

  private tilePath(manifest: StaticManifest, cellKey: string): string {
    return manifest.tiles[cellKey] ?? `${manifest.paths.tiles.replace(/\/+$/, '')}/${cellKey}.json.gz`;
  }

  private async loadTile(cellKey: string, manifest: StaticManifest, signal?: AbortSignal): Promise<StaticRecordTile> {
    const cached = this.tileCache.get(cellKey);
    if (cached) {
      this.tileCache.delete(cellKey);
      this.tileCache.set(cellKey, cached);
      return raceAbort(cached, signal);
    }
    const promise = this.decodeGzip<StaticRecordTile>(this.tilePath(manifest, cellKey)).then((tile) => {
      tile.forEach((record) => {
        this.recordsById.delete(record.id);
        this.recordsById.set(record.id, record);
      });
      while (this.recordsById.size > StaticDataRuntime.MAX_RECORD_INDEX) this.recordsById.delete(this.recordsById.keys().next().value as string);
      while (this.tileCache.size > StaticDataRuntime.MAX_TILE_CACHE) {
        const oldest = this.tileCache.keys().next().value as string | undefined;
        if (!oldest || oldest === cellKey) break;
        this.tileCache.delete(oldest);
      }
      return tile;
    }).catch((error) => { this.tileCache.delete(cellKey); throw error; });
    this.tileCache.set(cellKey, promise);
    return raceAbort(promise, signal);
  }

  private async loadTiles(cells: Array<{ cellKey: string }>, manifest: StaticManifest, signal?: AbortSignal): Promise<StaticCollisionRecord[]> {
    const unique = [...new Set(cells.map((cell) => cell.cellKey))];
    const tiles: StaticRecordTile[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < unique.length) {
        if (signal?.aborted) throw abortError();
        const cellKey = unique[cursor++];
        tiles.push(await this.loadTile(cellKey, manifest, signal));
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, unique.length) }, () => worker()));
    return tiles.flat();
  }

  private matchingCells(cells: StaticCellOverview[], filters: QueryFilters): StaticCellOverview[] {
    return cells.filter((cell) => summarizeFacets([cell], filters).collisions > 0);
  }

  private async ensureSchools(signal?: AbortSignal): Promise<StaticSchoolCatalogue> {
    if (!this.schoolsPromise) {
      this.schoolsPromise = this.decodeGzip<StaticSchoolCatalogue>('schools.json.gz').then((catalogue) => {
        if (!catalogue || catalogue.schemaVersion !== 'weca-static-national/v1' || !Array.isArray(catalogue.schools)) throw new StaticDataError('The static school catalogue has an unsupported schema.', 'schools_schema');
        return catalogue;
      }).catch((error) => { this.schoolsPromise = null; throw error; });
    }
    const catalogue = await raceAbort(this.schoolsPromise, signal);
    await this.ensureWorker(signal);
    await this.worker.setSchools(catalogue.schools, signal);
    return catalogue;
  }

  private manifestToApi(manifest: StaticManifest, overview?: StaticOverview): DatasetManifest {
    const sourceManifest = asRecord(manifest.provenance.nationalManifest);
    const authorityBounds = overview ? authorityBoundsFromOverview(overview) : new Map<string, BBox>();
    return {
      datasetVersion: manifest.datasetVersion,
      schemaVersion: manifest.schemaVersion,
      title: 'England & Wales Collision Map',
      scope: 'England and Wales',
      years: manifest.years,
      extent: manifest.extent,
      authorities: manifest.authorities.map((authority) => ({ code: authority.code, name: authority.name, country: authority.country, ...(authorityBounds.get(authority.code) ? { bbox: authorityBounds.get(authority.code) } : {}) })),
      collisionCount: manifest.collisionCount,
      casualtyCount: null,
      source: { ...manifest.source, urls: [...manifest.source.urls, ...[sourceManifest.sourceUrl, sourceManifest.codebookUrl].filter((value): value is string => typeof value === 'string' && !manifest.source.urls.includes(value))] },
      generatedAt: manifest.generatedAt,
      qualityNotices: qualityNoticesFromManifest(manifest),
      limits: { viewFeatureLimit: 2_000, viewResponseBytes: 1_000_000, analysisRecordLimit: 10_000, analysisRequiresBbox: true },
    };
  }

  async loadManifest(signal?: AbortSignal): Promise<ApiResponse<DatasetManifest>> {
    const [manifest, overview] = await Promise.all([this.loadStaticManifest(signal), this.loadOverview(signal)]);
    return { version: 'national.v1', datasetVersion: manifest.datasetVersion, requestKey: 'static:manifest', data: this.manifestToApi(manifest, overview) };
  }

  async loadSummary(options: StaticQueryOptions, signal?: AbortSignal): Promise<ApiResponse<SummaryPayload>> {
    const { manifest, overview } = await this.ensureWorker(signal);
    const selection = selectCells(overview, options.bbox);
    const records = await this.loadTiles(this.matchingCells([...selection.boundary], options.filters), manifest, signal);
    const metrics = await this.worker.summary(records, options.filters, options.bbox, signal);
    return { version: 'national.v1', datasetVersion: manifest.datasetVersion, requestKey: responseKey('/summary', options), data: { scope: { filters: options.filters, ...(options.bbox ? { bbox: options.bbox } : {}) }, metrics, exact: true, precomputed: !options.bbox } };
  }

  async loadView(options: StaticQueryOptions, signal?: AbortSignal): Promise<ApiResponse<ViewPayload>> {
    const { manifest, overview } = await this.ensureWorker(signal);
    const selection = selectCells(overview, options.bbox);
    const matchingBoundary = this.matchingCells(selection.boundary, options.filters);
    const matchingContained = this.matchingCells(selection.contained, options.filters);
    const edgeRecords = await this.loadTiles(matchingBoundary, manifest, signal);
    const estimate = await this.worker.summary(edgeRecords, options.filters, options.bbox, signal);
    const pointMode = estimate.collisions <= 2_000;
    const pointRecords = pointMode ? await this.loadTiles([...matchingContained, ...matchingBoundary], manifest, signal) : undefined;
    const refineRecords = !pointMode && options.bbox && matchingContained.length <= 4 ? await this.loadTiles([...matchingContained, ...matchingBoundary], manifest, signal) : undefined;
    const view = await this.worker.view(edgeRecords, options.filters, options.bbox, options.zoom, pointRecords, refineRecords, signal);
    return { version: 'national.v1', datasetVersion: manifest.datasetVersion, requestKey: responseKey('/view', options), data: view };
  }

  async loadAnalysis(options: StaticQueryOptions, signal?: AbortSignal): Promise<ApiResponse<AnalysisPayload>> {
    if (!options.bbox) throw new StaticDataError('Hotspot analysis requires a map bounding box.', 'bbox_required', 400);
    const { manifest, overview } = await this.ensureWorker(signal);
    const selection = selectCells(overview, options.bbox);
    const matchingBoundary = this.matchingCells(selection.boundary, options.filters);
    const matchingContained = this.matchingCells(selection.contained, options.filters);
    const edgeRecords = await this.loadTiles(matchingBoundary, manifest, signal);
    const summary = await this.worker.summary(edgeRecords, options.filters, options.bbox, signal);
    if (summary.collisions > 10_000) throw new StaticDataError('Narrow the map or filters below 10,000 matching records before analysis.', 'analysis_limit_exceeded', 413);
    const records = await this.loadTiles([...matchingContained, ...matchingBoundary], manifest, signal);
    const schools = (await this.ensureSchools(signal)).schools;
    const analysis = await this.worker.analysis(records, schools, options.filters, options.bbox, (options.radiusMetres ?? 100) as 50 | 100 | 200 | 500, options.harmFilter ?? 'all', options.schoolId, options.schoolDistanceMetres, signal);
    return { version: 'national.v1', datasetVersion: manifest.datasetVersion, requestKey: responseKey('/analysis', options), data: analysis };
  }

  async loadSchools(options: StaticQueryOptions, signal?: AbortSignal): Promise<ApiResponse<SchoolsPayload>> {
    const { manifest } = await this.ensureWorker(signal);
    const catalogue = await this.ensureSchools(signal);
    const schools = await this.worker.schools(options.query ?? '', options.bbox, options.offset, options.limit, signal);
    const dataSchools = schools.map((school) => ({ id: school.id, name: school.name, country: school.country, latitude: school.lat, longitude: school.lon, status: school.status, phase: school.phase }));
    const coverage = schoolCoverageFromCatalogue(catalogue);
    return { version: 'national.v1', datasetVersion: manifest.datasetVersion, requestKey: responseKey('/schools', options), data: { schools: dataSchools, query: options.query, exact: true, ...(options.bbox ? { bounds: options.bbox } : {}), ...(coverage ? { coverage } : {}) } };
  }

  async loadCollisionDetail(id: string, signal?: AbortSignal): Promise<ApiResponse<CollisionDetail>> {
    const manifest = await this.loadStaticManifest(signal);
    if (!globalThis.crypto?.subtle) throw new StaticDataError('This browser cannot verify static collision evidence (Web Crypto is unavailable).', 'crypto_unsupported');
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
    const bucket = [...new Uint8Array(digest)][0].toString(16).padStart(2, '0');
    const path = manifest.evidenceBuckets[bucket] ?? `${manifest.paths.evidence.replace(/\/+$/, '')}/${bucket}.json.gz`;
    let promise = this.evidenceCache.get(bucket);
    if (promise) {
      this.evidenceCache.delete(bucket);
      this.evidenceCache.set(bucket, promise);
    } else {
      promise = this.decodeGzip<StaticEvidenceRecord[]>(path).catch((error) => { this.evidenceCache.delete(bucket); throw error; });
      this.evidenceCache.set(bucket, promise);
      promise.then(() => {
        while (this.evidenceCache.size > StaticDataRuntime.MAX_EVIDENCE_CACHE) {
          const oldest = this.evidenceCache.keys().next().value as string | undefined;
          if (!oldest || oldest === bucket) break;
          this.evidenceCache.delete(oldest);
        }
      }).catch(() => undefined);
    }
    const records = await raceAbort(promise, signal);
    const evidence = records.find((entry) => entry.id === id);
    if (!evidence) throw new StaticDataError('The requested collision is not present in this release.', 'collision_not_found', 404);
    const detail = staticRecordToDetail(evidence, evidence.evidence);
    return { version: 'national.v1', datasetVersion: manifest.datasetVersion, requestKey: `static:collision:${id}`, data: detail };
  }

  dispose(): void {
    this.worker.dispose();
    this.tileCache.clear(); this.evidenceCache.clear(); this.recordsById.clear();
  }
}

export const staticDataRuntime = new StaticDataRuntime();

export const loadStaticManifest = (signal?: AbortSignal): Promise<ApiResponse<DatasetManifest>> => staticDataRuntime.loadManifest(signal);
export const loadStaticView = (options: StaticQueryOptions, signal?: AbortSignal): Promise<ApiResponse<ViewPayload>> => staticDataRuntime.loadView(options, signal);
export const loadStaticSummary = (options: StaticQueryOptions, signal?: AbortSignal): Promise<ApiResponse<SummaryPayload>> => staticDataRuntime.loadSummary(options, signal);
export const loadStaticAnalysis = (options: StaticQueryOptions, signal?: AbortSignal): Promise<ApiResponse<AnalysisPayload>> => staticDataRuntime.loadAnalysis(options, signal);
export const loadStaticCollisionDetail = (id: string, signal?: AbortSignal): Promise<ApiResponse<CollisionDetail>> => staticDataRuntime.loadCollisionDetail(id, signal);
export const loadStaticSchools = (options: StaticQueryOptions, signal?: AbortSignal): Promise<ApiResponse<SchoolsPayload>> => staticDataRuntime.loadSchools(options, signal);
