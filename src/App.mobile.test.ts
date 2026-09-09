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

describe('persistent collision site toggle', () => {
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

  const toggle = async () => screen.findByRole('checkbox', { name: 'Persistent collision sites' });
  const latestMap = () => mapProps.mock.calls.at(-1)?.[0] as { analysisGroups: AnalysisGroup[]; onBoundsChange: (bbox: typeof extent, zoom: number) => void; onAnalysisGroupClick: (group: AnalysisGroup) => void };
  const waitForInitialMap = () => waitFor(() => expect(appLoadView).toHaveBeenCalledTimes(1));

  it('keeps persistent collision sites off by default and exposes an accessible toggle', async () => {
    render(createElement(App));

    const mapRegion = await screen.findByRole('region', { name: /england and wales collision map/i });
    const control = await toggle();
    await waitForInitialMap();
    expect((control as HTMLInputElement).checked).toBe(false);
    expect((control as HTMLInputElement).disabled).toBe(false);
    expect(vi.mocked(appLoadAnalysis)).not.toHaveBeenCalled();
    expect(within(mapRegion).getByText('Persistent collision site')).toBeTruthy();
    expect(within(mapRegion).getByText('School · S2 = 2 schools')).toBeTruthy();
    expect(within(mapRegion).getByText('Persistent collision sites are off.')).toBeTruthy();
  });

  it('explains the dense aggregate fallback at high zoom', async () => {
    vi.mocked(appLoadView).mockResolvedValue(response({ ...view, mode: 'aggregates' }));
    render(createElement(App));

    await waitForInitialMap();
    expect(screen.getByText('Aggregated cells · click a cell to narrow')).toBeTruthy();
    act(() => latestMap().onBoundsChange(extent, 11));
    await waitFor(() => expect(screen.getByText('Dense view grouped · zoom in for individual collisions')).toBeTruthy());
  });

  it('starts analysis automatically after the toggle is turned on', async () => {
    render(createElement(App));

    const control = await toggle();
    await waitForInitialMap();
    fireEvent.click(control);

    await waitFor(() => expect(appLoadAnalysis).toHaveBeenCalledTimes(1));
    expect(vi.mocked(appLoadAnalysis).mock.calls[0]?.[0]).toMatchObject({ bbox: extent, radiusMetres: 100, harmFilter: 'all', filters });
    await waitFor(() => expect(latestMap().analysisGroups).toEqual([group]));
    expect(screen.getByTestId('mock-map').textContent).toContain('analysis groups: 1');
    expect(screen.getByText(/1 persistent collision site shown/i)).toBeTruthy();
  });

  it('recomputes automatically for settled bbox and filter changes', async () => {
    render(createElement(App));

    const control = await toggle();
    await waitForInitialMap();
    fireEvent.click(control);
    await waitFor(() => expect(appLoadAnalysis).toHaveBeenCalledTimes(1));

    vi.mocked(appLoadAnalysis).mockClear();
    const nextBBox = { west: -1, south: 50, east: -.5, north: 51 };
    act(() => latestMap().onBoundsChange(nextBBox, 5));
    await waitFor(() => expect(appLoadAnalysis).toHaveBeenCalledTimes(1));
    expect(vi.mocked(appLoadAnalysis).mock.calls[0]?.[0]).toMatchObject({ bbox: nextBBox });

    vi.mocked(appLoadAnalysis).mockClear();
    fireEvent.change(screen.getByLabelText(/anchor radius/i), { target: { value: '200' } });
    await waitFor(() => expect(appLoadAnalysis).toHaveBeenCalledTimes(1));
    expect(vi.mocked(appLoadAnalysis).mock.calls[0]?.[0]).toMatchObject({ bbox: nextBBox, radiusMetres: 200 });

    vi.mocked(appLoadAnalysis).mockClear();
    fireEvent.click(screen.getByLabelText('2021'));
    await waitFor(() => expect(appLoadAnalysis).toHaveBeenCalledTimes(1));
    expect(vi.mocked(appLoadAnalysis).mock.calls[0]?.[0]).toMatchObject({ bbox: nextBBox, radiusMetres: 200, filters: { ...filters, years: [2021] } });
  });

  it('clears sites on disable and ignores a late aborted result', async () => {
    let resolveAnalysis!: (value: Awaited<ReturnType<typeof appLoadAnalysis>>) => void;
    vi.mocked(appLoadAnalysis).mockImplementation((_options, signal) => new Promise((resolve) => { resolveAnalysis = resolve; expect(signal?.aborted).toBe(false); }));
    render(createElement(App));

    const control = await toggle();
    await waitForInitialMap();
    fireEvent.click(control);
    await waitFor(() => expect(appLoadAnalysis).toHaveBeenCalledTimes(1));
    expect((control as HTMLInputElement).disabled).toBe(false);

    fireEvent.click(control);
    expect((control as HTMLInputElement).checked).toBe(false);
    expect(latestMap().analysisGroups).toEqual([]);
    expect((vi.mocked(appLoadAnalysis).mock.calls[0]?.[1] as AbortSignal | undefined)?.aborted).toBe(true);

    await act(async () => {
      resolveAnalysis(response(analysis));
    });
    await waitFor(() => expect(latestMap().analysisGroups).toEqual([]));
    expect(screen.getByText('Persistent collision sites are off.')).toBeTruthy();
  });

  it('clears the selected site inspection when disabled', async () => {
    render(createElement(App));

    const control = await toggle();
    await waitForInitialMap();
    fireEvent.click(control);
    await waitFor(() => expect(latestMap().analysisGroups).toEqual([group]));
    act(() => latestMap().onAnalysisGroupClick(group));
    await waitFor(() => expect(screen.getByText('Group inspection')).toBeTruthy());

    fireEvent.click(control);
    expect(screen.queryByText('Group inspection')).toBeNull();
    expect(latestMap().analysisGroups).toEqual([]);
  });

  it('keeps the selected site inspection through an automatic refresh when the site remains', async () => {
    render(createElement(App));

    const control = await toggle();
    await waitForInitialMap();
    fireEvent.click(control);
    await waitFor(() => expect(latestMap().analysisGroups).toEqual([group]));
    act(() => latestMap().onAnalysisGroupClick(group));
    await waitFor(() => expect(screen.getByText('Group inspection')).toBeTruthy());

    vi.mocked(appLoadAnalysis).mockClear();
    const nextBBox = { west: -1, south: 50, east: -.5, north: 51 };
    act(() => latestMap().onBoundsChange(nextBBox, 5));
    await waitFor(() => expect(appLoadAnalysis).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('Group inspection')).toBeTruthy());
    expect(screen.getByText('Selected persistent collision site')).toBeTruthy();
  });

  it('pauses above 10,000 records and resumes automatically after narrowing', async () => {
    let oversize = true;
    const largeMetrics = { ...metrics, collisions: 10_001 };
    vi.mocked(appLoadSummary).mockImplementation(async (options) => response({ ...summary({ filters: options.filters, ...(options.bbox ? { bbox: options.bbox } : {}) }), metrics: options.bbox && oversize ? largeMetrics : metrics }));
    render(createElement(App));

    const control = await toggle();
    await waitForInitialMap();
    fireEvent.click(control);
    await waitFor(() => expect(screen.getByText('Persistent collision sites are paused above 10,000 matching records; narrow the map or filters to resume automatically.')).toBeTruthy());
    expect((control as HTMLInputElement).checked).toBe(true);
    expect(appLoadAnalysis).not.toHaveBeenCalled();

    oversize = false;
    const nextBBox = { west: -1, south: 50, east: -.5, north: 51 };
    act(() => latestMap().onBoundsChange(nextBBox, 5));
    await waitFor(() => expect(appLoadAnalysis).toHaveBeenCalledTimes(1));
    expect(vi.mocked(appLoadAnalysis).mock.calls[0]?.[0]).toMatchObject({ bbox: nextBBox });
  });

  it('remains switchable off while analysis is loading or returns an error', async () => {
    let resolveAnalysis!: (value: Awaited<ReturnType<typeof appLoadAnalysis>>) => void;
    vi.mocked(appLoadAnalysis).mockImplementation(() => new Promise((resolve) => { resolveAnalysis = resolve; }));
    render(createElement(App));

    const control = await toggle();
    await waitForInitialMap();
    fireEvent.click(control);
    await waitFor(() => expect(appLoadAnalysis).toHaveBeenCalledTimes(1));
    expect((control as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(control);
    expect((control as HTMLInputElement).checked).toBe(false);
    expect((vi.mocked(appLoadAnalysis).mock.calls[0]?.[1] as AbortSignal | undefined)?.aborted).toBe(true);
    await act(async () => {
      resolveAnalysis(response(analysis));
    });
    await waitFor(() => expect(latestMap().analysisGroups).toEqual([]));

    vi.mocked(appLoadAnalysis).mockRejectedValueOnce(new Error('analysis unavailable'));
    fireEvent.click(control);
    await waitFor(() => expect(appLoadAnalysis).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(/Persistent collision site analysis failed: analysis unavailable/i)).toBeTruthy());
    expect((control as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(control);
    expect((control as HTMLInputElement).checked).toBe(false);
  });

  it('shows map request errors and keeps the toggle available for retry', async () => {
    const requestError = new Error('Published map shard unavailable');
    vi.mocked(appLoadView).mockRejectedValueOnce(requestError).mockResolvedValue(response(view));
    render(createElement(App));

    await waitFor(() => expect(document.querySelector('.map-stale-banner')?.textContent).toContain('Published map shard unavailable'));
    expect(screen.getByRole('button', { name: 'Retry map request' })).toBeTruthy();
    const control = await toggle();
    expect((control as HTMLInputElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Retry map request' }));
    await waitFor(() => expect(appLoadView).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(document.getElementById('map-analysis-status')?.textContent).toContain('Persistent collision sites are off.'));
  });
});
