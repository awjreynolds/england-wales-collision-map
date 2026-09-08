import { describe, expect, it } from 'vitest';
import type { BBox, QueryFilters } from '../../service/contract';
import {
  buildAnalysis,
  buildView,
  matchesBBox,
  matchesRecord,
  metricForRecord,
  summarizeRecords,
  type FilteredViewInput,
} from './engine';
import { STATIC_SCHEMA_VERSION, staticCellBounds, staticCellKey, type StaticCellFacet, type StaticCollisionRecord, type StaticOverview, type StaticSchoolRecord } from './contract';

const filters: QueryFilters = { years: [], authorities: [], severities: [], pedestrian: 'all', cycle: 'all', motorcycle: 'all' };
const extent: BBox = { west: -3, south: 50, east: -2, north: 52 };

const record = (id: string, overrides: Partial<StaticCollisionRecord> = {}): StaticCollisionRecord => ({
  id,
  datasetVersion: 'fixture-v1',
  year: 2021,
  date: '2021-01-01',
  time: '12:00',
  latitude: 51,
  longitude: -2.5,
  country: 'England',
  authorityCode: 'E00000001',
  authorityName: 'Fixture authority',
  roadName: null,
  roadNumber: null,
  speedLimit: null,
  junctionDetail: null,
  severity: 'slight',
  casualtyCount: 1,
  fatalities: 0,
  seriousCasualties: 0,
  slightCasualties: 1,
  ksiCasualties: 0,
  pedestrianInvolved: false,
  cycleInvolved: false,
  motorcycleInvolved: false,
  ...overrides,
});

const facetKey = (value: StaticCollisionRecord): string => [
  value.year ?? 0,
  value.country,
  value.authorityCode,
  value.severity,
  value.pedestrianInvolved === null ? 'u' : value.pedestrianInvolved ? 'y' : 'n',
  value.cycleInvolved === null ? 'u' : value.cycleInvolved ? 'y' : 'n',
  value.motorcycleInvolved === null ? 'u' : value.motorcycleInvolved ? 'y' : 'n',
].join('|');

const overviewFor = (records: StaticCollisionRecord[]): StaticOverview => {
  const cells = new Map<string, { recordCount: number; facets: Map<string, StaticCellFacet> }>();
  records.forEach((value) => {
    const key = staticCellKey(value.longitude, value.latitude);
    const cell = cells.get(key) ?? { recordCount: 0, facets: new Map<string, StaticCellFacet>() };
    const keyForFacet = facetKey(value);
    const facet = cell.facets.get(keyForFacet);
    if (facet) {
      const next = metricForRecord(value);
      for (const field of Object.keys(next) as Array<keyof typeof next>) facet.additiveSummaryMetrics[field] += next[field];
    } else {
      cell.facets.set(keyForFacet, { additiveSummaryMetrics: metricForRecord(value) });
    }
    cell.recordCount += 1;
    cells.set(key, cell);
  });
  return {
    schemaVersion: STATIC_SCHEMA_VERSION,
    cellSizeDegrees: .25,
    cells: Object.fromEntries([...cells].map(([cellKey, value]) => [cellKey, { cellKey, bounds: staticCellBounds(cellKey), recordCount: value.recordCount, facets: Object.fromEntries(value.facets) }])),
  };
};

const viewInput = (records: StaticCollisionRecord[], overrides: Partial<FilteredViewInput> = {}): FilteredViewInput => ({
  overview: overviewFor(records),
  records,
  filters,
  bbox: extent,
  zoom: 8,
  ...overrides,
});

const school = (id: string, latitude: number, longitude: number): StaticSchoolRecord => ({ id, name: id, country: 'England', lat: latitude, lon: longitude, status: 'open', phase: 'secondary', source: 'fixture' });

describe('static engine parity', () => {
  it('keeps empty nullable metrics at zero and all-null selections missing', () => {
    const empty = summarizeRecords([], filters);
    expect(empty.collisions).toBe(0);
    expect(empty.casualties.total).toEqual({ value: 0, unknownRecords: 0 });

    const unknown = summarizeRecords([record('unknown', { casualtyCount: null, fatalities: null, seriousCasualties: null, slightCasualties: null, ksiCasualties: null })], filters);
    expect(unknown.casualties.total).toEqual({ value: null, unknownRecords: 1 });
    expect(unknown.casualties.ksi).toEqual({ value: null, unknownRecords: 1 });
  });

  it('matches all filters and handles antimeridian and world bounding boxes', () => {
    const crossing = record('crossing', { longitude: 179.5 });
    expect(matchesBBox(crossing, { west: 179, south: 50, east: -179, north: 52 })).toBe(true);
    expect(matchesBBox({ ...crossing, longitude: -179.5 }, { west: 179, south: 50, east: -179, north: 52 })).toBe(true);
    expect(matchesBBox({ ...crossing, longitude: 0 }, { west: 179, south: 50, east: -179, north: 52 })).toBe(false);
    expect(matchesBBox(crossing, { west: 179, south: 50, east: -179, north: 52, world: true })).toBe(true);
    expect(matchesBBox({ ...crossing, longitude: 0 }, { west: 179, south: 50, east: -179, north: 52, world: true })).toBe(true);
    expect(matchesRecord(record('filtered', { year: 2022, country: 'Wales', authorityCode: 'W00000001', severity: 'fatal', pedestrianInvolved: null }), { years: [2022], authorities: ['W00000001'], country: 'Wales', severities: ['fatal'], pedestrian: 'unknown', cycle: 'all', motorcycle: 'all' })).toBe(true);
  });

  it('filters point records before rendering the bounded point result', () => {
    const matching = record('matching', { severity: 'fatal' });
    const excluded = record('excluded', { severity: 'slight' });
    const view = buildView(viewInput([matching], { pointRecords: [matching, excluded], filters: { ...filters, severities: ['fatal'] } }));
    expect(view.mode).toBe('points');
    expect(view.featureCount).toBe(1);
    expect(view.features.features[0]?.id).toBe('matching');
  });

  it('keeps partial aggregate centers inside the visible box when the edge cell is dense', () => {
    const dense = Array.from({ length: 2_001 }, (_, index) => record(`dense-${index}`, { longitude: -2.99 + (index % 10) * .0001, latitude: 50.01 + (index % 10) * .0001 }));
    const narrowBox = { west: -2.99, south: 50.01, east: -2.98, north: 50.02 };
    const view = buildView(viewInput(dense, { bbox: narrowBox, refineRecords: undefined }));
    expect(view.mode).toBe('aggregates');
    expect(view.features.features.length).toBeGreaterThan(0);
    view.features.features.forEach((feature) => {
      expect(feature.geometry.coordinates[0]).toBeGreaterThanOrEqual(narrowBox.west);
      expect(feature.geometry.coordinates[0]).toBeLessThanOrEqual(narrowBox.east);
      expect(feature.geometry.coordinates[1]).toBeGreaterThanOrEqual(narrowBox.south);
      expect(feature.geometry.coordinates[1]).toBeLessThanOrEqual(narrowBox.north);
    });
  });

  it('keeps drilling below one hundredth of a degree for distinct dense points', () => {
    const narrowBox = { west: -2.500001, south: 50.999999, east: -2.499999, north: 51.000001 };
    const dense = Array.from({ length: 2_001 }, (_, index) => {
      const longitudeFraction = (index + 1) / 2_002;
      const latitudeFraction = ((index * 37) % 2_001 + 1) / 2_002;
      return record(`tiny-${index}`, {
        longitude: narrowBox.west + (narrowBox.east - narrowBox.west) * longitudeFraction,
        latitude: narrowBox.south + (narrowBox.north - narrowBox.south) * latitudeFraction,
      });
    });
    const view = buildView(viewInput(dense, { bbox: narrowBox, refineRecords: undefined }));
    expect(view.mode).toBe('aggregates');
    expect(view.aggregateCellDegrees).toBeLessThan(0.01);
    expect(view.featureCount).toBeGreaterThan(1);
  });

  it('coarsens contained and boundary aggregates together under the feature cap', () => {
    const records = Array.from({ length: 2_001 }, (_, index) => record(`cells-${index}`, {
      longitude: -179.9 + (index % 100) * 3.5,
      latitude: -89.9 + Math.floor(index / 100) * 4,
    }));
    const view = buildView(viewInput(records, {
      bbox: { west: -180, south: -90, east: 180, north: 90, world: true },
      refineRecords: undefined,
    }));
    expect(view.mode).toBe('aggregates');
    expect(view.featureCount).toBeLessThanOrEqual(2_000);
    expect(view.features.features.reduce((sum, feature) => feature.properties.kind === 'aggregate' ? sum + feature.properties.count : sum, 0)).toBe(2_001);
  });

  it('uses harm coverage before school filtering and reports selected school distance', () => {
    const groups = [
      record('a', { latitude: 51, longitude: -2.5, year: 2021, ksiCasualties: 1 }),
      record('b', { latitude: 51.0001, longitude: -2.5001, year: 2022, ksiCasualties: 0 }),
      record('c', { latitude: 51.0002, longitude: -2.5002, year: 2023, ksiCasualties: 0 }),
      record('d', { latitude: 51.2, longitude: -2.5, year: 2021, ksiCasualties: 0 }),
      record('e', { latitude: 51.2001, longitude: -2.5001, year: 2022, ksiCasualties: 0 }),
      record('f', { latitude: 51.2002, longitude: -2.5002, year: 2023, ksiCasualties: 0 }),
    ];
    const result = buildAnalysis({ records: groups, schools: [school('near', 51, -2.5), school('far', 51.3, -2.5)], filters, bbox: extent, radiusMetres: 100, harmFilter: 'ksi', schoolDistanceMetres: 500 });
    expect(result.groups).toHaveLength(1);
    expect(result.schoolCoverage).toEqual([
      { distanceMetres: 500, matchingLocations: 1, totalLocations: 1, percentage: 100 },
      { distanceMetres: 1000, matchingLocations: 1, totalLocations: 1, percentage: 100 },
    ]);

    const selected = buildAnalysis({ records: groups.slice(0, 3), schools: [school('near', 51, -2.5)], filters, bbox: extent, radiusMetres: 100, harmFilter: 'all', selectedSchoolId: 'near', schoolDistanceMetres: 1000 });
    expect(selected.groups[0]?.schoolProximity.selectedDistanceMetres).toBe(1000);
    expect(selected.groups[0]?.schoolProximity.selectedSchoolMatch).toBe(true);
  });

  it('applies slight-only unknown rules, leaves distant nearest schools null, warns on edge groups, and caps analysis input', () => {
    const slight = [
      record('slight-a', { slightCasualties: 1, ksiCasualties: 0 }),
      record('slight-b', { latitude: 51.0001, longitude: -2.5001, year: 2022, slightCasualties: 1, ksiCasualties: 0 }),
      record('slight-c', { latitude: 51.0002, longitude: -2.5002, year: 2023, slightCasualties: 1, ksiCasualties: 0 }),
    ];
    const edgeBox = { west: -3, south: 51, east: -2, north: 52 };
    const slightResult = buildAnalysis({ records: slight, schools: [school('distant', 51.3, -2.5)], filters, bbox: edgeBox, radiusMetres: 100, harmFilter: 'slight-only' });
    expect(slightResult.groups).toHaveLength(1);
    expect(slightResult.groups[0]?.schoolProximity.nearestSchool).toBeNull();
    expect(slightResult.edgeWarning).toBe(true);

    const unknown = slight.map((value, index) => ({ ...value, id: `unknown-${index}`, slightCasualties: index === 0 ? null : 1 }));
    expect(buildAnalysis({ records: unknown, schools: [], filters, bbox: edgeBox, radiusMetres: 100, harmFilter: 'slight-only' }).groups).toHaveLength(0);

    const tooMany = Array.from({ length: 10_001 }, (_, index) => record(`many-${index}`, { latitude: 51 + index * 1e-7, longitude: -2.5 }));
    expect(() => buildAnalysis({ records: tooMany, schools: [], filters, bbox: extent, radiusMetres: 100, harmFilter: 'all' })).toThrow(/10,000/);
  });
});
