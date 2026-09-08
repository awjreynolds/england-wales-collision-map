import { AUTHORITIES } from './config';
import type { AuthoritySummary, CollisionRecord, Involvement, RegionSummary, Severity } from './model';

export type DimensionFilter = 'all' | 'yes' | 'no' | 'unknown';

export interface FilterState {
  years: number[];
  authorities: string[];
  severities: Severity[];
  pedestrian: DimensionFilter;
  cycle: DimensionFilter;
  motorcycle: DimensionFilter;
}

export const DEFAULT_FILTERS: FilterState = {
  years: [],
  authorities: [],
  severities: [],
  pedestrian: 'all',
  cycle: 'all',
  motorcycle: 'all',
};

export const filterInvolvement = (value: Involvement, filter: DimensionFilter): boolean => {
  if (filter === 'all') return true;
  if (filter === 'yes') return value === true;
  if (filter === 'no') return value === false;
  return value === null;
};

export const matchesFilters = (record: CollisionRecord, filters: FilterState): boolean => {
  if (filters.years.length && (record.year === null || !filters.years.includes(record.year))) return false;
  if (filters.authorities.length && (record.localAuthority === null || !filters.authorities.includes(record.localAuthority))) return false;
  if (filters.severities.length && !filters.severities.includes(record.severity)) return false;
  return filterInvolvement(record.pedestrianInvolved, filters.pedestrian) &&
    filterInvolvement(record.cycleInvolved, filters.cycle) &&
    filterInvolvement(record.motorcycleInvolved, filters.motorcycle);
};

export const filterRecords = (records: CollisionRecord[], filters: FilterState): CollisionRecord[] =>
  records.filter((record) => matchesFilters(record, filters));

const nullableSum = (records: CollisionRecord[], field: 'casualtyCount' | 'fatalities' | 'seriousCasualties' | 'ksiCasualties'): { value: number | null; unknown: number } => {
  const values = records.map((record) => record[field]);
  const present = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return { value: present.length ? present.reduce((sum, value) => sum + value, 0) : null, unknown: values.length - present.length };
};

const severityCounts = (records: CollisionRecord[]) => ({
  fatal: records.filter((record) => record.severity === 'fatal').length,
  serious: records.filter((record) => record.severity === 'serious').length,
  slight: records.filter((record) => record.severity === 'slight').length,
  unknown: records.filter((record) => record.severity === 'unknown').length,
});

const compareAuthorities = (left: AuthoritySummary, right: AuthoritySummary): number =>
  right.collisions - left.collisions || left.authority.localeCompare(right.authority);

export const summarizeRecords = (records: CollisionRecord[]): RegionSummary => {
  const counts = severityCounts(records);
  const byAuthority = new Map<string, CollisionRecord[]>();
  records.forEach((record) => {
    const authority = record.localAuthority ?? 'Authority not recorded';
    const list = byAuthority.get(authority) ?? [];
    list.push(record);
    byAuthority.set(authority, list);
  });
  const authorities = [...new Set([...AUTHORITIES, ...byAuthority.keys()])]
    .map((authority) => {
      const subset = byAuthority.get(authority) ?? [];
      const count = severityCounts(subset);
      return {
        authority,
        collisions: subset.length,
        fatalCollisions: count.fatal,
        seriousCollisions: count.serious,
        slightCollisions: count.slight,
      };
    })
    .filter((summary) => summary.collisions > 0 || AUTHORITIES.includes(summary.authority as (typeof AUTHORITIES)[number]))
    .sort(compareAuthorities);
  const casualties = nullableSum(records, 'casualtyCount');
  const fatalities = nullableSum(records, 'fatalities');
  const seriousCasualties = nullableSum(records, 'seriousCasualties');
  const ksiCasualties = nullableSum(records, 'ksiCasualties');
  return {
    collisions: records.length,
    fatalCollisions: counts.fatal,
    seriousCollisions: counts.serious,
    slightCollisions: counts.slight,
    unknownSeverity: counts.unknown,
    casualties: casualties.value,
    casualtiesUnknown: casualties.unknown,
    fatalities: fatalities.value,
    fatalitiesUnknown: fatalities.unknown,
    seriousCasualties: seriousCasualties.value,
    seriousCasualtiesUnknown: seriousCasualties.unknown,
    ksiCasualties: ksiCasualties.value,
    ksiCasualtiesUnknown: ksiCasualties.unknown,
    authorities,
  };
};

export const availableYears = (records: CollisionRecord[]): number[] =>
  [...new Set(records.map((record) => record.year).filter((year): year is number => year !== null))].sort((a, b) => b - a);

export const availableAuthorities = (records: CollisionRecord[]): string[] =>
  [...new Set([...AUTHORITIES, ...records.map((record) => record.localAuthority).filter((authority): authority is string => Boolean(authority))])];
