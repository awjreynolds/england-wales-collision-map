// @vitest-environment jsdom
import { createElement, type ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ map: null as unknown }));
type Listener = (event: unknown) => void;
vi.mock('maplibre-gl', () => {
  class Map {
    listeners = new globalThis.Map<string, Listener[]>();
    features: GeoJSON.Feature[] = [];
    canvas = document.createElement('canvas');
    source = { setData: (data: GeoJSON.FeatureCollection) => { this.features = data.features; return Promise.resolve(); } };
    touchZoomRotate = { disableRotation() {} };
    constructor() { mock.map = this; }
    on(name: string, layerOrListener: string | Listener, listener?: Listener) { const key = typeof layerOrListener === 'string' ? `${name}:${layerOrListener}` : name; this.listeners.set(key, [...(this.listeners.get(key) ?? []), listener ?? layerOrListener as Listener]); return this; }
    off(name: string, listener: Listener) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter((item) => item !== listener)); return this; }
    once() { return this; }
    fire(name: string, event = {}) { for (const listener of [...(this.listeners.get(name) ?? [])]) listener(event); }
    queryRenderedFeatures() { return this.features; }
    project([lng, lat]: number[]) { return { x: lng * 100, y: lat * 100 }; }
    unproject([x, y]: number[]) { return { lng: x / 100, lat: y / 100 }; }
    getZoom() { return 11; }
    getBounds() { return { getWest: () => -3, getSouth: () => 51, getEast: () => -2, getNorth: () => 52 }; }
    getSource() { return this.source; }
    getLayer() { return {}; }
    getCanvas() { return this.canvas; }
    isMoving() { return false; }
    isSourceLoaded() { return true; }
    fitBounds = vi.fn();
    addControl() {} addSource() {} addLayer() {} setPaintProperty() {} resize() {} remove() {}
  }
  class Popup {
    root = document.createElement('div');
    listeners = new Set<() => void>();
    map?: Map;
    constructor(private options: { closeOnClick?: boolean } = {}) { this.root.className = 'maplibregl-popup'; }
    setLngLat() { return this; }
    setDOMContent(root: HTMLElement) { this.root.replaceChildren(root); return this; }
    getElement() { return this.root; }
    on(_name: string, listener: () => void) { this.listeners.add(listener); return this; }
    off(_name: string, listener: () => void) { this.listeners.delete(listener); return this; }
    close = () => this.remove();
    addTo(map: Map) { this.map = map; document.body.append(this.root); if (this.options.closeOnClick !== false) map.on('click', this.close); return this; }
    remove() { if (!this.map) return this; this.root.remove(); this.map.off('click', this.close); this.map = undefined; for (const listener of [...this.listeners]) listener(); return this; }
  }
  return { default: { Map, Popup, NavigationControl: class {}, AttributionControl: class {} } };
});
import { MapView } from './MapView';
type Props = ComponentProps<typeof MapView>;
type TestMap = { fire: (name: string, event?: unknown) => void; features: GeoJSON.Feature[]; canvas: HTMLCanvasElement; fitBounds: ReturnType<typeof vi.fn> };
const extent = { west: -3, south: 51, east: -2, north: 52 };
const school = { id: 'school1', name: 'Example Primary School', country: 'England' as const, longitude: -2.5, latitude: 51.5, phase: 'Primary', status: 'Open' };
const props = (): Props => ({
  manifest: { datasetVersion: 'test', schemaVersion: 'national.v1', title: 'Test', scope: 'England and Wales', years: [2025], extent, authorities: [], collisionCount: 1, source: { publisher: 'Test', dataset: 'Test', urls: [] }, generatedAt: '', qualityNotices: [], limits: { viewFeatureLimit: 2000, viewResponseBytes: 1000000, analysisRecordLimit: 10000, analysisRequiresBbox: true } },
  view: null, initialBBox: extent, initialZoom: 11, schools: [school], analysisGroups: [], resetSignal: 0, focusBBox: null, selectedCollisionId: null, selectedPoint: null, selectedAnalysisGroup: null, detail: null,
  onBoundsChange: vi.fn(), onAggregateClick: vi.fn(), onCollisionClick: vi.fn(), onAnalysisGroupClick: vi.fn(), onPopupClose: vi.fn(), onSchoolClick: vi.fn(),
});
async function mount(overrides: Partial<Props> = {}) {
  const initial = { ...props(), ...overrides };
  const result = render(createElement(MapView, initial));
  const map = mock.map as TestMap;
  await act(async () => { map.fire('load'); await vi.advanceTimersByTimeAsync(20); });
  return { ...result, map, initial };
}
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 1)); vi.stubGlobal('cancelAnimationFrame', clearTimeout); });
afterEach(() => { cleanup(); document.querySelectorAll('.maplibregl-popup').forEach((node) => node.remove()); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('opens a school popup on click without losing the school selection action', async () => {
  const { map, initial } = await mount();
  act(() => map.fire('click', { point: { x: 1, y: 1 } }));
  expect(initial.onSchoolClick).toHaveBeenCalledWith(school);
  expect(screen.getByRole('heading', { name: school.name })).toBeTruthy();
});
it('opens a school popup on mouse over without selecting or moving the map', async () => {
  const { map, initial } = await mount();
  await act(async () => { map.fire('mousemove', { point: { x: 1, y: 1 } }); await vi.advanceTimersByTimeAsync(400); });
  expect(screen.getByRole('heading', { name: school.name })).toBeTruthy();
  expect(initial.onSchoolClick).not.toHaveBeenCalled();
  expect(initial.onAggregateClick).not.toHaveBeenCalled();
  expect(map.fitBounds).not.toHaveBeenCalled();
});
const collisionView = (): NonNullable<Props['view']> => ({
  mode: 'points', complete: true, bounds: extent, zoom: 11, recordCount: 1, featureCount: 1,
  filters: { years: [], authorities: [], severities: [], pedestrian: 'all', cycle: 'all', motorcycle: 'all' },
  features: { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'collision1', geometry: { type: 'Point', coordinates: [-2.5, 51.5] }, properties: { kind: 'collision', id: 'collision1', year: 2025, severity: 'serious', country: 'England', authorityCode: 'test', authorityName: 'Test authority' } }] },
});
it('shows collision information immediately while full detail loads', async () => {
  const { map, initial } = await mount({ schools: [], view: collisionView() });
  act(() => map.fire('click', { point: { x: 1, y: 1 } }));
  expect(initial.onCollisionClick).toHaveBeenCalledWith('collision1', [-2.5, 51.5]);
  expect(document.querySelector('.maplibregl-popup')?.textContent).toContain('Serious');
});
const detail: NonNullable<Props['detail']> = {
    id: 'old', datasetVersion: 'test', year: 2025, date: null, time: null, latitude: 51.5, longitude: -2.5, country: 'England', authorityCode: 'test', authorityName: 'Test authority', roadName: 'Old Road', roadNumber: null, speedLimit: null, junctionDetail: null, severity: 'slight', casualtyCount: 1, fatalities: 0, seriousCasualties: 0, slightCasualties: 1, ksiCasualties: 0, pedestrianInvolved: null, cycleInvolved: null, motorcycleInvolved: null, evidence: { collision: {}, casualties: [], vehicles: [] },
  };
it('does not let an existing popup cancel a new collision click', async () => {
  const { map, initial, rerender } = await mount({ schools: [], view: collisionView() });
  rerender(createElement(MapView, { ...initial, detail, selectedCollisionId: 'old', selectedPoint: [-2.5, 51.5] }));
  expect(screen.getByRole('heading', { name: 'Old Road' })).toBeTruthy();
  act(() => map.fire('click', { point: { x: 1, y: 1 } }));
  expect(initial.onCollisionClick).toHaveBeenCalledWith('collision1', [-2.5, 51.5]);
  expect(initial.onPopupClose).not.toHaveBeenCalled();
  expect(document.querySelector('.maplibregl-popup')?.textContent).toContain('Serious');
});
it('shows a grouped picker without automatically zooming away from it', async () => {
  const first = school;
  const second = { ...school, id: 'school2', name: 'Second School', longitude: -2.49 };
  const { map, initial } = await mount({ schools: [first, second] });
  act(() => map.fire('click', { point: { x: 1, y: 1 } }));
  expect(screen.getByRole('heading', { name: 'Markers grouped for display' })).toBeTruthy();
  expect(initial.onAggregateClick).not.toHaveBeenCalled();
  expect(map.fitBounds).not.toHaveBeenCalled();
});
it('removes an unpinned hover popup when the pointer leaves the markers', async () => {
  const { map } = await mount();
  await act(async () => { map.fire('mousemove', { point: { x: 1, y: 1 } }); await vi.advanceTimersByTimeAsync(400); });
  expect(screen.getByRole('heading', { name: school.name })).toBeTruthy();
  map.features = [];
  await act(async () => { map.fire('mousemove', { point: { x: 2, y: 2 } }); await vi.advanceTimersByTimeAsync(600); });
  expect(document.querySelector('.maplibregl-popup')).toBeNull();
});
it('keeps a clicked popup open while the pointer moves away, and dismisses on empty-map click', async () => {
  const { map } = await mount();
  act(() => map.fire('click', { point: { x: 1, y: 1 } }));
  map.features = [];
  await act(async () => { map.fire('mousemove', { point: { x: 2, y: 2 } }); await vi.advanceTimersByTimeAsync(600); });
  expect(screen.getByRole('heading', { name: school.name })).toBeTruthy();
  act(() => map.fire('click', { point: { x: 2, y: 2 } }));
  expect(document.querySelector('.maplibregl-popup')).toBeNull();
});
it('previews a collision on hover without requesting full detail', async () => {
  const { map, initial } = await mount({ schools: [], view: collisionView() });
  await act(async () => { map.fire('mousemove', { point: { x: 1, y: 1 } }); await vi.advanceTimersByTimeAsync(400); });
  expect(document.querySelector('.maplibregl-popup')?.textContent).toContain('Serious');
  expect(initial.onCollisionClick).not.toHaveBeenCalled();
});
it('can click the same school repeatedly without the previous popup closing the replacement', async () => {
  const { map } = await mount();
  act(() => map.fire('click', { point: { x: 1, y: 1 } }));
  act(() => map.fire('click', { point: { x: 1, y: 1 } }));
  expect(screen.getAllByRole('heading', { name: school.name })).toHaveLength(1);
});
it('keeps a pinned popup when hovering another marker', async () => {
  const { map, initial, rerender } = await mount();
  act(() => map.fire('click', { point: { x: 1, y: 1 } }));
  rerender(createElement(MapView, { ...initial, schools: [{ ...school, id: 'other', name: 'Other School' }] }));
  await act(async () => { await vi.advanceTimersByTimeAsync(20); map.fire('mousemove', { point: { x: 1, y: 1 } }); await vi.advanceTimersByTimeAsync(400); });
  expect(screen.getByRole('heading', { name: school.name })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Other School' })).toBeNull();
});

it('does not replace a clicked school popup with late collision detail', async () => {
  const { map, initial, rerender } = await mount();
  const pending: Props = { ...initial, selectedCollisionId: detail.id, selectedPoint: [-2.5, 51.5] };
  rerender(createElement(MapView, pending));
  act(() => map.fire('click', { point: { x: 1, y: 1 } }));
  rerender(createElement(MapView, { ...pending, detail }));
  expect(screen.getByRole('heading', { name: school.name })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Old Road' })).toBeNull();
});

it('lets the user select a school from an overlapping marker picker', async () => {
  const { map, initial } = await mount({ schools: [school, { ...school, id: 'other', name: 'Other School' }] });
  act(() => map.fire('click', { point: { x: 1, y: 1 } }));
  fireEvent.click(screen.getByRole('button', { name: school.name }));
  expect(initial.onSchoolClick).toHaveBeenCalledWith(school);
  expect(screen.getByRole('heading', { name: school.name })).toBeTruthy();
});
it('dismisses hover previews when the map starts moving', async () => {
  const { map } = await mount();
  await act(async () => { map.fire('mousemove', { point: { x: 1, y: 1 } }); await vi.advanceTimersByTimeAsync(400); });
  expect(screen.getByRole('heading', { name: school.name })).toBeTruthy();
  act(() => map.fire('movestart'));
  expect(document.querySelector('.maplibregl-popup')).toBeNull();
});
it('opens hover after delegated marker entry and repeated mouse movements', async () => {
  const { map } = await mount();
  await act(async () => {
    map.fire('mousemove', { point: { x: 1, y: 1 } });
    map.fire('mouseenter:display-circles');
    await vi.advanceTimersByTimeAsync(50);
    map.fire('mousemove', { point: { x: 2, y: 1 } });
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(screen.getByRole('heading', { name: school.name })).toBeTruthy();
});
it('keeps the hover preview when returning to the marker before dismissal', async () => {
  const { map } = await mount();
  await act(async () => { map.fire('mousemove', { point: { x: 1, y: 1 } }); await vi.advanceTimersByTimeAsync(400); });
  const features = map.features;
  await act(async () => {
    map.features = [];
    map.fire('mousemove', { point: { x: 2, y: 1 } });
    await vi.advanceTimersByTimeAsync(50);
    map.features = features;
    map.fire('mousemove', { point: { x: 1, y: 1 } });
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(screen.getByRole('heading', { name: school.name })).toBeTruthy();
});
const analysisGroup: NonNullable<Props['selectedAnalysisGroup']> = {
  id: 'group1', anchor: { collisionId: 'collision1', latitude: 51.5, longitude: -2.5 }, collisions: 3, yearsRepresented: [2024, 2025],
  harm: { collisionSeverity: { fatal: 0, serious: 1, slight: 2, unknown: 0 }, casualties: { total: { value: 3, unknownRecords: 0 }, fatalities: { value: 0, unknownRecords: 0 }, serious: { value: 1, unknownRecords: 0 }, slight: { value: 2, unknownRecords: 0 }, ksi: { value: 1, unknownRecords: 0 } }, ksiCollisions: 1, ksiCollisionYears: [2025] },
  memberIds: ['collision1', 'collision2', 'collision3'], schoolProximity: { within500m: false, within1km: false, nearestSchool: null },
};
it('allows a fresh sidebar site selection to replace a clicked school popup', async () => {
  const { map, initial, rerender } = await mount();
  act(() => map.fire('click', { point: { x: 1, y: 1 } }));
  rerender(createElement(MapView, { ...initial, selectedAnalysisGroup: analysisGroup }));
  expect(screen.getByRole('heading', { name: 'Persistent collision site' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: school.name })).toBeNull();
});
it('closes a pending collision popup when the sidebar selection is cleared', async () => {
  const { map, initial, rerender } = await mount({ schools: [], view: collisionView() });
  act(() => map.fire('click', { point: { x: 1, y: 1 } }));
  rerender(createElement(MapView, { ...initial, selectedCollisionId: 'collision1', selectedPoint: [-2.5, 51.5] }));
  expect(document.querySelector('.maplibregl-popup')).not.toBeNull();
  rerender(createElement(MapView, initial));
  expect(document.querySelector('.maplibregl-popup')).toBeNull();
});
it('closes a sidebar site popup after switching from a school', async () => {
  const { map, initial, rerender } = await mount();
  act(() => map.fire('click', { point: { x: 1, y: 1 } }));
  rerender(createElement(MapView, { ...initial, selectedAnalysisGroup: analysisGroup }));
  expect(screen.getByRole('heading', { name: 'Persistent collision site' })).toBeTruthy();
  rerender(createElement(MapView, initial));
  expect(document.querySelector('.maplibregl-popup')).toBeNull();
});
it('keeps hover open when leaving the label but remaining over its circle', async () => {
  const { map } = await mount();
  await act(async () => { map.fire('mousemove', { point: { x: 1, y: 1 } }); await vi.advanceTimersByTimeAsync(400); });
  await act(async () => {
    map.fire('mousemove', { point: { x: 2, y: 1 } });
    map.fire('mouseleave:display-label', { point: { x: 2, y: 1 } });
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(screen.getByRole('heading', { name: school.name })).toBeTruthy();
});
