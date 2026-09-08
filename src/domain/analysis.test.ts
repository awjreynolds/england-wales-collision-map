import { describe, expect, it } from 'vitest';
import { groupPersistentLocations } from './analysis';
import type { CollisionRecord } from './model';

const collision = (id: string, latitude: number, longitude: number, year: number): CollisionRecord => ({
  id, date: `${year}-01-01`, year, latitude, longitude, severity: 'slight', localAuthority: 'Bristol',
  roadName: null, roadNumber: null, speedLimit: null, junctionDetail: null, casualtyCount: 1,
  fatalities: 0, seriousCasualties: 0, ksiCasualties: 0, pedestrianInvolved: null, cycleInvolved: null,
  motorcycleInvolved: null, sourceProperties: {},
});

describe('persistent collision grouping', () => {
  it('requires three collisions across at least two years', () => {
    const oneYear = [collision('a', 51.45, -2.59, 2021), collision('b', 51.4501, -2.59, 2021), collision('c', 51.4502, -2.59, 2021)];
    expect(groupPersistentLocations(oneYear, 100, 3, 2)).toHaveLength(0);
    const twoYears = [...oneYear, collision('d', 51.45005, -2.59, 2022)];
    expect(groupPersistentLocations(twoYears, 100, 3, 2)).toMatchObject([{ collisions: 4, years: [2021, 2022] }]);
  });

  it('uses the stable anchor without chain-merging points', () => {
    // Roughly 90m apart in a line: A absorbs B, but C is outside A's radius.
    const records = [
      collision('a', 51.45, -2.59, 2021),
      collision('b', 51.4508, -2.59, 2022),
      collision('c', 51.4516, -2.59, 2023),
    ];
    expect(groupPersistentLocations(records, 100, 2, 1)).toHaveLength(1);
    expect(groupPersistentLocations(records, 100, 2, 1)[0].memberIds).toEqual(['a', 'b']);
  });

  it('is deterministic regardless of input order', () => {
    const records = [collision('z', 51.45, -2.59, 2021), collision('a', 51.4501, -2.59, 2022), collision('m', 51.4502, -2.59, 2023)];
    expect(groupPersistentLocations(records, 100, 3, 2)).toEqual(groupPersistentLocations([...records].reverse(), 100, 3, 2));
  });

  it('keeps a near-radius point that straddles a geographic index cell edge', () => {
    const anchorLatitude = (5727400 - 0.02) / 111320;
    const edgeCandidateLatitude = (5727500 + 0.03) / 111320;
    const records = [
      collision('a', anchorLatitude, -2.59, 2021),
      collision('b', anchorLatitude, -2.59, 2022),
      collision('c', edgeCandidateLatitude, -2.59, 2023),
    ];
    expect(groupPersistentLocations(records, 100, 3, 2)).toMatchObject([{
      collisions: 3,
      memberIds: ['a', 'b', 'c'],
      latitude: anchorLatitude,
      longitude: -2.59,
    }]);
  });
});
