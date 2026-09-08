import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  codeValue,
  coordinate,
  finalizeCollision,
  integerValue,
  isoDate,
  roadNumber,
  rowId,
  rowYear,
  severity,
  type CollisionAccumulator,
  type RawRow,
} from '../../scripts/ingest-stats19';

const accumulator = (overrides: Partial<CollisionAccumulator> = {}): CollisionAccumulator => ({
  id: '2021-test',
  year: 2021,
  raw: {
    collision_index: '2021-test',
    collision_year: '2021',
    collision_severity: '2',
    date: '04/02/2021',
    latitude: '51.45',
    longitude: '-2.59',
    first_road_class: '3',
    first_road_number: '4',
    speed_limit: '30',
    junction_detail: '3',
    number_of_casualties: '1',
    number_of_vehicles: '1',
    time: '12:30',
  },
  authorityCode: 'E06000023',
  authority: 'Bristol',
  latitude: 51.45,
  longitude: -2.59,
  rawCasualties: 1,
  rawVehicles: 1,
  casualtyRows: 1,
  casualtyFatalities: 0,
  casualtySerious: 1,
  casualtyTypes: new Set([9]),
  vehicleRows: 1,
  vehicleTypes: new Set([9]),
  unknownCasualtyTypes: 0,
  unknownCasualtySeverities: 0,
  unknownVehicleTypes: 0,
  missingCasualtyReferences: 0,
  missingVehicleReferences: 0,
  casualtyReferences: new Set(['1']),
  vehicleReferences: new Set(['1']),
  duplicateCasualtyReferences: 0,
  duplicateVehicleReferences: 0,
  casualtyRecords: [{ reference: '1', vehicleReference: '1', typeCode: 9, severityCode: 2 }],
  vehicleRecords: [{ reference: '1', typeCode: 9 }],
  ...overrides,
});

describe('STATS19 source normalization', () => {
  it('accepts both the old accident_* and current collision_* source names', () => {
    const oldRow: RawRow = {
      accident_index: '2020010219808',
      accident_year: '2020',
      accident_severity: '1',
      date: '02/01/2020',
      latitude: '51.45',
      longitude: '-2.59',
      first_road_class: '3',
      first_road_number: '4',
    };
    const currentRow: RawRow = {
      collision_index: '202417S111924',
      collision_year: '2024',
      collision_severity: '3',
      date: '22/10/2024',
      latitude: '51.45',
      longitude: '-2.59',
      first_road_class: '3',
      first_road_number: '139',
    };
    expect(rowId(oldRow)).toBe('2020010219808');
    expect(rowYear(oldRow, 1999)).toBe(2020);
    expect(severity(oldRow)).toBe('fatal');
    expect(isoDate(oldRow)).toBe('2020-01-02');
    expect(roadNumber(oldRow)).toBe('A4');
    expect(rowId(currentRow)).toBe('202417S111924');
    expect(rowYear(currentRow, 1999)).toBe(2024);
    expect(severity(currentRow)).toBe('slight');
    expect(isoDate(currentRow)).toBe('2024-10-22');
    expect(roadNumber(currentRow)).toBe('A139');
  });

  it('rejects blank, non-numeric and out-of-range coordinates without Number("") coercion', () => {
    expect(coordinate({ latitude: '', longitude: '-2.59' })).toBeNull();
    expect(coordinate({ latitude: 'NaN', longitude: '-2.59' })).toBeNull();
    expect(coordinate({ latitude: '51.45', longitude: '' })).toBeNull();
    expect(coordinate({ latitude: '51.45', longitude: '-20' })).toBeNull();
    expect(coordinate({ latitude: '51.45', longitude: '-2.59' })).toEqual({ latitude: 51.45, longitude: -2.59 });
  });

  it('keeps casualty measures nullable when a casualty join is incomplete', () => {
    const record = finalizeCollision(accumulator({
      rawCasualties: 2,
      rawVehicles: 2,
      casualtyRows: 1,
      casualtyTypes: new Set([0]),
      vehicleRows: 1,
      vehicleTypes: new Set([1]),
    }));
    expect(record.casualtyCount).toBe(2);
    expect(record.fatalities).toBeNull();
    expect(record.seriousCasualties).toBeNull();
    expect(record.ksiCasualties).toBeNull();
    expect(record.pedestrianInvolved).toBe(true);
    expect(record.cycleInvolved).toBe(true);
    expect(record.motorcycleInvolved).toBeNull();
    expect(record.sourceProperties).toMatchObject({ casualtyJoinComplete: false, vehicleJoinComplete: false });
  });

  it('maps complete joined rows to fatal, serious and road-user measures', () => {
    const record = finalizeCollision(accumulator({
      raw: { ...accumulator().raw, collision_severity: '1', accident_severity: '1' },
      casualtyFatalities: 1,
      casualtySerious: 0,
      casualtyTypes: new Set([0]),
      vehicleTypes: new Set([2]),
    }));
    expect(record.severity).toBe('fatal');
    expect(record.fatalities).toBe(1);
    expect(record.seriousCasualties).toBe(0);
    expect(record.ksiCasualties).toBe(1);
    expect(record.pedestrianInvolved).toBe(true);
    expect(record.cycleInvolved).toBe(false);
    expect(record.motorcycleInvolved).toBe(true);
  });

  it('keeps severity measures nullable when a joined casualty has an unknown severity', () => {
    const record = finalizeCollision(accumulator({ unknownCasualtySeverities: 1 }));
    expect(record.fatalities).toBeNull();
    expect(record.seriousCasualties).toBeNull();
    expect(record.ksiCasualties).toBeNull();
    expect(record.sourceProperties.casualtyClassificationComplete).toBe(false);
  });

  it('keeps known severity totals when only the casualty type is unknown', () => {
    const record = finalizeCollision(accumulator({
      casualtyFatalities: 1,
      casualtySerious: 0,
      casualtyTypes: new Set([99]),
      unknownCasualtyTypes: 1,
    }));
    expect(record.fatalities).toBe(1);
    expect(record.seriousCasualties).toBe(0);
    expect(record.ksiCasualties).toBe(1);
    expect(record.pedestrianInvolved).toBeNull();
  });

  it('uses the second road class with the second road number and preserves 99/999 road numbers', () => {
    expect(roadNumber({ first_road_class: '3', first_road_number: '0', second_road_class: '4', second_road_number: '3130' })).toBe('B3130');
    expect(roadNumber({ first_road_class: '3', first_road_number: '99' })).toBe('A99');
    expect(roadNumber({ first_road_class: '3', first_road_number: '999' })).toBe('A999');
    expect(integerValue({ number_of_casualties: '1.4' }, ['number_of_casualties'])).toBeNull();
    expect(roadNumber({ first_road_class: '3.6', first_road_number: '3130.4' })).toBeNull();
  });

  it('does not invent a severity for an unknown source code', () => {
    expect(severity({ collision_severity: '9' })).toBe('unknown');
  });

  it('preserves coded 90 and 99 values so the adapter can distinguish other from unknown', () => {
    expect(codeValue({ vehicle_type: '90' }, ['vehicle_type'])).toBe(90);
    expect(codeValue({ vehicle_type: '99' }, ['vehicle_type'])).toBe(99);
    const electricMotorcycle = finalizeCollision(accumulator({ vehicleTypes: new Set([23]) }));
    expect(electricMotorcycle.motorcycleInvolved).toBe(true);
    const unknownVehicle = finalizeCollision(accumulator({
      vehicleTypes: new Set([99]),
      unknownVehicleTypes: 1,
    }));
    expect(unknownVehicle.motorcycleInvolved).toBeNull();
    expect(unknownVehicle.sourceProperties.vehicleTypeCodes).toEqual([99]);
  });
});

describe('generated source joins', () => {
  it('keeps each generated feature tied to its year and complete source joins', () => {
    const data = JSON.parse(readFileSync('public/data/collisions.geojson', 'utf8')) as {
      features: Array<{ id: string; properties: Record<string, unknown> }>;
    };
    const provenance = JSON.parse(readFileSync('public/data/provenance.json', 'utf8')) as {
      casualtyCoverage?: string;
      involvementCoverage?: string;
      validation?: Record<string, number>;
    };
    expect(data.features.length).toBeGreaterThan(0);
    for (const feature of data.features) {
      const props = feature.properties;
      const source = props.sourceProperties as Record<string, unknown>;
      expect(source.sourceId).toBe(feature.id);
      expect(source.sourceYear).toBe(props.year);
      expect(source.casualtyJoinComplete).toBe(true);
      expect(source.vehicleJoinComplete).toBe(true);
      expect(source.casualtyRowsJoined).toBe(source.rawCasualtyCount);
      expect(source.vehicleRowsJoined).toBe(source.rawVehicleCount);
      expect(Array.isArray(source.casualtyRecords)).toBe(true);
      expect(Array.isArray(source.vehicleRecords)).toBe(true);
      expect((source.casualtyRecords as unknown[]).length).toBe(source.casualtyRowsJoined);
      expect((source.vehicleRecords as unknown[]).length).toBe(source.vehicleRowsJoined);
    }
    expect(provenance.casualtyCoverage).toBe('complete');
    expect(provenance.validation?.collisionsWithCompleteCasualtySeverity).toBe(data.features.length);
    expect(provenance.involvementCoverage).toBe('partial');
    expect(provenance.validation?.collisionsWithCompletePedestrianClassification).toBeLessThan(data.features.length);
  });
});
