import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DATA_PATH = resolve('public/data/collisions.geojson');
const PROVENANCE_PATH = resolve('public/data/provenance.json');
const YEARS = new Set([2021, 2022, 2023, 2024, 2025]);
const AUTHORITIES = new Set(['Bristol', 'Bath and North East Somerset', 'South Gloucestershire', 'North Somerset']);

const number = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
};

const main = async (): Promise<void> => {
  const geojson = JSON.parse(await readFile(DATA_PATH, 'utf8')) as {
    type?: unknown;
    features?: Array<{ id?: unknown; geometry?: { type?: unknown; coordinates?: unknown }; properties?: Record<string, unknown> }>;
  };
  const provenance = JSON.parse(await readFile(PROVENANCE_PATH, 'utf8')) as { validation?: Record<string, unknown>; includedYears?: unknown };
  if (geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features) || geojson.features.length === 0) {
    throw new Error('Generated collision data is not a non-empty FeatureCollection.');
  }
  const ids = new Set<string>();
  for (const [index, feature] of geojson.features.entries()) {
    const id = typeof feature.id === 'string' ? feature.id : null;
    if (!id || ids.has(id)) throw new Error(`Missing or duplicate collision id at feature ${index}.`);
    ids.add(id);
    if (feature.geometry?.type !== 'Point' || !Array.isArray(feature.geometry.coordinates) || feature.geometry.coordinates.length !== 2) {
      throw new Error(`Invalid point geometry at feature ${index}.`);
    }
    const longitude = number(feature.geometry.coordinates[0]);
    const latitude = number(feature.geometry.coordinates[1]);
    if (longitude === null || latitude === null || longitude < -9 || longitude > 3 || latitude < 49 || latitude > 61) {
      throw new Error(`Out-of-range coordinate at feature ${index}.`);
    }
    const properties = feature.properties ?? {};
    if (typeof properties.year !== 'number' || !YEARS.has(properties.year)) throw new Error(`Unexpected year at feature ${index}.`);
    if (typeof properties.localAuthority !== 'string' || !AUTHORITIES.has(properties.localAuthority)) throw new Error(`Unexpected authority at feature ${index}.`);
    if (!['fatal', 'serious', 'slight', 'unknown'].includes(String(properties.severity))) throw new Error(`Unexpected severity at feature ${index}.`);
    for (const field of ['pedestrianInvolved', 'cycleInvolved', 'motorcycleInvolved']) {
      if (properties[field] !== true && properties[field] !== false && properties[field] !== null) throw new Error(`Invalid nullable involvement at ${field}/${index}.`);
    }
  }
  const validation = provenance.validation ?? {};
  if (validation.outputCollisionFeatures !== geojson.features.length) throw new Error('Provenance feature count does not match GeoJSON.');
  if (JSON.stringify(provenance.includedYears) !== JSON.stringify([2021, 2022, 2023, 2024, 2025])) throw new Error('Provenance year range is not 2021–2025.');
  console.log(`Validated ${geojson.features.length.toLocaleString()} collision features, ${ids.size.toLocaleString()} unique IDs.`);
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
