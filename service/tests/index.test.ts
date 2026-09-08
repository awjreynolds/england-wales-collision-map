import { describe, expect, it } from 'vitest';
import worker, { handle } from '../src/index';
import { summaryLookupKey } from '../src/db';
import { createSqliteD1, insertCollision, insertSchool } from './helpers';
import type { DatasetManifest } from '../contract';

const manifest: DatasetManifest = {
  datasetVersion: 'test-v1',
  schemaVersion: 'national.v1',
  title: 'Test national dataset',
  scope: 'England and Wales',
  years: [2021, 2022],
  extent: { west: -2.9, south: 50.1, east: -2.1, north: 51.9 },
  collisionCount: 3,
  source: { publisher: 'Test', dataset: 'Test', urls: [] },
  generatedAt: '2026-01-01T00:00:00Z',
  qualityNotices: [],
  limits: { viewFeatureLimit: 2_000, viewResponseBytes: 1_000_000, analysisRecordLimit: 10_000, analysisRequiresBbox: true },
};

const metricJson = JSON.stringify({
  collisions: 3,
  collisionSeverity: { fatal: 0, serious: 1, slight: 2, unknown: 0 },
  casualties: {
    total: { value: 3, unknownRecords: 0 },
    fatalities: { value: 0, unknownRecords: 0 },
    serious: { value: 1, unknownRecords: 0 },
    slight: { value: 2, unknownRecords: 0 },
    ksi: { value: 0, unknownRecords: 0 },
  },
  ksiCollisions: 0,
  yearsRepresented: [2021, 2022],
  complete: true,
  sourceRows: 3,
  mappableRows: 3,
});

const setup = () => {
  const { database, d1 } = createSqliteD1();
  database.prepare('INSERT INTO dataset_metadata (key, value) VALUES (?, ?)').run('manifest', JSON.stringify(manifest));
  database.prepare('INSERT INTO precomputed_summaries (key, dataset_version, filters_json, metrics_json) VALUES (?, ?, ?, ?)').run(summaryLookupKey({ years: [], authorities: [], severities: [], pedestrian: 'all', cycle: 'all', motorcycle: 'all' }), 'test-v1', '{}', metricJson);
  database.prepare('INSERT INTO map_cells (cell_level, latitude_cell, longitude_cell, dataset_version, count, fatal_count, serious_count, slight_count, unknown_count, casualty_total, casualty_unknown, ksi_collision_count, years_json) VALUES (1, 141, 177, ?, 3, 0, 1, 2, 0, 3, 0, 0, ?)').run('test-v1', '[2021,2022]');
  insertCollision(database, { id: 'a', latitude: 51.5, longitude: -2.6, year: 2021, severity: 'serious' });
  insertCollision(database, { id: 'b', latitude: 51.5001, longitude: -2.6001, year: 2022, severity: 'slight' });
  insertCollision(database, { id: 'c', latitude: 51.5002, longitude: -2.6002, year: 2022, severity: 'slight' });
  return { database, env: { DB: d1, API_VERSION: 'national.v1' } as never };
};

describe('national Worker routes', () => {
  it('uses precomputed overview cells when the requested bbox contains the dataset extent', async () => {
    const { env } = setup();
    const response = await handle(new Request('https://example.test/view?bbox=-3,50,-2,52&zoom=8'), env);
    const body = await response.json() as { data: { mode: string; recordCount: number; featureCount: number } };
    expect(response.status).toBe(200);
    expect(body.data.mode).toBe('aggregates');
    expect(body.data.recordCount).toBe(3);
    expect(body.data.featureCount).toBe(1);
  });

  it('returns individual points only at a high zoom level', async () => {
    const { env } = setup();
    const response = await handle(new Request('https://example.test/view?bbox=-3,50,-2,52&zoom=13'), env);
    const body = await response.json() as { data: { mode: string; featureCount: number } };
    expect(body.data.mode).toBe('points');
    expect(body.data.featureCount).toBe(3);
  });

  it('requires a bbox for analysis and keeps the error envelope versioned', async () => {
    const { env } = setup();
    const response = await worker.fetch(new Request('https://example.test/analysis'), env);
    const body = await response.json() as { version: string; error: { code: string } };
    expect(response.status).toBe(400);
    expect(body.version).toBe('national.v1');
    expect(body.error.code).toBe('bbox_required');
  });

  it('applies the selected country to school name searches', async () => {
    const { database, env } = setup();
    insertSchool(database, { id: 'england-school', name: 'Shared School', country: 'England', latitude: 51.5, longitude: -2.6 });
    insertSchool(database, { id: 'wales-school', name: 'Shared School', country: 'Wales', latitude: 51.6, longitude: -2.5 });
    const response = await handle(new Request('https://example.test/schools?q=Shared&country=Wales'), env);
    const body = await response.json() as { data: { schools: Array<{ id: string; country: string }> } };
    expect(response.status).toBe(200);
    expect(body.data.schools.map((school) => school.id)).toEqual(['wales-school']);
    expect(body.data.schools[0]?.country).toBe('Wales');
  });
});
