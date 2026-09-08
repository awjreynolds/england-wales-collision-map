/** Parse the shareable map zoom while keeping an absent parameter distinct from zero. */
export const parseZoomParam = (value: string | null): number | undefined => {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 22 ? parsed : undefined;
};

/** Keep a failed school page retryable instead of advancing past it. */
export const retryableSchoolOffset = (requestedOffset: number, failedOffset: number | null): number => failedOffset !== null && requestedOffset > failedOffset ? failedOffset : requestedOffset;
