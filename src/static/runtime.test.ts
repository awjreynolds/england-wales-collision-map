import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BBox, QueryFilters, SummaryMetrics, ViewPayload } from '../../service/contract';
import { buildView, mergeSummaryMetrics, metricForRecord, selectCells, summarizeFacets, summarizeRecords } from './engine';
import { STATIC_SCHEMA_VERSION, staticCellBounds, type StaticCollisionEvidence, type StaticCollisionRecord, type StaticManifest, type StaticOverview } from './contract';
import { StaticDataRuntime } from './runtime';

const filters: QueryFilters = { years: [], authorities: [], severities: [], pedestrian: 'all', cycle: 'all', motorcycle: 'all' };
const bbox: BBox = { west: -2.49, south: 51.01, east: -2.26, north: 51.24 };
const cellKey = 'x710y564';
const tilePath = `tiles/${cellKey}.json.gz`;

const record = (id: string): StaticCollisionRecord => ({
  id, datasetVersion: 'fixture-v1', year: 2021, date: '2021-01-01', time: '12:00',
  latitude: 51.1, longitude: -2.4, country: 'England', authorityCode: 'E00000001', authorityName: 'Fixture',
  roadName: 'Test Road', roadNumber: null, speedLimit: 30, junctionDetail: null, severity: 'slight',
  casualtyCount: 1, fatalities: 0, seriousCasualties: 0, slightCasualties: 1, ksiCasualties: 0,
  pedestrianInvolved: false, cycleInvolved: false, motorcycleInvolved: false,
});

const summary = (): SummaryMetrics => ({
  collisions: 2_001,
  collisionSeverity: { fatal: 0, serious: 0, slight: 2_001, unknown: 0 },
  casualties: {
    total: { value: 2_001, unknownRecords: 0 }, fatalities: { value: 0, unknownRecords: 0 },
    serious: { value: 0, unknownRecords: 0 }, slight: { value: 2_001, unknownRecords: 0 }, ksi: { value: 0, unknownRecords: 0 },
  },
  ksiCollisions: 0, yearsRepresented: [2021], complete: true,
});

const view = (): ViewPayload => ({
  mode: 'aggregates', features: { type: 'FeatureCollection', features: [] }, recordCount: 2_001,
  featureCount: 0, complete: true, aggregateCellDegrees: .25, bounds: bbox, filters, zoom: 8,
});

const gzip = async (value: unknown): Promise<Uint8Array> => {
  const stream = new CompressionStream('gzip');
  const writer = stream.writable.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(value)));
  await writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
};

const digest = async (bytes: Uint8Array): Promise<string> => {
  const hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer as ArrayBuffer);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const overview = (): StaticOverview => {
  const sample = record('fixture-1');
  return {
    schemaVersion: STATIC_SCHEMA_VERSION,
    cellSizeDegrees: .25,
    cells: {
      [cellKey]: {
        cellKey, bounds: staticCellBounds(cellKey), recordCount: 1,
        facets: {
          '2021|England|E00000001|slight|n|n|n': { additiveSummaryMetrics: metricForRecord(sample) },
        },
      },
    },
  };
};

const denseOverview = (count: number): StaticOverview => {
  const sample = record('fixture-1');
  const sampleMetrics = metricForRecord(sample);
  const additiveSummaryMetrics = {
    ...sampleMetrics,
    collisions: count,
    slightCollisions: count,
    casualtyCount: count,
    slightCasualties: count,
    ksiCollisions: 0,
  };
  return {
    schemaVersion: STATIC_SCHEMA_VERSION,
    cellSizeDegrees: .25,
    cells: {
      [cellKey]: {
        cellKey, bounds: staticCellBounds(cellKey), recordCount: count,
        facets: { '2021|England|E00000001|slight|n|n|n': { additiveSummaryMetrics } },
      },
    },
  };
};

const buildFixture = async (): Promise<{ manifest: StaticManifest; bytes: Map<string, Uint8Array>; evidenceBucket: string; detail: StaticCollisionRecord & { evidence: StaticCollisionEvidence } }> => {
  const tile = [record('fixture-1')];
  const evidence: StaticCollisionRecord & { evidence: StaticCollisionEvidence } = {
    ...record('fixture-1'), evidence: { collision: { id: 'fixture-1' }, casualties: [], vehicles: [] },
  };
  const compressed = new Map<string, Uint8Array>([
    ['overview.json.gz', await gzip(overview())],
    [tilePath, await gzip(tile)],
  ]);
  const evidenceBucket = (new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(evidence.id))))[0].toString(16).padStart(2, '0');
  compressed.set(`evidence/${evidenceBucket}.json.gz`, await gzip([evidence]));
  const artifacts = Object.fromEntries(await Promise.all([...compressed.entries()].map(async ([path, bytes]) => [path, { path, bytes: bytes.byteLength, sha256: await digest(bytes), uncompressedBytes: 1 }]))) as StaticManifest['artifacts'];
  const manifest: StaticManifest = {
    schemaVersion: STATIC_SCHEMA_VERSION, datasetVersion: 'fixture-v1', nationalDatasetVersion: 'fixture-national-v1', generatedAt: '2026-01-01T00:00:00Z',
    years: [2021], scope: 'England and Wales', extent: { west: -2.4, south: 51.1, east: -2.4, north: 51.1 }, collisionCount: 1, detailCount: 1, schoolCount: 0,
    cellSizeDegrees: .25, evidenceBucketCount: 256, source: { publisher: 'Fixture', dataset: 'Fixture', urls: [] },
    authorities: [{ code: 'E00000001', name: 'Fixture', country: 'England' }], paths: { overview: 'overview.json.gz', tiles: 'tiles/', evidence: 'evidence/', schools: 'schools.json.gz' },
    tiles: { [cellKey]: tilePath }, evidenceBuckets: { [evidenceBucket]: `evidence/${evidenceBucket}.json.gz` }, artifacts,
    provenance: { nationalManifest: {}, serviceImportManifest: {}, staticPublisherSha256: '', staticContractSha256: '', schoolProvenanceSha256: '', schoolOutputSha256: '' },
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  compressed.set('manifest.json', manifestBytes);
  return { manifest, bytes: compressed, evidenceBucket, detail: evidence };
};

const buildDenseFixture = async (count = 2_001): Promise<Awaited<ReturnType<typeof buildFixture>>> => {
  const dense = await buildFixture();
  const tile = Array.from({ length: count }, (_, index) => record(index === 0 ? 'fixture-1' : `fixture-${index + 1}`));
  const overviewBytes = await gzip(denseOverview(count));
  const tileBytes = await gzip(tile);
  dense.bytes.set('overview.json.gz', overviewBytes);
  dense.bytes.set(tilePath, tileBytes);
  dense.manifest.collisionCount = count;
  dense.manifest.detailCount = count;
  dense.manifest.artifacts['overview.json.gz'] = { ...dense.manifest.artifacts['overview.json.gz'], bytes: overviewBytes.byteLength, sha256: await digest(overviewBytes) };
  dense.manifest.artifacts[tilePath] = { ...dense.manifest.artifacts[tilePath], bytes: tileBytes.byteLength, sha256: await digest(tileBytes) };
  dense.bytes.set('manifest.json', new TextEncoder().encode(JSON.stringify(dense.manifest)));
  return dense;
};

class StubWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage(message: { id: number; type: string }): void {
    const value = message.type === 'init' || message.type === 'schools' ? true : message.type === 'summary' ? summary() : view();
    queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true, value } } as MessageEvent));
  }
  terminate(): void { /* fixture worker */ }
}

type EngineWorkerMessage = {
  id: number;
  type: string;
  overview?: StaticOverview;
  records?: StaticCollisionRecord[];
  pointRecords?: StaticCollisionRecord[];
  refineRecords?: StaticCollisionRecord[];
  filters?: QueryFilters;
  bbox?: BBox;
  zoom?: number;
};

class EngineStubWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private overview: StaticOverview | null = null;
  postMessage(message: EngineWorkerMessage): void {
    let value: unknown;
    if (message.type === 'init') {
      this.overview = message.overview ?? null;
      value = true;
    } else if (message.type === 'summary') {
      if (!this.overview || !message.filters) throw new Error('Missing engine fixture state.');
      const selection = selectCells(this.overview, message.bbox);
      value = mergeSummaryMetrics(summarizeFacets(selection.contained, message.filters), summarizeRecords(message.records ?? [], message.filters, message.bbox));
    } else if (message.type === 'view') {
      if (!this.overview || !message.filters) throw new Error('Missing engine fixture state.');
      value = buildView({ overview: this.overview, records: message.records ?? [], pointRecords: message.pointRecords, refineRecords: message.refineRecords, filters: message.filters, bbox: message.bbox, zoom: message.zoom });
    } else {
      value = true;
    }
    queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true, value } } as MessageEvent));
  }
  terminate(): void { /* fixture worker */ }
}

describe('static data runtime', () => {
  let fixture: Awaited<ReturnType<typeof buildFixture>>;
  let calls: string[];

  beforeEach(async () => {
    fixture = await buildFixture();
    calls = [];
    vi.stubGlobal('Worker', StubWorker);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const path = url.slice(url.indexOf('/data/national/') + '/data/national/'.length).split('?')[0];
      const bytes = fixture.bytes.get(path);
      if (!bytes) return new Response('Not found', { status: 404 });
      return new Response(bytes.buffer as ArrayBuffer, { status: 200 });
    }));
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('does not let an aborted first manifest consumer poison the shared StrictMode load', async () => {
    const runtime = new StaticDataRuntime();
    const controller = new AbortController();
    const first = runtime.loadManifest(controller.signal);
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = await runtime.loadManifest();
    expect(second.datasetVersion).toBe('fixture-v1');
    expect(calls.filter((url) => url.includes('manifest.json')).length).toBe(1);
    expect(second.data.limits.viewFeatureLimit).toBe(50_000);
    expect(second.data.limits.viewResponseBytes).toBe(50_000_000);
  });

  it('loads only the intersecting boundary tile for an exact summary', async () => {
    const runtime = new StaticDataRuntime();
    const response = await runtime.loadSummary({ filters, bbox });
    expect(response.data.exact).toBe(true);
    expect(calls.filter((url) => url.includes(`/tiles/${cellKey}.json.gz`))).toHaveLength(1);
    expect(calls.some((url) => url.includes('/tiles/') && !url.includes(cellKey))).toBe(false);
  });

  it('reuses the sparse boundary tile when building a bounded aggregate view', async () => {
    const runtime = new StaticDataRuntime();
    const response = await runtime.loadView({ filters, bbox, zoom: 8 });
    expect(response.data.mode).toBe('aggregates');
    expect(calls.filter((url) => url.includes(`/tiles/${cellKey}.json.gz`))).toHaveLength(1);
  });

  it('uses the actual engine to return more than 2,000 bounded points only at high zoom', async () => {
    fixture = await buildDenseFixture();
    vi.stubGlobal('Worker', EngineStubWorker);
    const highZoomRuntime = new StaticDataRuntime();
    const highZoom = await highZoomRuntime.loadView({ filters, bbox, zoom: 11 });
    expect(highZoom.data.mode).toBe('points');
    expect(highZoom.data.recordCount).toBe(2_001);
    expect(highZoom.data.featureCount).toBe(2_001);

    highZoomRuntime.dispose();
    const lowZoomRuntime = new StaticDataRuntime();
    const lowZoom = await lowZoomRuntime.loadView({ filters, bbox, zoom: 10.99 });
    expect(lowZoom.data.mode).toBe('aggregates');
    expect(lowZoom.data.recordCount).toBe(2_001);
    expect(lowZoom.data.featureCount).toBeLessThanOrEqual(2_000);
  });

  it('fetches collision evidence directly by deterministic hash bucket', async () => {
    const runtime = new StaticDataRuntime();
    const response = await runtime.loadCollisionDetail('fixture-1');
    expect(response.data.id).toBe('fixture-1');
    expect(response.data.evidence.collision.id).toBe('fixture-1');
    expect(calls.some((url) => url.includes('/tiles/'))).toBe(false);
    expect(calls.filter((url) => url.includes(`/evidence/${fixture.evidenceBucket}.json.gz`))).toHaveLength(1);
  });

  it('accepts browser auto-decoded gzip responses and verifies the decoded checksum', async () => {
    const decoded = new TextEncoder().encode(JSON.stringify(overview()));
    const descriptor = fixture.manifest.artifacts['overview.json.gz'];
    fixture.manifest.artifacts['overview.json.gz'] = {
      ...descriptor,
      uncompressedBytes: decoded.byteLength,
      uncompressedSha256: await digest(decoded),
    } as StaticManifest['artifacts'][string];
    fixture.bytes.set('manifest.json', new TextEncoder().encode(JSON.stringify(fixture.manifest)));
    fixture.bytes.set('overview.json.gz', decoded);
    const runtime = new StaticDataRuntime();
    const response = await runtime.loadManifest();
    expect(response.datasetVersion).toBe('fixture-v1');
    expect(calls.some((url) => url.includes('/overview.json.gz'))).toBe(true);
  });
});
