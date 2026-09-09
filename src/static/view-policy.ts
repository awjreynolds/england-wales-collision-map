import type { BBox } from '../../service/contract';

/** Default aggregate and low-zoom view feature limit. */
export const DEFAULT_VIEW_FEATURE_LIMIT = 2_000;
/** Maximum number of complete records that a bounded high-zoom point view may load. */
export const MAX_POINT_VIEW_RECORDS = 50_000;
/** Fractional zoom values at or above this threshold may request point records. */
export const HIGH_ZOOM_POINT_THRESHOLD = 11;
/** Static worker view metadata budget for the largest point response. */
export const STATIC_VIEW_RESPONSE_BYTES = 50_000_000;

export interface ViewPolicyInput {
  bbox?: BBox;
  zoom?: number;
  /** Test-only/explicit caller override for both point and aggregate limits. */
  maxFeatures?: number;
}

const explicitLimit = (value: number): number => Math.max(1, Math.floor(value));

/**
 * Return the point-record limit for the request as written. The zoom is kept
 * fractional: 10.99 must remain below the threshold rather than rounding up.
 */
export const pointRecordLimit = (input: ViewPolicyInput): number => {
  if (input.maxFeatures !== undefined) return explicitLimit(input.maxFeatures);
  if (input.bbox && Number.isFinite(input.zoom) && (input.zoom as number) >= HIGH_ZOOM_POINT_THRESHOLD) return MAX_POINT_VIEW_RECORDS;
  return DEFAULT_VIEW_FEATURE_LIMIT;
};

export const aggregateFeatureLimit = (maxFeatures?: number): number =>
  maxFeatures === undefined ? DEFAULT_VIEW_FEATURE_LIMIT : explicitLimit(maxFeatures);

export const canReturnPointRecords = (recordCount: number, input: ViewPolicyInput): boolean =>
  Number.isFinite(recordCount) && recordCount <= pointRecordLimit(input);
