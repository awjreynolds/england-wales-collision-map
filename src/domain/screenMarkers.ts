/**
 * Screen-space layout for map markers.
 *
 * MapLibre positions circles in pixels after projecting geographic points. A
 * geographic de-duplication pass therefore cannot guarantee a visible gap at
 * every zoom. This module deliberately works only with screen coordinates and
 * keeps the source members on every returned group so a grouped marker can be
 * drilled into without losing records.
 */

export type ScreenMarkerKind = 'collision' | 'aggregate' | 'analysis' | 'school';

export interface ScreenBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface ScreenMarker {
  id: string;
  x: number;
  y: number;
  /** Outer radius in pixels, including the circle stroke. */
  radius: number;
  kind: ScreenMarkerKind;
  /** Weight used for the marker centre. It is never used as a collision count. */
  weight: number;
  /** Reported collision rows represented by this marker, when applicable. */
  collisionCount?: number;
  /** Geographic point used for singleton callbacks and map source geometry. */
  longitude: number;
  latitude: number;
  bounds?: ScreenBounds;
  label?: string;
  severity?: string;
  data?: unknown;
}

export interface ScreenMarkerCounts {
  collision: number;
  aggregate: number;
  analysis: number;
  school: number;
}

export interface ScreenMarkerGroup {
  id: string;
  /** Display centre. It may move a few pixels to maintain the requested gap. */
  x: number;
  y: number;
  /** Weighted centre before the final collision-free separation pass. */
  centroidX: number;
  centroidY: number;
  /** Outer radius in pixels, including the display stroke. */
  radius: number;
  kind: ScreenMarkerKind | 'cluster';
  members: ScreenMarker[];
  totalWeight: number;
  counts: ScreenMarkerCounts;
  collisionCount: number;
  bounds: ScreenBounds;
  label: string;
}

export interface ScreenMarkerLayoutOptions {
  /** Minimum edge gap between every rendered circle. */
  gap?: number;
  /** Maximum outer radius of any rendered marker. */
  maxGroupRadius?: number;
  /** Maximum span of a local group in screen pixels. */
  maxGroupSpan?: number;
  /** Maximum distance from a group's weighted centre for a new member. */
  clusterDistance?: number;
  /** Maximum separation iterations; always followed by a deterministic fallback. */
  maxSeparationPasses?: number;
  /** Maximum screen displacement from a group's weighted centre. */
  maxDisplayDisplacement?: number;
}

const DEFAULTS: Required<ScreenMarkerLayoutOptions> = {
  gap: 6,
  maxGroupRadius: 26,
  maxGroupSpan: 72,
  clusterDistance: 34,
  maxSeparationPasses: 24,
  maxDisplayDisplacement: 8,
};

const finite = (value: number, fallback = 0): number => Number.isFinite(value) ? value : fallback;
const markerWeight = (marker: ScreenMarker): number => Math.max(0, finite(marker.weight, 0));
const markerCollisionCount = (marker: ScreenMarker): number => {
  if (marker.kind === 'collision') return 1;
  if (marker.kind === 'aggregate') return Math.max(0, finite(marker.collisionCount ?? 0, 0));
  return 0;
};

const kindPriority: Record<ScreenMarkerKind, number> = { analysis: 4, aggregate: 3, collision: 2, school: 1 };

const stableMarkerOrder = (a: ScreenMarker, b: ScreenMarker): number => {
  const priority = kindPriority[b.kind] - kindPriority[a.kind];
  if (priority) return priority;
  const weight = markerWeight(b) - markerWeight(a);
  if (weight) return weight;
  return a.id.localeCompare(b.id);
};

const pointBounds = (marker: ScreenMarker): ScreenBounds => marker.bounds ?? { west: marker.longitude, south: marker.latitude, east: marker.longitude, north: marker.latitude };

const boundsFor = (members: ScreenMarker[]): ScreenBounds => members.reduce((bounds, marker) => {
  const point = pointBounds(marker);
  return {
    west: Math.min(bounds.west, point.west),
    south: Math.min(bounds.south, point.south),
    east: Math.max(bounds.east, point.east),
    north: Math.max(bounds.north, point.north),
  };
}, { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity });

const countsFor = (members: ScreenMarker[]): ScreenMarkerCounts => members.reduce((counts, marker) => {
  counts[marker.kind] += 1;
  return counts;
}, { collision: 0, aggregate: 0, analysis: 0, school: 0 });

const groupKind = (members: ScreenMarker[]): ScreenMarkerKind | 'cluster' => {
  if (members.length === 1) return members[0].kind;
  if (members.every((member) => member.kind === 'analysis')) return 'analysis';
  if (members.every((member) => member.kind === 'school')) return 'school';
  if (members.every((member) => member.kind === 'aggregate')) return 'aggregate';
  return 'cluster';
};

const weightedCentre = (members: ScreenMarker[]): { x: number; y: number; weight: number } => {
  const effectiveWeight = (marker: ScreenMarker): number => markerWeight(marker) || 1;
  const weight = members.reduce((total, marker) => total + effectiveWeight(marker), 0) || 1;
  return {
    x: members.reduce((total, marker) => total + marker.x * effectiveWeight(marker), 0) / weight,
    y: members.reduce((total, marker) => total + marker.y * effectiveWeight(marker), 0) / weight,
    weight,
  };
};

const groupRadius = (members: ScreenMarker[], maxGroupRadius: number): number => {
  const maxMemberRadius = Math.max(...members.map((member) => Math.max(1, member.radius)));
  if (members.length === 1) return Math.min(maxGroupRadius, maxMemberRadius);
  const collisionScale = Math.sqrt(Math.max(1, members.reduce((total, marker) => total + markerCollisionCount(marker), 0)));
  return Math.min(maxGroupRadius, Math.max(9, maxMemberRadius, 7 + collisionScale * 1.35));
};

const groupLabel = (members: ScreenMarker[], counts: ScreenMarkerCounts, collisionCount: number): string => {
  if (members.length === 1) return members[0].label ?? '';
  if (collisionCount > 0) return String(collisionCount);
  if (counts.analysis > 0) return `H${counts.analysis}`;
  return `S${counts.school}`;
};

const makeGroup = (members: ScreenMarker[], options: Required<ScreenMarkerLayoutOptions>): ScreenMarkerGroup => {
  const centre = weightedCentre(members);
  const counts = countsFor(members);
  const collisionCount = members.reduce((total, marker) => total + markerCollisionCount(marker), 0);
  const label = groupLabel(members, counts, collisionCount);
  return {
    id: members.length === 1 ? members[0].id : `cluster:${members.map((member) => member.id).sort().join('|')}`,
    x: centre.x,
    y: centre.y,
    centroidX: centre.x,
    centroidY: centre.y,
    radius: Math.min(options.maxGroupRadius, Math.max(groupRadius(members, options.maxGroupRadius), 4 + label.length * 3.5)),
    kind: groupKind(members),
    members,
    totalWeight: centre.weight,
    counts,
    collisionCount,
    bounds: boundsFor(members),
    label,
  };
};

const spanAfter = (group: ScreenMarkerGroup, member: ScreenMarker): number => {
  const xs = [...group.members.map((item) => item.x), member.x];
  const ys = [...group.members.map((item) => item.y), member.y];
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
};

const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Groups nearby markers around a bounded, weighted seed. The seed radius and
 * span limits intentionally prevent a dense national view from becoming one
 * transitive country-sized cluster.
 */
const seedGroups = (markers: ScreenMarker[], options: Required<ScreenMarkerLayoutOptions>): ScreenMarkerGroup[] => {
  const groups: ScreenMarkerGroup[] = [];
  for (const marker of [...markers].sort(stableMarkerOrder)) {
    let best: ScreenMarkerGroup | null = null;
    let bestDistance = Infinity;
    for (const group of groups) {
      const candidateDistance = distance(group, marker);
      if (candidateDistance > options.clusterDistance || spanAfter(group, marker) > options.maxGroupSpan) continue;
      if (candidateDistance < bestDistance || (candidateDistance === bestDistance && group.id < (best?.id ?? '\uffff'))) {
        best = group;
        bestDistance = candidateDistance;
      }
    }
    if (!best) {
      groups.push(makeGroup([marker], options));
      continue;
    }
    const next = makeGroup([...best.members, marker], options);
    const index = groups.indexOf(best);
    groups[index] = next;
  }
  return groups;
};

const cellKey = (x: number, y: number): string => `${Math.floor(x)}:${Math.floor(y)}`;

/** Return candidate pairs without the quadratic all-pairs scan. */
const overlappingPairs = (groups: ScreenMarkerGroup[], gap: number): Array<[number, number]> => {
  const maxRadius = Math.max(1, ...groups.map((group) => group.radius));
  const cellSize = maxRadius * 2 + gap;
  const buckets = new Map<string, number[]>();
  const cells = groups.map((group) => ({ x: Math.floor(group.x / cellSize), y: Math.floor(group.y / cellSize) }));
  groups.forEach((_, index) => {
    const cell = cells[index];
    const key = cellKey(cell.x, cell.y);
    const bucket = buckets.get(key) ?? [];
    bucket.push(index);
    buckets.set(key, bucket);
  });
  const pairs: Array<[number, number]> = [];
  const seen = new Set<string>();
  groups.forEach((group, index) => {
    const cell = cells[index];
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
      const candidates = buckets.get(cellKey(cell.x + dx, cell.y + dy)) ?? [];
      for (const other of candidates) {
        if (other <= index) continue;
        const key = `${index}:${other}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const minimum = group.radius + groups[other].radius + gap;
        if (distance(group, groups[other]) < minimum) pairs.push([index, other]);
      }
    }
  });
  return pairs;
};

const hashAngle = (value: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return ((hash >>> 0) / 0xffffffff) * Math.PI * 2;
};

/**
 * Shift group centres apart while retaining the weighted centroid metadata.
 * Moving a low-weight group more preserves the position of a high-count
 * aggregate without hiding either member set.
 */
const separateGroups = (groups: ScreenMarkerGroup[], options: Required<ScreenMarkerLayoutOptions>): void => {
  for (let pass = 0; pass < options.maxSeparationPasses; pass += 1) {
    const pairs = overlappingPairs(groups, options.gap);
    if (!pairs.length) return;
    for (const [leftIndex, rightIndex] of pairs) {
      const left = groups[leftIndex];
      const right = groups[rightIndex];
      let dx = right.x - left.x;
      let dy = right.y - left.y;
      let length = Math.hypot(dx, dy);
      if (length < 0.0001) {
        const angle = hashAngle(`${left.id}|${right.id}`);
        dx = Math.cos(angle); dy = Math.sin(angle); length = 1;
      }
      const needed = left.radius + right.radius + options.gap - length;
      if (needed <= 0) continue;
      const leftWeight = Math.max(1, left.totalWeight);
      const rightWeight = Math.max(1, right.totalWeight);
      const totalWeight = leftWeight + rightWeight;
      const leftMove = needed * (rightWeight / totalWeight);
      const rightMove = needed * (leftWeight / totalWeight);
      const leftX = left.x - (dx / length) * leftMove;
      const leftY = left.y - (dy / length) * leftMove;
      const rightX = right.x + (dx / length) * rightMove;
      const rightY = right.y + (dy / length) * rightMove;
      const constrain = (group: ScreenMarkerGroup, x: number, y: number): { x: number; y: number } => {
        const offsetX = x - group.centroidX;
        const offsetY = y - group.centroidY;
        const offset = Math.hypot(offsetX, offsetY);
        if (offset <= options.maxDisplayDisplacement || offset < 0.0001) return { x, y };
        const scale = options.maxDisplayDisplacement / offset;
        return { x: group.centroidX + offsetX * scale, y: group.centroidY + offsetY * scale };
      };
      const constrainedLeft = constrain(left, leftX, leftY);
      const constrainedRight = constrain(right, rightX, rightY);
      left.x = constrainedLeft.x; left.y = constrainedLeft.y;
      right.x = constrainedRight.x; right.y = constrainedRight.y;
    }
  }
  // A bounded final fallback makes the invariant explicit even for a highly
  // pathological dense input: merge the remaining overlapping groups. This is
  // reached only after bounded pairwise separation attempts.
  let pairs = overlappingPairs(groups, options.gap);
  while (pairs.length) {
    const [leftIndex, rightIndex] = pairs[0];
    const merged = makeGroup([...groups[leftIndex].members, ...groups[rightIndex].members], options);
    groups.splice(Math.max(leftIndex, rightIndex), 1);
    groups.splice(Math.min(leftIndex, rightIndex), 1, merged);
    pairs = overlappingPairs(groups, options.gap);
  }
};

/**
 * Lay out markers with a guaranteed minimum edge gap.
 *
 * The returned groups retain every input marker exactly once. Callers can use
 * `members.length === 1` to preserve ordinary singleton click behaviour and
 * `bounds` to zoom a grouped marker into its complete geographic extent.
 */
export const layoutScreenMarkers = (markers: ScreenMarker[], providedOptions: ScreenMarkerLayoutOptions = {}): ScreenMarkerGroup[] => {
  const options = { ...DEFAULTS, ...providedOptions };
  if (!markers.length) return [];
  const groups = seedGroups(markers, options);
  separateGroups(groups, options);
  return groups.sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
};

export const screenMarkerGap = (left: Pick<ScreenMarkerGroup, 'x' | 'y' | 'radius'>, right: Pick<ScreenMarkerGroup, 'x' | 'y' | 'radius'>): number => distance(left, right) - left.radius - right.radius;
