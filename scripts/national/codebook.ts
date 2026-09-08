/**
 * STATS19 type-code lists used by the national build.
 *
 * These values are taken from the DfT Road Safety Open Dataset data guide for
 * the 2025 release.  Unknown and not-recorded values (including 99 and -1)
 * are deliberately not folded into a known type.
 */

export const CODEBOOK_URL =
  'https://assets.publishing.service.gov.uk/media/6a63900b2dc18ebe4c3b2bc8/dft-road-casualty-statistics-road-safety-open-dataset-data-guide-2025.xlsx';

export const PEDESTRIAN_CASUALTY_TYPES: ReadonlySet<number> = new Set([0]);
export const CYCLIST_VEHICLE_TYPES: ReadonlySet<number> = new Set([1]);
export const MOTORCYCLE_VEHICLE_TYPES: ReadonlySet<number> = new Set([2, 3, 4, 5, 23, 97]);

export const KNOWN_CASUALTY_TYPES: ReadonlySet<number> = new Set([
  0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 23, 90, 97, 98,
]);

export const KNOWN_VEHICLE_TYPES: ReadonlySet<number> = new Set([
  1, 2, 3, 4, 5, 8, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 23, 90, 97, 98,
]);

export const KNOWN_COLLISION_SEVERITIES: ReadonlySet<number> = new Set([1, 2, 3]);
export const KNOWN_CASUALTY_SEVERITIES: ReadonlySet<number> = new Set([1, 2, 3]);

export const CODEBOOK_NOTES = [
  'Code 90 is the documented other category and remains known.',
  'Code 99 and -1 are retained as source evidence but treated as unknown or not recorded.',
  'Involvement is derived from casualty_type and vehicle_type in the joined source rows.',
] as const;
