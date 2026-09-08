import type {
  AnalysisGroup,
  AnalysisHarmFilter,
  AnalysisPayload,
  AggregateProperties,
  BBox,
  CollisionDetail,
  GeoJsonFeature,
  QueryFilters,
  SchoolCoverage,
  SchoolCoverageProvenance,
  SchoolRecord,
  SummaryMetrics,
  ViewPayload,
  PointProperties,
} from '../../service/contract';
import { groupPersistentLocations } from '../domain/analysis';
import type { CollisionRecord } from '../domain/model';
import {
  staticCellKey,
  type StaticAdditiveSummaryMetrics,
  type StaticCellOverview,
  type StaticCollisionRecord,
  type StaticFacetDimensions,
  type StaticOverview,
  type StaticSchoolRecord,
} from './contract';

type MetricWithKsi = StaticAdditiveSummaryMetrics & { ksiCollisions?: number };

export interface CellSelection {
  contained: StaticCellOverview[];
  boundary: StaticCellOverview[];
}

export interface FilteredViewInput {
  overview: StaticOverview;
  records: StaticCollisionRecord[];
  /** Records from all selected cells when point mode is requested. */
  pointRecords?: StaticCollisionRecord[];
  /** Records from a small dense area used to refine an aggregate cell. */
  refineRecords?: StaticCollisionRecord[];
  filters: QueryFilters;
  bbox?: BBox;
  zoom?: number;
  maxFeatures?: number;
}

export interface AnalysisInput {
  records: StaticCollisionRecord[];
  schools: StaticSchoolRecord[];
  filters: QueryFilters;
  bbox: BBox;
  radiusMetres: 50 | 100 | 200 | 500;
  harmFilter: AnalysisHarmFilter;
  selectedSchoolId?: string;
  schoolDistanceMetres?: 500 | 1000;
}

const EMPTY_METRIC: MetricWithKsi = {
  collisions: 0,
  fatalCollisions: 0,
  seriousCollisions: 0,
  slightCollisions: 0,
  unknownSeverity: 0,
  casualtyCount: 0,
  casualtyCountUnknown: 0,
  fatalities: 0,
  fatalitiesUnknown: 0,
  seriousCasualties: 0,
  seriousCasualtiesUnknown: 0,
  slightCasualties: 0,
  slightCasualtiesUnknown: 0,
  ksiCasualties: 0,
  ksiCasualtiesUnknown: 0,
  ksiCollisions: 0,
};

const cloneMetric = (): MetricWithKsi => ({ ...EMPTY_METRIC });

const addNullable = (metric: MetricWithKsi, value: number | null, valueKey: keyof MetricWithKsi, unknownKey: keyof MetricWithKsi): void => {
  if (value === null || !Number.isFinite(value)) metric[unknownKey] = Number(metric[unknownKey]) + 1;
  else metric[valueKey] = Number(metric[valueKey]) + value;
};

export const metricForRecord = (record: StaticCollisionRecord): MetricWithKsi => {
  const metric = cloneMetric();
  metric.collisions = 1;
  if (record.severity === 'fatal') metric.fatalCollisions = 1;
  else if (record.severity === 'serious') metric.seriousCollisions = 1;
  else if (record.severity === 'slight') metric.slightCollisions = 1;
  else metric.unknownSeverity = 1;
  addNullable(metric, record.casualtyCount, 'casualtyCount', 'casualtyCountUnknown');
  addNullable(metric, record.fatalities, 'fatalities', 'fatalitiesUnknown');
  addNullable(metric, record.seriousCasualties, 'seriousCasualties', 'seriousCasualtiesUnknown');
  addNullable(metric, record.slightCasualties, 'slightCasualties', 'slightCasualtiesUnknown');
  addNullable(metric, record.ksiCasualties, 'ksiCasualties', 'ksiCasualtiesUnknown');
  if (record.ksiCasualties !== null && record.ksiCasualties > 0) metric.ksiCollisions = 1;
  return metric;
};

export const addMetrics = (target: MetricWithKsi, source: Partial<MetricWithKsi>): void => {
  for (const key of Object.keys(EMPTY_METRIC) as Array<keyof MetricWithKsi>) target[key] = Number(target[key]) + Number(source[key] ?? 0);
};

const nullableAggregate = (sum: number, unknownRecords: number, collisions: number): number | null =>
  collisions > 0 && unknownRecords >= collisions ? null : collisions === 0 ? 0 : sum;

export const summaryFromMetric = (metric: Partial<MetricWithKsi>, years: number[] = []): SummaryMetrics => {
  const value = (key: keyof MetricWithKsi): number => Number(metric[key] ?? 0);
  const collisions = value('collisions');
  const casualtiesUnknown = value('casualtyCountUnknown');
  const fatalitiesUnknown = value('fatalitiesUnknown');
  const seriousUnknown = value('seriousCasualtiesUnknown');
  const slightUnknown = value('slightCasualtiesUnknown');
  const ksiUnknown = value('ksiCasualtiesUnknown');
  return {
    collisions,
    collisionSeverity: {
      fatal: value('fatalCollisions'),
      serious: value('seriousCollisions'),
      slight: value('slightCollisions'),
      unknown: value('unknownSeverity'),
    },
    casualties: {
      total: { value: nullableAggregate(value('casualtyCount'), casualtiesUnknown, collisions), unknownRecords: casualtiesUnknown },
      fatalities: { value: nullableAggregate(value('fatalities'), fatalitiesUnknown, collisions), unknownRecords: fatalitiesUnknown },
      serious: { value: nullableAggregate(value('seriousCasualties'), seriousUnknown, collisions), unknownRecords: seriousUnknown },
      slight: { value: nullableAggregate(value('slightCasualties'), slightUnknown, collisions), unknownRecords: slightUnknown },
      ksi: { value: nullableAggregate(value('ksiCasualties'), ksiUnknown, collisions), unknownRecords: ksiUnknown },
    },
    ksiCollisions: value('ksiCollisions'),
    yearsRepresented: [...new Set(years)].sort((left, right) => left - right),
    complete: true,
  };
};

const parseInvolvement = (value: string): boolean | null => value === 'y' ? true : value === 'n' ? false : null;

export const parseFacetDimensions = (key: string): StaticFacetDimensions | null => {
  const [year, country, authorityCode, severity, pedestrian, cycle, motorcycle] = key.split('|');
  if (!year || (country !== 'England' && country !== 'Wales') || !authorityCode || !severity || pedestrian === undefined || cycle === undefined || motorcycle === undefined) return null;
  if (!['fatal', 'serious', 'slight', 'unknown'].includes(severity)) return null;
  const parsedYear = Number(year);
  if (!Number.isInteger(parsedYear)) return null;
  return {
    year: parsedYear,
    country,
    authorityCode,
    severity: severity as StaticFacetDimensions['severity'],
    pedestrian: parseInvolvement(pedestrian),
    cycle: parseInvolvement(cycle),
    motorcycle: parseInvolvement(motorcycle),
  };
};

const matchInvolvement = (value: boolean | null, filter: QueryFilters['pedestrian']): boolean =>
  filter === 'all' || (filter === 'yes' ? value === true : filter === 'no' ? value === false : value === null);

export const matchesFacet = (dimensions: StaticFacetDimensions, filters: QueryFilters): boolean =>
  (!filters.years.length || filters.years.includes(dimensions.year)) &&
  (!filters.country || filters.country === dimensions.country) &&
  (!filters.authorities.length || filters.authorities.includes(dimensions.authorityCode)) &&
  (!filters.severities.length || filters.severities.includes(dimensions.severity)) &&
  matchInvolvement(dimensions.pedestrian, filters.pedestrian) &&
  matchInvolvement(dimensions.cycle, filters.cycle) &&
  matchInvolvement(dimensions.motorcycle, filters.motorcycle);

export const matchesRecord = (record: StaticCollisionRecord, filters: QueryFilters): boolean =>
  (!filters.years.length || (record.year !== null && filters.years.includes(record.year))) &&
  (!filters.country || record.country === filters.country) &&
  (!filters.authorities.length || (record.authorityCode !== null && filters.authorities.includes(record.authorityCode))) &&
  (!filters.severities.length || filters.severities.includes(record.severity)) &&
  matchInvolvement(record.pedestrianInvolved, filters.pedestrian) &&
  matchInvolvement(record.cycleInvolved, filters.cycle) &&
  matchInvolvement(record.motorcycleInvolved, filters.motorcycle);

export const matchesBBox = (record: Pick<StaticCollisionRecord, 'latitude' | 'longitude'>, bbox: BBox): boolean => {
  if (record.latitude < bbox.south || record.latitude > bbox.north) return false;
  if (bbox.world === true || Math.abs(bbox.east - bbox.west) >= 360) return true;
  return bbox.west <= bbox.east
    ? record.longitude >= bbox.west && record.longitude <= bbox.east
    : record.longitude >= bbox.west || record.longitude <= bbox.east;
};

const longitudeSegments = (bbox: BBox): Array<{ west: number; east: number }> =>
  bbox.world === true || Math.abs(bbox.east - bbox.west) >= 360
    ? [{ west: -180, east: 180 }]
    : bbox.west <= bbox.east
    ? [{ west: bbox.west, east: bbox.east }]
    : [{ west: bbox.west, east: 180 }, { west: -180, east: bbox.east }];

const cellIntersectsSegment = (cell: StaticCellOverview, segment: { west: number; east: number }, bbox: BBox): boolean =>
  cell.bounds.east >= segment.west && cell.bounds.west <= segment.east &&
  cell.bounds.north >= bbox.south && cell.bounds.south <= bbox.north;

const cellContainedBySegment = (cell: StaticCellOverview, segment: { west: number; east: number }, bbox: BBox): boolean =>
  cell.bounds.west >= segment.west && cell.bounds.east <= segment.east &&
  cell.bounds.south >= bbox.south && cell.bounds.north <= bbox.north;

/** Classify cells before loading data so exact viewport requests only fetch edge tiles. */
export const selectCells = (overview: StaticOverview, bbox?: BBox): CellSelection => {
  const cells = Object.values(overview.cells);
  if (!bbox) return { contained: cells, boundary: [] };
  const segments = longitudeSegments(bbox);
  const contained: StaticCellOverview[] = [];
  const boundary: StaticCellOverview[] = [];
  cells.forEach((cell) => {
    const matching = segments.filter((segment) => cellIntersectsSegment(cell, segment, bbox));
    if (!matching.length) return;
    if (matching.some((segment) => cellContainedBySegment(cell, segment, bbox))) contained.push(cell);
    else boundary.push(cell);
  });
  return { contained, boundary };
};

export const summarizeFacets = (cells: StaticCellOverview[], filters: QueryFilters): SummaryMetrics => {
  const metric = cloneMetric();
  const years: number[] = [];
  cells.forEach((cell) => Object.entries(cell.facets).forEach(([key, value]) => {
    const dimensions = parseFacetDimensions(key);
    if (!dimensions || !matchesFacet(dimensions, filters)) return;
    addMetrics(metric, value.additiveSummaryMetrics as MetricWithKsi);
    years.push(dimensions.year);
  }));
  return summaryFromMetric(metric, years);
};

export const summarizeRecords = (records: StaticCollisionRecord[], filters: QueryFilters, bbox?: BBox): SummaryMetrics => {
  const metric = cloneMetric();
  const years: number[] = [];
  records.forEach((record) => {
    if (!matchesRecord(record, filters) || (bbox && !matchesBBox(record, bbox))) return;
    addMetrics(metric, metricForRecord(record));
    if (record.year !== null) years.push(record.year);
  });
  return summaryFromMetric(metric, years);
};

export const mergeSummaryMetrics = (left: SummaryMetrics, right: SummaryMetrics): SummaryMetrics => {
  const metric = cloneMetric();
  metric.collisions = left.collisions + right.collisions;
  metric.fatalCollisions = left.collisionSeverity.fatal + right.collisionSeverity.fatal;
  metric.seriousCollisions = left.collisionSeverity.serious + right.collisionSeverity.serious;
  metric.slightCollisions = left.collisionSeverity.slight + right.collisionSeverity.slight;
  metric.unknownSeverity = left.collisionSeverity.unknown + right.collisionSeverity.unknown;
  const mergeNullable = (leftValue: { value: number | null; unknownRecords: number }, rightValue: { value: number | null; unknownRecords: number }, valueKey: keyof MetricWithKsi, unknownKey: keyof MetricWithKsi) => {
    metric[valueKey] = (leftValue.value ?? 0) + (rightValue.value ?? 0);
    metric[unknownKey] = leftValue.unknownRecords + rightValue.unknownRecords;
  };
  mergeNullable(left.casualties.total, right.casualties.total, 'casualtyCount', 'casualtyCountUnknown');
  mergeNullable(left.casualties.fatalities, right.casualties.fatalities, 'fatalities', 'fatalitiesUnknown');
  mergeNullable(left.casualties.serious, right.casualties.serious, 'seriousCasualties', 'seriousCasualtiesUnknown');
  mergeNullable(left.casualties.slight, right.casualties.slight, 'slightCasualties', 'slightCasualtiesUnknown');
  mergeNullable(left.casualties.ksi, right.casualties.ksi, 'ksiCasualties', 'ksiCasualtiesUnknown');
  metric.ksiCollisions = left.ksiCollisions + right.ksiCollisions;
  return summaryFromMetric(metric, [...left.yearsRepresented, ...right.yearsRepresented]);
};

const feature = (record: StaticCollisionRecord): GeoJsonFeature<PointProperties> => ({
  type: 'Feature',
  id: record.id,
  geometry: { type: 'Point', coordinates: [record.longitude, record.latitude] },
  properties: {
    kind: 'collision', id: record.id, year: record.year, severity: record.severity,
    country: record.country, authorityCode: record.authorityCode, authorityName: record.authorityName,
  },
});

const normalizedLongitude = (longitude: number): number => {
  const wrapped = ((longitude + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 && longitude > 0 ? 180 : wrapped;
};

const longitudeWidth = (west: number, east: number): number => east >= west ? east - west : east + 360 - west;

const aggregateFeature = (cell: StaticCellOverview, metric: SummaryMetrics): GeoJsonFeature<AggregateProperties> => {
  const width = longitudeWidth(cell.bounds.west, cell.bounds.east);
  const longitude = normalizedLongitude(cell.bounds.west + width / 2);
  return {
  type: 'Feature',
  id: cell.cellKey,
  geometry: { type: 'Point', coordinates: [longitude, (cell.bounds.south + cell.bounds.north) / 2] },
  properties: {
    kind: 'aggregate', count: metric.collisions, bbox: cell.bounds,
    collisionSeverity: metric.collisionSeverity,
    casualties: metric.casualties.total,
    ksiCollisions: metric.ksiCollisions,
    yearsRepresented: metric.yearsRepresented,
  },
  };
};

interface DynamicAggregateResult {
  features: Array<GeoJsonFeature<AggregateProperties>>;
  degrees: number;
}

/**
 * Aggregate records into bins clipped to the requested viewport. Boundary
 * tiles can be much larger than a viewport, so using their source-cell
 * midpoint would place a rendered feature outside the map. The grid starts
 * fine enough for the viewport and is widened until the feature cap is met.
 */
const dynamicAggregateRecords = (
  records: StaticCollisionRecord[],
  bbox: BBox,
  cellSizeDegrees: number,
  maxFeatures: number,
  filters: QueryFilters,
): DynamicAggregateResult => {
  if (!records.length) return { features: [], degrees: Math.max(0.01, Math.min(cellSizeDegrees, 0.01)) };
  const width = bbox.world === true ? 360 : longitudeWidth(bbox.west, bbox.east);
  const height = Math.max(0, bbox.north - bbox.south);
  const span = Math.max(width, height);
  // Keep shrinking with the viewport. A 0.01° floor makes a dense tiny
  // viewport impossible to drill into even when its records are distinct.
  // Number.EPSILON is only a guard for a zero-width numeric grid; coincident
  // records still collapse into one bucket naturally.
  let degrees = Math.max(Number.EPSILON, Math.min(cellSizeDegrees, span / 8 || cellSizeDegrees / 8));
  let groups = new Map<string, { x: number; y: number; records: StaticCollisionRecord[] }>();
  const unwrapLongitude = (longitude: number): number => {
    let unwrapped = longitude;
    while (unwrapped < bbox.west) unwrapped += 360;
    while (unwrapped > bbox.west + width) unwrapped -= 360;
    return unwrapped;
  };
  const groupRecords = (): void => {
    groups = new Map();
    const xCount = Math.max(1, Math.ceil(width / degrees));
    const yCount = Math.max(1, Math.ceil(height / degrees));
    records.forEach((record) => {
      const x = Math.min(xCount - 1, Math.max(0, Math.floor((unwrapLongitude(record.longitude) - bbox.west) / degrees)));
      const y = Math.min(yCount - 1, Math.max(0, Math.floor((record.latitude - bbox.south) / degrees)));
      const key = `${x}:${y}`;
      const bucket = groups.get(key) ?? { x, y, records: [] };
      bucket.records.push(record);
      groups.set(key, bucket);
    });
  };
  groupRecords();
  for (let attempt = 0; groups.size > maxFeatures && attempt < 16; attempt += 1) {
    degrees = Math.min(180, degrees * 2);
    groupRecords();
    if (degrees >= 180) break;
  }
  const features: Array<GeoJsonFeature<AggregateProperties>> = [];
  for (const bucket of groups.values()) {
    const westUnwrapped = bbox.west + bucket.x * degrees;
    const eastUnwrapped = Math.min(bbox.west + width, westUnwrapped + degrees);
    const bounds: BBox = {
      west: normalizedLongitude(westUnwrapped),
      east: normalizedLongitude(eastUnwrapped),
      south: bbox.south + bucket.y * degrees,
      north: Math.min(bbox.north, bbox.south + (bucket.y + 1) * degrees),
    };
    features.push(aggregateFeature({ cellKey: `dynamic-${degrees}-${bucket.x}-${bucket.y}`, bounds, recordCount: bucket.records.length, facets: {} }, summarizeRecords(bucket.records, filters)));
  }
  return { features, degrees };
};

const emptyAggregateProperties = (): AggregateProperties => ({
  kind: 'aggregate',
  count: 0,
  bbox: { west: 0, south: 0, east: 0, north: 0 },
  collisionSeverity: { fatal: 0, serious: 0, slight: 0, unknown: 0 },
  casualties: { value: 0, unknownRecords: 0 },
  ksiCollisions: 0,
  yearsRepresented: [],
});

const mergeAggregateProperties = (target: AggregateProperties, source: AggregateProperties): void => {
  target.count += source.count;
  target.collisionSeverity.fatal += source.collisionSeverity.fatal;
  target.collisionSeverity.serious += source.collisionSeverity.serious;
  target.collisionSeverity.slight += source.collisionSeverity.slight;
  target.collisionSeverity.unknown += source.collisionSeverity.unknown;
  const mergeNullable = (left: { value: number | null; unknownRecords: number }, right: { value: number | null; unknownRecords: number }) => {
    const unknownRecords = left.unknownRecords + right.unknownRecords;
    const value = (left.value ?? 0) + (right.value ?? 0);
    return { value: unknownRecords >= target.count ? null : value, unknownRecords };
  };
  target.casualties = mergeNullable(target.casualties, source.casualties);
  target.ksiCollisions += source.ksiCollisions;
  target.yearsRepresented = [...new Set([...target.yearsRepresented, ...source.yearsRepresented])].sort((left, right) => left - right);
};

const aggregateFeatureWithProperties = (cellKey: string, bounds: BBox, properties: AggregateProperties): GeoJsonFeature<AggregateProperties> => {
  const width = longitudeWidth(bounds.west, bounds.east);
  return {
    type: 'Feature',
    id: cellKey,
    geometry: { type: 'Point', coordinates: [normalizedLongitude(bounds.west + width / 2), (bounds.south + bounds.north) / 2] },
    properties: { ...properties, bbox: bounds },
  };
};

interface CoarsenedAggregateResult {
  features: Array<GeoJsonFeature<AggregateProperties>>;
  degrees: number;
}

/** Merge every display aggregate together until the feature cap is met. */
const coarsenAggregateFeatures = (
  features: Array<GeoJsonFeature<AggregateProperties>>,
  bbox: BBox,
  cellSizeDegrees: number,
  maxFeatures: number,
): CoarsenedAggregateResult => {
  if (features.length <= maxFeatures) return { features, degrees: cellSizeDegrees };
  const width = bbox.world === true ? 360 : longitudeWidth(bbox.west, bbox.east);
  const height = Math.max(0, bbox.north - bbox.south);
  const span = Math.max(width, height);
  let degrees = Math.max(cellSizeDegrees, Math.min(360, span / 8 || cellSizeDegrees));
  const unwrapLongitude = (longitude: number): number => {
    let unwrapped = longitude;
    while (unwrapped < bbox.west) unwrapped += 360;
    while (unwrapped > bbox.west + width) unwrapped -= 360;
    return unwrapped;
  };
  let groups = new Map<string, { x: number; y: number; features: Array<GeoJsonFeature<AggregateProperties>> }>();
  const groupFeatures = (): void => {
    groups = new Map();
    const xCount = Math.max(1, Math.ceil(width / degrees));
    const yCount = Math.max(1, Math.ceil(height / degrees));
    features.forEach((feature) => {
      const x = Math.min(xCount - 1, Math.max(0, Math.floor((unwrapLongitude(feature.geometry.coordinates[0]) - bbox.west) / degrees)));
      const y = Math.min(yCount - 1, Math.max(0, Math.floor((feature.geometry.coordinates[1] - bbox.south) / degrees)));
      const key = `${x}:${y}`;
      const group = groups.get(key) ?? { x, y, features: [] };
      group.features.push(feature);
      groups.set(key, group);
    });
  };
  groupFeatures();
  for (let attempt = 0; groups.size > maxFeatures && attempt < 16; attempt += 1) {
    degrees = Math.min(360, degrees * 2);
    groupFeatures();
    if (degrees >= 360) break;
  }
  if (groups.size > maxFeatures) {
    // This only applies to an unusually small caller supplied cap (for
    // example maxFeatures=1). One viewport-wide aggregate is still exact.
    groups = new Map([['all', { x: 0, y: 0, features }]]);
    degrees = 360;
  }
  const result: Array<GeoJsonFeature<AggregateProperties>> = [];
  for (const group of groups.values()) {
    const bounds: BBox = degrees >= 360
      ? { west: bbox.world === true ? -180 : bbox.west, south: bbox.south, east: bbox.world === true ? 180 : bbox.east, north: bbox.north }
      : {
        west: normalizedLongitude(bbox.west + group.x * degrees),
        east: normalizedLongitude(Math.min(bbox.west + width, bbox.west + (group.x + 1) * degrees)),
        south: bbox.south + group.y * degrees,
        north: Math.min(bbox.north, bbox.south + (group.y + 1) * degrees),
      };
    const properties = emptyAggregateProperties();
    for (const feature of group.features) mergeAggregateProperties(properties, feature.properties);
    result.push(aggregateFeatureWithProperties(`coarse-${degrees}-${group.x}-${group.y}`, bounds, properties));
  }
  return { features: result, degrees };
};

export const buildView = (input: FilteredViewInput): ViewPayload => {
  const maxFeatures = Math.max(1, input.maxFeatures ?? 2_000);
  const selection = selectCells(input.overview, input.bbox);
  const containedSummary = summarizeFacets(selection.contained, input.filters);
  const containedKeys = new Set(selection.contained.map((cell) => cell.cellKey));
  const edgeRecords = input.records.filter((record) =>
    matchesRecord(record, input.filters) &&
    (!input.bbox || matchesBBox(record, input.bbox)) &&
    !containedKeys.has(staticCellKey(record.longitude, record.latitude)));
  const edgeSummary = summarizeRecords(edgeRecords, input.filters);
  const summary = mergeSummaryMetrics(containedSummary, edgeSummary);
  const allRecords = (input.pointRecords ?? edgeRecords).filter((record) => matchesRecord(record, input.filters) && (!input.bbox || matchesBBox(record, input.bbox)));
  const zoom = Math.round(input.zoom ?? 8);
  const cellMetrics = selection.contained.map((cell) => ({ cell, metrics: summarizeFacets([cell], input.filters) })).filter(({ metrics }) => metrics.collisions > 0);
  const pointDataComplete = allRecords.length === summary.collisions;
  if (summary.collisions <= maxFeatures && pointDataComplete) {
    const features = allRecords.map(feature);
    return {
      mode: 'points', features: { type: 'FeatureCollection', features }, recordCount: summary.collisions,
      featureCount: features.length, complete: true, bounds: input.bbox ?? input.overview.cells[Object.keys(input.overview.cells)[0]]?.bounds ?? { west: -180, south: -90, east: 180, north: 90 },
      filters: input.filters, zoom,
    };
  }
  const refinedRecords = input.refineRecords?.filter((record) => matchesRecord(record, input.filters) && (!input.bbox || matchesBBox(record, input.bbox)));
  if (input.bbox && refinedRecords && refinedRecords.length === summary.collisions) {
    const refined = dynamicAggregateRecords(refinedRecords, input.bbox, input.overview.cellSizeDegrees, maxFeatures, input.filters);
    return {
      mode: 'aggregates', features: { type: 'FeatureCollection', features: refined.features },
      recordCount: summary.collisions, featureCount: refined.features.length, complete: true,
      aggregateCellDegrees: refined.degrees, bounds: input.bbox, filters: input.filters, zoom,
    };
  }
  const features = cellMetrics.map(({ cell, metrics }) => aggregateFeature(cell, metrics));
  let aggregateCellDegrees: number = input.overview.cellSizeDegrees;
  if (edgeRecords.length && input.bbox) {
    const edge = dynamicAggregateRecords(edgeRecords, input.bbox, input.overview.cellSizeDegrees, maxFeatures, input.filters);
    features.push(...edge.features);
    aggregateCellDegrees = edge.degrees;
  } else if (edgeRecords.length) {
    const edgeByCell = new Map<string, StaticCollisionRecord[]>();
    edgeRecords.forEach((record) => {
      const key = staticCellKey(record.longitude, record.latitude);
      const list = edgeByCell.get(key) ?? [];
      list.push(record);
      edgeByCell.set(key, list);
    });
    for (const [cellKey, records] of edgeByCell) {
      const cell = input.overview.cells[cellKey];
      if (cell) features.push(aggregateFeature(cell, summarizeRecords(records, input.filters)));
    }
  }
  const viewBounds = input.bbox ?? { west: -180, south: -90, east: 180, north: 90, world: true };
  if (features.length > maxFeatures) {
    const coarsened = coarsenAggregateFeatures(features, viewBounds, input.overview.cellSizeDegrees, maxFeatures);
    features.splice(0, features.length, ...coarsened.features);
    aggregateCellDegrees = coarsened.degrees;
  }
  return {
    mode: 'aggregates', features: { type: 'FeatureCollection', features }, recordCount: summary.collisions,
    featureCount: features.length, complete: true, aggregateCellDegrees,
    bounds: input.bbox ?? input.overview.cells[Object.keys(input.overview.cells)[0]]?.bounds ?? { west: -180, south: -90, east: 180, north: 90 },
    filters: input.filters, zoom,
  };
};

const toCollisionRecord = (record: StaticCollisionRecord): CollisionRecord => ({
  id: record.id, date: record.date, year: record.year, latitude: record.latitude, longitude: record.longitude,
  severity: record.severity, localAuthority: record.authorityName, roadName: record.roadName, roadNumber: record.roadNumber,
  speedLimit: record.speedLimit, junctionDetail: record.junctionDetail, casualtyCount: record.casualtyCount,
  fatalities: record.fatalities, seriousCasualties: record.seriousCasualties, ksiCasualties: record.ksiCasualties,
  pedestrianInvolved: record.pedestrianInvolved, cycleInvolved: record.cycleInvolved, motorcycleInvolved: record.motorcycleInvolved,
  sourceProperties: {},
});

const distanceMetres = (left: { latitude: number; longitude: number }, right: { latitude: number; longitude: number }): number => {
  const earth = 6_371_008.8;
  const lat1 = left.latitude * Math.PI / 180;
  const lat2 = right.latitude * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLon = (right.longitude - left.longitude) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earth * Math.asin(Math.sqrt(a));
};

const nearestSchool = (group: { latitude: number; longitude: number }, schools: StaticSchoolRecord[]): { school: SchoolRecord; distanceMetres: number } | null => {
  let nearest: { school: StaticSchoolRecord; distanceMetres: number } | null = null;
  for (const school of schools) {
    const distance = distanceMetres(group, { latitude: school.lat, longitude: school.lon });
    if (distance > 1_000 || (nearest && distance >= nearest.distanceMetres)) continue;
    nearest = { school, distanceMetres: Math.round(distance * 10) / 10 };
  }
  if (!nearest) return null;
  return { school: { id: nearest.school.id, name: nearest.school.name, country: nearest.school.country, latitude: nearest.school.lat, longitude: nearest.school.lon, status: nearest.school.status, phase: nearest.school.phase }, distanceMetres: nearest.distanceMetres };
};

const groupHarm = (members: StaticCollisionRecord[]): AnalysisGroup['harm'] => {
  const summary = summarizeRecords(members, { years: [], authorities: [], severities: [], pedestrian: 'all', cycle: 'all', motorcycle: 'all' });
  return { collisionSeverity: summary.collisionSeverity, casualties: summary.casualties, ksiCollisions: summary.ksiCollisions, ksiCollisionYears: [...new Set(members.filter((record) => record.ksiCasualties !== null && record.ksiCasualties > 0 && record.year !== null).map((record) => record.year as number))].sort((left, right) => left - right) };
};

const applyHarm = (group: AnalysisGroup, harm: AnalysisHarmFilter): boolean => {
  if (harm === 'all') return true;
  if (harm === 'ksi') return group.harm.ksiCollisions > 0;
  if (harm === 'repeated-ksi') return group.harm.ksiCollisions > 1;
  return group.harm.casualties.slight.unknownRecords === 0 &&
    group.harm.casualties.ksi.unknownRecords === 0 &&
    (group.harm.casualties.slight.value ?? 0) > 0 &&
    group.harm.casualties.ksi.value === 0;
};

const EARTH_RADIUS_METRES = 6_371_008.8;

const expandedBBox = (bbox: BBox, metres: number): BBox => {
  const degreesPerMetre = 180 / (Math.PI * EARTH_RADIUS_METRES);
  const latitudeDelta = metres * degreesPerMetre;
  const maximumLatitude = Math.min(89.9, Math.max(Math.abs(bbox.south), Math.abs(bbox.north), Math.abs((bbox.south + bbox.north) / 2)));
  const longitudeDelta = metres * degreesPerMetre / Math.max(Math.cos((maximumLatitude * Math.PI) / 180), 0.01);
  const width = bbox.world === true ? 360 : bbox.east >= bbox.west ? bbox.east - bbox.west : bbox.east + 360 - bbox.west;
  const south = Math.max(-90, bbox.south - latitudeDelta);
  const north = Math.min(90, bbox.north + latitudeDelta);
  if (bbox.world === true || width + (2 * longitudeDelta) >= 360) return { west: -180, south, east: 180, north, world: true };
  const normalize = (longitude: number): number => ((longitude + 180) % 360 + 360) % 360 - 180;
  return { west: normalize(bbox.west - longitudeDelta), south, east: normalize(bbox.east + longitudeDelta), north };
};

const edgeWarningFor = (groups: AnalysisGroup[], bbox: BBox, radiusMetres: number): boolean => {
  const degreesPerMetre = 180 / (Math.PI * EARTH_RADIUS_METRES);
  const margin = radiusMetres * degreesPerMetre;
  return groups.some((group) => {
    const latitudeNearEdge = group.anchor.latitude <= bbox.south + margin || group.anchor.latitude >= bbox.north - margin;
    if (latitudeNearEdge || bbox.world === true) return latitudeNearEdge;
    const longitudeMargin = radiusMetres * degreesPerMetre / Math.max(Math.cos((group.anchor.latitude * Math.PI) / 180), 0.01);
    return bbox.east >= bbox.west
      ? group.anchor.longitude <= bbox.west + longitudeMargin || group.anchor.longitude >= bbox.east - longitudeMargin
      : (group.anchor.longitude >= bbox.west && group.anchor.longitude <= bbox.west + longitudeMargin) || (group.anchor.longitude <= bbox.east && group.anchor.longitude >= bbox.east - longitudeMargin);
  });
};

export const buildAnalysis = (input: AnalysisInput): AnalysisPayload => {
  const filtered = input.records.filter((record) => matchesRecord(record, input.filters) && matchesBBox(record, input.bbox));
  if (filtered.length > 10_000) throw new Error('Persistent-location analysis is limited to 10,000 matching records.');
  const locations = groupPersistentLocations(filtered.map(toCollisionRecord), input.radiusMetres, 3, 2);
  const byId = new Map(filtered.map((record) => [record.id, record]));
  const candidates = input.schools.filter((school) => matchesBBox({ latitude: school.lat, longitude: school.lon }, expandedBBox(input.bbox, 1_000)));
  const selectedSchool = input.selectedSchoolId ? input.schools.find((school) => school.id === input.selectedSchoolId) : undefined;
  if (selectedSchool && !candidates.some((school) => school.id === selectedSchool.id)) candidates.push(selectedSchool);
  const baseGroups: AnalysisGroup[] = [];
  for (const location of locations) {
    const members = location.memberIds.map((id) => byId.get(id)).filter((record): record is StaticCollisionRecord => Boolean(record));
    const harm = groupHarm(members);
    const nearest = nearestSchool({ latitude: location.latitude, longitude: location.longitude }, candidates);
    const nearby = candidates.filter((school) => distanceMetres({ latitude: location.latitude, longitude: location.longitude }, { latitude: school.lat, longitude: school.lon }) <= 1_000);
    const selectedDistance = input.schoolDistanceMetres ?? (input.selectedSchoolId ? 500 : undefined);
    const selectedSchoolMatch = input.selectedSchoolId ? nearby.some((school) => school.id === input.selectedSchoolId && selectedDistance !== undefined && distanceMetres({ latitude: location.latitude, longitude: location.longitude }, { latitude: school.lat, longitude: school.lon }) <= selectedDistance) : undefined;
    const schoolProximity = {
      within500m: nearby.some((school) => distanceMetres({ latitude: location.latitude, longitude: location.longitude }, { latitude: school.lat, longitude: school.lon }) <= 500),
      within1km: nearby.length > 0,
      nearestSchool: nearest,
      ...(selectedDistance !== undefined ? { selectedDistanceMetres: selectedDistance, selectedSchoolMatch } : {}),
    };
    baseGroups.push({
      id: location.id,
      anchor: { collisionId: location.id.replace(/^location-/, ''), latitude: location.latitude, longitude: location.longitude },
      collisions: location.collisions,
      yearsRepresented: location.years,
      harm,
      memberIds: location.memberIds,
      schoolProximity,
    });
  }
  const harmGroups = baseGroups.filter((group) => applyHarm(group, input.harmFilter));
  const groups = input.selectedSchoolId
    ? harmGroups.filter((group) => group.schoolProximity.selectedSchoolMatch === true)
    : input.schoolDistanceMetres === 500
      ? harmGroups.filter((group) => group.schoolProximity.within500m)
      : input.schoolDistanceMetres === 1_000
        ? harmGroups.filter((group) => group.schoolProximity.within1km)
        : harmGroups;
  const coverage: SchoolCoverage[] = [500, 1_000].map((distance) => {
    const totalLocations = harmGroups.length;
    const matchingLocations = harmGroups.filter((group) => distance === 500 ? group.schoolProximity.within500m : group.schoolProximity.within1km).length;
    return { distanceMetres: distance as 500 | 1000, matchingLocations, totalLocations, percentage: totalLocations ? Number((matchingLocations / totalLocations * 100).toFixed(2)) : null };
  });
  const provenance: SchoolCoverageProvenance[] = [];
  return {
    scope: { bbox: input.bbox, filters: input.filters, radiusMetres: input.radiusMetres, harmFilter: input.harmFilter, ...(input.selectedSchoolId ? { selectedSchoolId: input.selectedSchoolId } : {}) },
    groups, schoolCoverage: coverage, schoolCoverageProvenance: provenance,
    inputRecords: filtered.length, complete: true, edgeWarning: edgeWarningFor(groups, input.bbox, input.radiusMetres),
    limits: { recordLimit: 10_000, returnedRecords: filtered.length },
  };
};

export const filterSchools = (schools: StaticSchoolRecord[], query: string, bbox?: BBox, offset = 0, limit = 200): StaticSchoolRecord[] => {
  const normalized = query.trim().toLocaleLowerCase('en-GB');
  const filtered = schools.filter((school) => (!normalized || school.name.toLocaleLowerCase('en-GB').includes(normalized) || school.id.toLocaleLowerCase('en-GB').includes(normalized)) && (!bbox || matchesBBox({ latitude: school.lat, longitude: school.lon }, bbox)));
  return filtered.slice(offset, offset + limit);
};

export const staticRecordToDetail = (record: StaticCollisionRecord, evidence: { collision: Record<string, unknown>; casualties: Array<Record<string, unknown>>; vehicles: Array<Record<string, unknown>>; join?: Record<string, unknown> }): CollisionDetail => ({
  ...record,
  evidence,
});
