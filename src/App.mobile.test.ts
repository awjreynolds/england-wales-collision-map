// @vitest-environment jsdom

import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisGroup, AnalysisPayload, DatasetManifest, QueryFilters, SchoolsPayload, SummaryMetrics, SummaryPayload, ViewPayload } from '../service/contract';

const { mapProps, loadAnalysis, loadCollisionDetail, loadManifest, loadSchools, loadSummary, loadView } = vi.hoisted(() => ({
  mapProps: vi.fn(),
  loadAnalysis: vi.fn(),
  loadCollisionDetail: vi.fn(),
  loadManifest: vi.fn(),
  loadSchools: vi.fn(),
  loadSummary: vi.fn(),
  loadView: vi.fn(),
}));

vi.mock('./components/MapView', () => ({
  MapView: (props: { analysisGroups: AnalysisGroup[]; onBoundsChange: (bbox: typeof extent, zoom: number) => void }) => {
    mapProps(props);
    return createElement('div', { 'data-testid': 'mock-map' }, `analysis groups: ${props.analysisGroups.length}`);
  },
}));

vi.mock('./app/data', async () => {
  const actual = await vi.importActual('./app/data');
  return { ...actual, loadAnalysis, loadCollisionDetail, loadManifest, loadSchools, loadSummary, loadView };
});

import { App } from './App';
import { loadAnalysis as appLoadAnalysis, loadCollisionDetail as appLoadCollisionDetail, loadManifest as appLoadManifest, loadSchools as appLoadSchools, loadSummary as appLoadSummary, loadView as appLoadView } from './app/data';

const datasetVersion = 'fixture-v1';
const extent = { west: -6, south: 49, east: 2, north: 56 };
const filters: QueryFilters = { years: [], authorities: [], severities: [], pedestrian: 'all', cycle: 'all', motorcycle: 'all' };
const manifest: DatasetManifest = {
  datasetVersion,
  schemaVersion: 'national.v1',
  title: 'England & Wales Collision Map',
  scope: 'England and Wales',
  years: [2021, 2022],
  extent,
  authorities: [],
  collisionCount: 3,
  source: { publisher: 'Fixture', dataset: 'Fixture data', urls: [] },
  generatedAt: '2026-01-01T00:00:00Z',
  qualityNotices: [],
  limits: { viewFeatureLimit: 2_000, viewResponseBytes: 1_000_000, analysisRecordLimit: 10_000, analysisRequiresBbox: true },
};
const metrics: SummaryMetrics = {
  collisions: 3,
  collisionSeverity: { fatal: 0, serious: 1, slight: 2, unknown: 0 },
  casualties: {
    total: { value: 3, unknownRecords: 0 },
    fatalities: { value: 0, unknownRecords: 0 },
    serious: { value: 1, unknownRecords: 0 },
    slight: { value: 2, unknownRecords: 0 },
    ksi: { value: 1, unknownRecords: 0 },
  },
  ksiCollisions: 1,
  yearsRepresented: [2021, 2022],
  complete: true,
};
const view: ViewPayload = {
  mode: 'points',
  features: { type: 'FeatureCollection', features: [] },
  recordCount: 3,
  featureCount: 0,
  complete: true,
  bounds: extent,
  filters,
  zoom: 5,
};
const group: AnalysisGroup = {
  id: 'group-1',
  anchor: { collisionId: 'collision-1', latitude: 51.45, longitude: -2.59 },
  collisions: 3,
  yearsRepresented: [2021, 2022],
  harm: {
    collisionSeverity: { fatal: 0, serious: 1, slight: 2, unknown: 0 },
    casualties: {
      total: { value: 3, unknownRecords: 0 },
      fatalities: { value: 0, unknownRecords: 0 },
      serious: { value: 1, unknownRecords: 0 },
      slight: { value: 2, unknownRecords: 0 },
      ksi: { value: 1, unknownRecords: 0 },
    },
    ksiCollisions: 1,
    ksiCollisionYears: [2021],
  },
  memberIds: ['collision-1', 'collision-2', 'collision-3'],
  schoolProximity: { within500m: true, within1km: true, nearestSchool: null },
};
const analysis: AnalysisPayload = {
  scope: { bbox: extent, filters, radiusMetres: 100, harmFilter: 'all' },
  groups: [group],
  schoolCoverage: [{ distanceMetres: 500, matchingLocations: 1, totalLocations: 1, percentage: 100 }],
  inputRecords: 3,
  complete: true,
  edgeWarning: false,
  limits: { recordLimit: 10_000, returnedRecords: 3 },
};
const response = <T,>(data: T) => ({ version: 'national.v1' as const, datasetVersion, requestKey: 'fixture', data });
const summary = (scope: SummaryPayload['scope']): SummaryPayload => ({ scope, metrics, exact: true, precomputed: false });

describe('mobile hotspot entry point', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    vi.clearAllMocks();
    vi.mocked(appLoadManifest).mockResolvedValue(response(manifest));
    vi.mocked(appLoadView).mockResolvedValue(response(view));
    vi.mocked(appLoadSummary).mockImplementation(async (options) => response(summary({ filters: options.filters, ...(options.bbox ? { bbox: options.bbox } : {}) })));
    vi.mocked(appLoadSchools).mockResolvedValue(response<SchoolsPayload>({ schools: [], exact: true }));
    vi.mocked(appLoadAnalysis).mockResolvedValue(response(analysis));
    vi.mocked(appLoadCollisionDetail).mockRejectedValue(new Error('not used in this test'));
  });

  afterEach(() => {
    cleanup();
  });

  it('exposes a directly reachable Show hotspots action in the map region', async () => {
    render(createElement(App));

    const mapRegion = await screen.findByRole('region', { name: /england and wales collision map/i });
    await waitFor(() => expect((within(mapRegion).getByRole('button', { name: /show hotspots/i }) as HTMLButtonElement).disabled).toBe(false));
    expect(within(mapRegion).getByText('Hotspot location')).toBeTruthy();
  });

  it('sends the visible bounded extent to analysis and renders returned groups on the map', async () => {
    render(createElement(App));

    const showHotspotsButton = await screen.findByRole('button', { name: 'Show hotspots' });
    await waitFor(() => expect((showHotspotsButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(showHotspotsButton);

    await waitFor(() => expect(appLoadAnalysis).toHaveBeenCalledTimes(1));
    expect(vi.mocked(appLoadAnalysis).mock.calls[0]?.[0]).toMatchObject({ bbox: extent, radiusMetres: 100, harmFilter: 'all', filters });
    await waitFor(() => expect(mapProps.mock.calls.at(-1)?.[0].analysisGroups).toEqual([group]));
    expect(screen.getByTestId('mock-map').textContent).toContain('analysis groups: 1');
  });

  it('keeps the saved analysis status while the live map extent changes', async () => {
    let resolveAnalysis!: (value: Awaited<ReturnType<typeof appLoadAnalysis>>) => void;
    vi.mocked(appLoadAnalysis).mockImplementation(() => new Promise((resolve) => { resolveAnalysis = resolve; }));
    render(createElement(App));

    const showHotspotsButton = await screen.findByRole('button', { name: 'Show hotspots' });
    await waitFor(() => expect((showHotspotsButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(showHotspotsButton);
    await waitFor(() => expect(screen.getByText(/Finding hotspot locations in the 49\.00° to 56\.00° N/i)).toBeTruthy());

    const nextBBox = { west: -1, south: 50, east: -.5, north: 51 };
    const latestMapProps = mapProps.mock.calls.at(-1)?.[0] as { onBoundsChange: (bbox: typeof extent, zoom: number) => void };
    act(() => latestMapProps.onBoundsChange(nextBBox, 5));
    await waitFor(() => expect(screen.getByText(/Finding hotspot locations in the 49\.00° to 56\.00° N/i)).toBeTruthy());
    const status = document.getElementById('map-analysis-status');
    expect(status?.textContent).toContain('49.00° to 56.00° N');
    expect(status?.textContent).not.toContain('50.00° to 51.00° N');

    resolveAnalysis(response(analysis));
    await waitFor(() => expect(screen.getByText(/1 hotspot location shown\. Saved area: 49\.00° to 56\.00° N\./i)).toBeTruthy());
  });

  it('keeps the map action disabled and explains the analysis limit for a large extent', async () => {
    const largeMetrics = { ...metrics, collisions: 10_001 };
    vi.mocked(appLoadSummary).mockImplementation(async (options) => response({ ...summary({ filters: options.filters, ...(options.bbox ? { bbox: options.bbox } : {}) }), metrics: options.bbox ? largeMetrics : metrics }));
    render(createElement(App));

    const showHotspotsButton = await screen.findByRole('button', { name: 'Show hotspots' });
    await waitFor(() => expect((showHotspotsButton as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText(/below 10,000 matching records/i)).toBeTruthy();
    expect(appLoadAnalysis).not.toHaveBeenCalled();
  });
});
