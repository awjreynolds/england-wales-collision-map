import type { CollisionRecord } from './model';

export interface ViewportBounds {
  west: number;
  east: number;
  south: number;
  north: number;
}

const normalizeLongitude = (longitude: number): number => {
  const wrapped = ((longitude + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 && longitude > 0 ? 180 : wrapped;
};

const longitudeInBounds = (longitude: number, west: number, east: number): boolean => {
  // MapLibre can expose bounds wider than the world while world copies are
  // visible. In that case every longitude is in the viewport.
  if (Math.abs(east - west) >= 360) return true;
  const point = normalizeLongitude(longitude);
  const normalizedWest = normalizeLongitude(west);
  const normalizedEast = normalizeLongitude(east);
  return normalizedWest <= normalizedEast
    ? point >= normalizedWest && point <= normalizedEast
    : point >= normalizedWest || point <= normalizedEast;
};

/** Select records by their coordinates, independently of rendered MapLibre clusters. */
export const recordsInViewport = (records: CollisionRecord[], bounds: ViewportBounds): CollisionRecord[] => records.filter((record) =>
  record.latitude >= bounds.south && record.latitude <= bounds.north && longitudeInBounds(record.longitude, bounds.west, bounds.east),
);

export interface CasualtySeveritySummary {
  fatalities: number | null;
  fatalitiesUnknown: number;
  serious: number | null;
  seriousUnknown: number;
  slight: number | null;
  slightUnknown: number;
}

const sumNullable = (values: Array<number | null>): { value: number | null; unknown: number } => {
  const present = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return {
    value: present.length ? present.reduce((sum, value) => sum + value, 0) : null,
    unknown: values.length - present.length,
  };
};

/** Derive the casualty severity split only from records with all three inputs recorded. */
export const summarizeCasualtySeverities = (records: CollisionRecord[]): CasualtySeveritySummary => {
  const fatalities = sumNullable(records.map((record) => record.fatalities));
  const serious = sumNullable(records.map((record) => record.seriousCasualties));
  const slightValues = records.map((record) => {
    if (record.casualtyCount === null || record.fatalities === null || record.seriousCasualties === null) return null;
    const slight = record.casualtyCount - record.fatalities - record.seriousCasualties;
    return slight >= 0 ? slight : null;
  });
  const slight = sumNullable(slightValues);
  return {
    fatalities: fatalities.value,
    fatalitiesUnknown: fatalities.unknown,
    serious: serious.value,
    seriousUnknown: serious.unknown,
    slight: slight.value,
    slightUnknown: slight.unknown,
  };
};
