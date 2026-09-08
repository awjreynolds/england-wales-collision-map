/**
 * Primary-source caveats and analytical defaults shared by the UI and the
 * generated data manifest. Keep the wording here so the warning cannot drift
 * between cards, popups and provenance panels.
 */

export interface DataQualitySource {
  label: string;
  url: string;
}

export interface DataQualityWarning {
  id: string;
  title: string;
  affectedYears: readonly number[];
  text: string;
  sources: readonly DataQualitySource[];
}

export const AVON_AND_SOMERSET_RECORDING_WARNING = {
  id: 'avon-and-somerset-recording-2022-23',
  title: 'Interpret the 2022–23 Avon & Somerset series with care',
  affectedYears: [2022, 2023],
  text:
    'The Department for Transport reports that Avon and Somerset Police changed collision recording systems during 2022. Formatting and export problems, including missing key data, affected local processing and validation and delayed supply, so some records may have been missing or incomplete at publication. The 2023 annual report also warns that collisions in the force area may have been misrecorded or not recorded at all. Treat affected counts and local comparisons as provisional; this warning does not provide an adjustment. Do not infer a trend, forecast, or exposure-adjusted risk from the affected series.',
  sources: [
    {
      label: 'DfT: Road casualty statistics: known data issues',
      url: 'https://www.gov.uk/government/publications/reported-road-casualty-statistics-background-quality-report/road-casualty-statistics-known-data-issues',
    },
    {
      label: 'DfT: Reported road casualties Great Britain, annual report: 2023',
      url: 'https://www.gov.uk/government/statistics/reported-road-casualties-great-britain-annual-report-2023/reported-road-casualties-great-britain-annual-report-2023',
    },
  ],
} as const satisfies DataQualityWarning;

export const PERSISTENT_LOCATION_DEFAULTS = {
  radiusMetres: 100,
  minCollisions: 3,
  minDistinctYears: 2,
} as const;

/**
 * The display clustering used by a map is separate from this metric. An
 * implementation should sort records by a stable identifier, take the first
 * unassigned record as an anchor, and assign only unassigned records within
 * `radiusMetres` of that anchor using the haversine distance. It must then
 * repeat with the next unassigned record. This bounded, anchored rule avoids
 * implying that a transitive chain of nearby points is one 100m location.
 */
export const PERSISTENT_LOCATION_METHOD = {
  id: 'anchored-haversine',
  label: 'Anchored 100m collision concentration',
  description:
    'Deterministic anchored groups using true haversine distance. A group is persistent when it contains at least three collisions from at least two distinct calendar years in the active selection.',
  distance: 'haversine' as const,
  defaults: PERSISTENT_LOCATION_DEFAULTS,
} as const;

export const DATA_QUALITY_METADATA = {
  warning: AVON_AND_SOMERSET_RECORDING_WARNING,
  concentration: PERSISTENT_LOCATION_METHOD,
  limitations: [
    'STATS19 contains reported personal-injury road collisions, not every road incident.',
    'Collision concentration is a frequency grouping and is not exposure-adjusted risk, a causal finding, or an official site assessment.',
    'Fatal and serious collision counts are collision counts; KSI means killed or seriously injured casualties and requires casualty records.',
  ],
} as const;

