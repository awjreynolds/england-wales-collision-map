import { describe, expect, it } from 'vitest';
import { normalizeRecord, parseCollisionGeoJson } from './geojson';

describe('collision GeoJSON transformation', () => {
  it('normalizes DfT-style aliases and derives road-user involvement from linked evidence', () => {
    const record = normalizeRecord({ accident_index: 'abc', accident_year: 2022, accident_severity: 2, local_authority_district: 'Bristol', number_of_casualties: 2, casualties: [{ casualty_type: 0 }, { casualty_type: 1 }], vehicles: [{ vehicle_type: 4 }] }, [-2.59, 51.45], 'fallback');
    expect(record.id).toBe('abc');
    expect(record.severity).toBe('serious');
    expect(record.localAuthority).toBe('Bristol');
    expect(record.pedestrianInvolved).toBe(true);
    expect(record.cycleInvolved).toBe(true);
    expect(record.motorcycleInvolved).toBe(true);
    expect(record.casualtyCount).toBe(2);
  });

  it('retains missingness and reports invalid geometries instead of fabricating values', () => {
    const result = parseCollisionGeoJson({ type: 'FeatureCollection', features: [
      { type: 'Feature', id: 'valid', geometry: { type: 'Point', coordinates: [-2.59, 51.45] }, properties: { severity: 'slight' } },
      { type: 'Feature', id: 'bad', geometry: { type: 'Point', coordinates: [null, 51.45] }, properties: {} },
      { type: 'Feature', id: 'line', geometry: { type: 'LineString', coordinates: [] }, properties: {} },
    ] });
    expect(result.records).toHaveLength(1);
    expect(result.invalidCount).toBe(2);
    expect(result.records[0].year).toBeNull();
    expect(result.records[0].pedestrianInvolved).toBeNull();
  });

  it('preserves explicit null involvement and does not turn incomplete linked evidence into no', () => {
    const explicitUnknown = normalizeRecord({
      pedestrianInvolved: null,
      cycleInvolved: null,
      motorcycleInvolved: null,
      casualties: [{ casualty_type: 0 }],
      vehicles: [{ vehicle_type: 4 }],
    }, [-2.59, 51.45], 'explicit-unknown');
    expect(explicitUnknown.pedestrianInvolved).toBeNull();
    expect(explicitUnknown.cycleInvolved).toBeNull();
    expect(explicitUnknown.motorcycleInvolved).toBeNull();

    const incompleteEvidence = normalizeRecord({
      casualties: [{ casualty_type: null }],
      vehicles: [{ vehicle_type: null }],
    }, [-2.59, 51.45], 'incomplete-evidence');
    expect(incompleteEvidence.pedestrianInvolved).toBeNull();
    expect(incompleteEvidence.cycleInvolved).toBeNull();
    expect(incompleteEvidence.motorcycleInvolved).toBeNull();
  });

  it('uses explicit road-user categories without overlapping motorcycle and cycle', () => {
    const motorcycle = normalizeRecord({ vehicles: [{ vehicle_type: 'motorcycle' }] }, [-2.59, 51.45], 'motorcycle-text');
    const motorbike = normalizeRecord({ vehicles: [{ vehicle_type: 'motorbike' }] }, [-2.59, 51.45], 'motorbike-text');
    const bicycle = normalizeRecord({ vehicles: [{ vehicle_type: 'bicycle' }] }, [-2.59, 51.45], 'bicycle-text');
    const motorcycle23 = normalizeRecord({ vehicles: [{ vehicle_type: 23 }] }, [-2.59, 51.45], 'motorcycle-23');
    const motorcycle97 = normalizeRecord({ vehicles: [{ vehicle_type: 97 }] }, [-2.59, 51.45], 'motorcycle-97');

    expect(motorcycle.cycleInvolved).toBeNull();
    expect(motorcycle.motorcycleInvolved).toBe(true);
    expect(motorbike.cycleInvolved).toBeNull();
    expect(motorbike.motorcycleInvolved).toBe(true);
    expect(bicycle.cycleInvolved).toBe(true);
    expect(bicycle.motorcycleInvolved).toBeNull();
    expect(motorcycle23.motorcycleInvolved).toBe(true);
    expect(motorcycle97.motorcycleInvolved).toBe(true);

    const explicitNo = normalizeRecord({ cycleInvolved: false, vehicles: [{ vehicle_type: 'bicycle' }] }, [-2.59, 51.45], 'explicit-no');
    expect(explicitNo.cycleInvolved).toBe(false);
  });

  it('does not infer a casualty total from an explicitly null count and a partial list', () => {
    const record = normalizeRecord({ casualtyCount: null, casualties: [{ casualty_type: 9 }] }, [-2.59, 51.45], 'partial-casualty-list');
    expect(record.casualtyCount).toBeNull();
    expect(record.pedestrianInvolved).toBeNull();
  });

  it('derives KSI only when both component casualty counts are known', () => {
    expect(normalizeRecord({ fatalities: 1, seriousCasualties: null }, [-2.59, 51.45], 'unknown-serious').ksiCasualties).toBeNull();
    expect(normalizeRecord({ fatalities: 0 }, [-2.59, 51.45], 'unknown-serious').ksiCasualties).toBeNull();
    expect(normalizeRecord({ fatalities: 0, seriousCasualties: 0 }, [-2.59, 51.45], 'known-zero').ksiCasualties).toBe(0);
    expect(normalizeRecord({ fatalities: 1, seriousCasualties: 2, ksiCasualties: null }, [-2.59, 51.45], 'explicit-ksi-unknown').ksiCasualties).toBeNull();
    expect(normalizeRecord({ fatalities: 1, seriousCasualties: 2, ksiCasualties: 8 }, [-2.59, 51.45], 'explicit-ksi').ksiCasualties).toBe(8);
  });
});
