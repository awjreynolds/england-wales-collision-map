import { describe, expect, it } from 'vitest';
import { layoutScreenMarkers, screenMarkerGap, type ScreenMarker } from './screenMarkers';

const marker = (id: string, x: number, y: number, kind: ScreenMarker['kind'] = 'collision', overrides: Partial<ScreenMarker> = {}): ScreenMarker => ({
  id, x, y, radius: 8, kind, weight: 1, longitude: x / 100, latitude: y / 100, ...overrides,
});

const expectGap = (groups: ReturnType<typeof layoutScreenMarkers>, minimum = 6): void => {
  for (let left = 0; left < groups.length; left += 1) for (let right = left + 1; right < groups.length; right += 1) {
    expect(screenMarkerGap(groups[left], groups[right])).toBeGreaterThanOrEqual(minimum - 0.0001);
  }
};

describe('screen marker layout', () => {
  it('keeps every rendered circle at least six pixels clear of every other circle', () => {
    const groups = layoutScreenMarkers([
      marker('a', 0, 0, 'aggregate', { radius: 30, collisionCount: 2 }),
      marker('b', 38, 0, 'aggregate', { radius: 26, collisionCount: 3 }),
      marker('c', 70, 4, 'analysis', { radius: 20 }),
      marker('d', 110, 7, 'school', { radius: 8 }),
    ]);
    expectGap(groups);
  });

  it('rechecks a chain after its weighted centre moves and keeps all members', () => {
    const groups = layoutScreenMarkers([
      marker('a', 0, 0, 'collision'),
      marker('b', 20, 0, 'collision'),
      marker('c', 34, 0, 'collision'),
    ], { clusterDistance: 30 });
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((item) => item.id).sort()).toEqual(['a', 'b', 'c']);
    expect(groups[0].centroidX).toBeCloseTo(18);
  });

  it('preserves a weighted collision centre while keeping the display radius bounded', () => {
    const groups = layoutScreenMarkers([
      marker('low', 0, 0, 'aggregate', { weight: 1, collisionCount: 1, radius: 18 }),
      marker('high', 20, 0, 'aggregate', { weight: 9, collisionCount: 9, radius: 18 }),
    ], { maxGroupRadius: 22 });
    expect(groups).toHaveLength(1);
    expect(groups[0].centroidX).toBeCloseTo(18);
    expect(groups[0].radius).toBeLessThanOrEqual(22);
    expect(groups[0].collisionCount).toBe(10);
  });

  it('does not lose coincident mixed markers or double count hotspot collisions', () => {
    const groups = layoutScreenMarkers([
      marker('cell', 50, 50, 'aggregate', { collisionCount: 25 }),
      marker('hotspot', 50, 50, 'analysis', { weight: 25, collisionCount: 25 }),
      marker('school', 50, 50, 'school'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(3);
    expect(groups[0].counts).toEqual({ collision: 0, aggregate: 1, analysis: 1, school: 1 });
    expect(groups[0].kind).toBe('cluster');
    expect(groups[0].collisionCount).toBe(25);
    expect(groups[0].label).toBe('25');
  });

  it('keeps a large school cluster label inside its bounded circle', () => {
    const groups = layoutScreenMarkers(Array.from({ length: 100 }, (_, index) => marker(`school-${index}`, 20, 20, 'school')));
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('S100');
    expect(groups[0].radius).toBeGreaterThanOrEqual(4 + groups[0].label.length * 3.5);
    expect(groups[0].radius).toBeLessThanOrEqual(26);
  });

  it('maintains the gap at a narrow mobile viewport and retains geographic bounds', () => {
    const groups = layoutScreenMarkers([
      marker('left', 8, 12, 'school', { longitude: -3, latitude: 50.5, bounds: { west: -3.01, east: -2.99, south: 50.49, north: 50.51 } }),
      marker('middle', 18, 13, 'collision', { longitude: -2.9, latitude: 50.51 }),
      marker('right', 30, 12, 'school', { longitude: -2.8, latitude: 50.52 }),
    ], { maxGroupSpan: 36, clusterDistance: 20 });
    expectGap(groups);
    expect(groups.flatMap((group) => group.members)).toHaveLength(3);
    const bounds = groups.map((group) => group.bounds);
    expect(Math.min(...bounds.map((item) => item.west))).toBe(-3.01);
    expect(Math.max(...bounds.map((item) => item.east))).toBe(-2.8);
  });
});
