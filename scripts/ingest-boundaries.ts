import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

declare const process: {
  argv: string[];
  exitCode?: number;
};

const FEATURE_SERVER_URL =
  'https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Local_Authority_Districts_December_2024_Boundaries_UK_BGC/FeatureServer';
const DATASET_URL =
  'https://www.data.gov.uk/dataset/af158609-c1ec-40a6-a8ee-0b0feb698463/local-authority-districts-december-2024-boundaries-uk-bgc';
const LICENCE_URL = 'https://www.ons.gov.uk/methodology/geography/geographicalproducts/digitalboundaries';

export const AUTHORITY_BOUNDARIES = [
  { code: 'E06000022', name: 'Bath and North East Somerset' },
  { code: 'E06000023', name: 'Bristol, City of' },
  { code: 'E06000024', name: 'North Somerset' },
  { code: 'E06000025', name: 'South Gloucestershire' },
] as const;

type JsonRecord = Record<string, unknown>;

interface BoundaryGeometry {
  type: 'Polygon' | 'MultiPolygon';
  coordinates: unknown;
}

interface BoundaryFeature {
  type: 'Feature';
  id: string;
  properties: {
    LAD24CD: string;
    LAD24NM: string;
  };
  geometry: BoundaryGeometry;
}

interface BoundaryCollection {
  type: 'FeatureCollection';
  features: BoundaryFeature[];
}

const asRecord = (value: unknown): JsonRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Boundary response is not a JSON object');
  return value as JsonRecord;
};

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

const isFiniteCoordinateTree = (value: unknown): boolean => {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (typeof value[0] === 'number') {
    const longitude = value[0];
    const latitude = value[1];
    return typeof latitude === 'number' && Number.isFinite(longitude) && Number.isFinite(latitude) &&
      longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90;
  }
  return value.every(isFiniteCoordinateTree);
};

const sourceCrs = (value: unknown): string | null => {
  const root = asRecord(value);
  const crs = root.crs;
  if (!crs || typeof crs !== 'object' || Array.isArray(crs)) return null;
  const properties = (crs as JsonRecord).properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null;
  return text((properties as JsonRecord).name);
};

const queryUrl = (): string => {
  const url = new URL(`${FEATURE_SERVER_URL}/0/query`);
  url.search = new URLSearchParams({
    where: `LAD24CD IN (${AUTHORITY_BOUNDARIES.map(({ code }) => `'${code}'`).join(',')})`,
    outFields: 'LAD24CD,LAD24NM',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
  }).toString();
  return url.href;
};

const validateAndNormalise = (value: unknown): { collection: BoundaryCollection; sourceCrs: string | null } => {
  const root = asRecord(value);
  if (root.type !== 'FeatureCollection' || !Array.isArray(root.features)) {
    throw new Error('Boundary response is not a FeatureCollection');
  }

  const expected: Map<string, string> = new Map(AUTHORITY_BOUNDARIES.map((authority) => [authority.code, authority.name]));
  const seen = new Set<string>();
  const features: BoundaryFeature[] = root.features.map((rawFeature, index) => {
    const feature = asRecord(rawFeature);
    const properties = asRecord(feature.properties);
    const geometry = asRecord(feature.geometry);
    const code = text(properties.LAD24CD);
    const name = text(properties.LAD24NM);
    if (!code || !name || !expected.has(code) || expected.get(code) !== name) {
      throw new Error(`Unexpected boundary at feature ${index}: ${code ?? 'missing code'} / ${name ?? 'missing name'}`);
    }
    if (seen.has(code)) throw new Error(`Duplicate boundary code: ${code}`);
    seen.add(code);
    if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') {
      throw new Error(`Unsupported geometry type for ${code}: ${String(geometry.type)}`);
    }
    if (!isFiniteCoordinateTree(geometry.coordinates)) throw new Error(`Invalid WGS84 coordinates for ${code}`);
    return {
      type: 'Feature',
      id: code,
      properties: { LAD24CD: code, LAD24NM: name },
      geometry: {
        type: geometry.type,
        coordinates: geometry.coordinates,
      },
    };
  });

  if (features.length !== AUTHORITY_BOUNDARIES.length || seen.size !== AUTHORITY_BOUNDARIES.length) {
    throw new Error(`Expected ${AUTHORITY_BOUNDARIES.length} authority boundaries, received ${features.length}`);
  }

  const order: Map<string, number> = new Map(AUTHORITY_BOUNDARIES.map(({ code }, index) => [code, index]));
  features.sort((left, right) => (order.get(left.properties.LAD24CD) ?? 0) - (order.get(right.properties.LAD24CD) ?? 0));
  return {
    collection: { type: 'FeatureCollection', features },
    sourceCrs: sourceCrs(value),
  };
};

const fetchBoundaries = async (): Promise<{ collection: BoundaryCollection; sourceCrs: string | null; sourceUrl: string; retrievedAt: string }> => {
  const sourceUrl = queryUrl();
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Boundary request failed with HTTP ${response.status}`);
  const payload: unknown = await response.json();
  const retrievedAt = new Date().toISOString();
  const validated = validateAndNormalise(payload);
  if (validated.sourceCrs && !validated.sourceCrs.includes('4326')) {
    throw new Error(`Boundary service returned ${validated.sourceCrs}; expected EPSG:4326`);
  }
  return { ...validated, sourceUrl, retrievedAt };
};

const writeOutputs = async (result: Awaited<ReturnType<typeof fetchBoundaries>>): Promise<void> => {
  const dataDirectory = new URL('../public/data/', import.meta.url);
  await mkdir(dataDirectory, { recursive: true });
  const outputPath = new URL('boundaries.geojson', dataDirectory);
  const provenancePath = new URL('boundaries.provenance.json', dataDirectory);
  const generatedAt = new Date().toISOString();
  const provenance = {
    source: {
      publisher: 'Office for National Statistics',
      dataset: 'Local Authority Districts (December 2024) Boundaries UK BGC',
      datasetUrl: DATASET_URL,
      featureServerUrl: FEATURE_SERVER_URL,
      queryUrl: result.sourceUrl,
      boundaryProduct: 'BGC: generalised to 20m and clipped to the coastline',
      sourceCrs: result.sourceCrs ?? 'EPSG:4326 (requested; service omitted CRS member)',
      outputCrs: 'EPSG:4326',
      licence: 'Open Government Licence v3.0',
      licenceUrl: LICENCE_URL,
      attribution: 'Source: Office for National Statistics licensed under the Open Government Licence v.3.0. Contains OS data © Crown copyright and database right 2024.',
    },
    retrievedAt: result.retrievedAt,
    generatedAt,
    output: {
      file: 'public/data/boundaries.geojson',
      format: 'GeoJSON FeatureCollection',
      featureCount: result.collection.features.length,
      authorityCodes: result.collection.features.map((feature) => feature.properties.LAD24CD),
    },
    processing: [
      'Requested only the four study-area LAD24CD values from the official ONS FeatureServer.',
      'Requested WGS84 output with outSR=4326 for direct MapLibre rendering.',
      'Validated the expected code/name pair, geometry type, coordinate ranges, feature count and uniqueness.',
      'Removed the service CRS member from the output because GeoJSON coordinates are emitted as WGS84 longitude/latitude.',
      'Sorted features by authority code for deterministic output.',
    ],
  };
  await writeFile(outputPath, `${JSON.stringify(result.collection, null, 2)}\n`, 'utf8');
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
};

export const run = async (): Promise<void> => {
  const result = await fetchBoundaries();
  await writeOutputs(result);
  console.log(`Wrote ${result.collection.features.length} authority boundaries to public/data/boundaries.geojson`);
};

const scriptPath = process.argv[1];
if (scriptPath && pathToFileURL(scriptPath).href === import.meta.url) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
