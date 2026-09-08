/** Build the public school point catalogue used by the England and Wales map.
 *
 * Raw source inputs are retained in an ignored content-addressed bundle under
 * data/schools/sources. The checked-in output contains only the fields in SchoolRecord;
 * it does not copy addresses, telephone numbers, staff names, pupil counts or
 * any other GIAS/DataMapWales fields.
 *
 * Run with: npm exec tsx scripts/schools/ingest.ts
 */
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { parse } from "csv-parse";
import { Readable } from "node:stream";

const execFile = promisify(execFileCallback);

const ROOT = resolve(import.meta.dirname, "../..");
const OUTPUT_DIR = join(ROOT, "data", "schools");
const SOURCES_DIR = join(OUTPUT_DIR, "sources");
const ACTIVE_SOURCE_POINTER = join(SOURCES_DIR, "active.json");
const GIAS_DOWNLOADS = "https://get-information-schools.service.gov.uk/Downloads";
const GIAS_TAG = "all.edubase.data";
const WALES_MAINTAINED = "https://datamap.gov.wales/geoserver/ows?service=WFS&version=1.0.0&request=GetFeature&typename=geonode%3Amaintained_schools_wg&outputFormat=json&srs=EPSG%3A4326&srsName=EPSG%3A4326";
const WALES_PRU = "https://datamap.gov.wales/geoserver/ows?service=WFS&version=1.0.0&request=GetFeature&typename=geonode%3Apupil_referal_units_wg&outputFormat=json&srs=EPSG%3A4326&srsName=EPSG%3A4326";
const WALES_ADDRESS_PAGE = "https://gov.wales/addresses-and-phone-numbers-schools-and-pupil-referral-units";

type Country = "England" | "Wales";
type Source = "DfE GIAS" | "Welsh Government DataMapWales";
type SchoolRecord = {
  id: string;
  name: string;
  country: Country;
  lat: number;
  lon: number;
  status: string;
  phase: string;
  source: Source;
};
type Counters = {
  sourceRows: number;
  candidateRows: number;
  includedRows: number;
  excludedRows: number;
  excludedByReason: Record<string, number>;
};
type GeoJson = { features?: Array<{ geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown> }> };
type SourceFile = { name: string; sourceUrl: string; retrievedAt: string | null; path: string; checksumSha256?: string; bytes?: number };
type BundleFile = { name: string; sourceUrl: string; retrievedAt: string | null; checksumSha256: string; bytes: number };
type BundleManifest = { schemaVersion: string; bundleHash: string; createdAt: string; files: BundleFile[] };
type JsonSource = { value: GeoJson; retrievedAt: string; checksumSha256: string; bytes: Buffer; path: string; sourceUrl: string };
type OfflineBundle = { directory: string; manifest: BundleManifest; files: Map<string, BundleFile> };

const BUNDLE_SCHEMA = "weca-schools-source-bundle/v1";

const SCHOOL_GROUPS = new Set([
  "Local authority maintained schools",
  "Academies",
  "Independent schools",
  "Special schools",
  "Free Schools",
]);
const OPERATIONAL_STATUSES = new Set(["Open", "Open, but proposed to close"]);
const emptyCounters = (): Counters => ({ sourceRows: 0, candidateRows: 0, includedRows: 0, excludedRows: 0, excludedByReason: {} });
const exclude = (counters: Counters, reason: string) => {
  counters.excludedRows += 1;
  counters.excludedByReason[reason] = (counters.excludedByReason[reason] ?? 0) + 1;
};
const text = (value: unknown): string => String(value ?? "").trim();
const number = (value: unknown): number => Number(String(value ?? "").replaceAll(",", "").trim());
const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const now = (): string => new Date().toISOString();

function bundleHash(files: readonly BundleFile[]): string {
  return sha256(JSON.stringify(files.map((file) => ({ name: file.name, checksumSha256: file.checksumSha256 }))));
}

function bundlePath(directory: string, name: string): string {
  // Source names are controlled by this builder. Reject manifest names that
  // could escape the bundle directory when an offline bundle is supplied.
  if (name !== name.split(/[\\/]/).at(-1) || name === "." || name === ".." || !name) {
    throw new Error(`Invalid school source bundle filename: ${name}`);
  }
  return join(directory, name);
}

async function loadOfflineBundle(directory: string): Promise<OfflineBundle> {
  const manifestPath = join(directory, "source-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BundleManifest;
  if (manifest.schemaVersion !== BUNDLE_SCHEMA || !/^[a-f0-9]{64}$/.test(manifest.bundleHash) || !Array.isArray(manifest.files)) {
    throw new Error(`Invalid school source bundle manifest: ${manifestPath}`);
  }
  const names = new Set<string>();
  for (const file of manifest.files) {
    if (!file || typeof file !== "object" || typeof file.name !== "string" || names.has(file.name)) {
      throw new Error(`Invalid or duplicate school source bundle filename: ${manifestPath}`);
    }
    if (typeof file.sourceUrl !== "string" || !file.sourceUrl || (file.retrievedAt !== null && typeof file.retrievedAt !== "string")
      || !/^[a-f0-9]{64}$/.test(file.checksumSha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new Error(`Invalid school source bundle file metadata: ${manifestPath}`);
    }
    names.add(file.name);
  }
  const sortedFiles = [...manifest.files].sort((left, right) => left.name.localeCompare(right.name));
  if (manifest.bundleHash !== bundleHash(sortedFiles)) {
    throw new Error(`School source bundle hash does not match its manifest: ${manifestPath}`);
  }
  const files = new Map<string, BundleFile>();
  for (const file of manifest.files) {
    const path = bundlePath(directory, file.name);
    const bytes = await readFile(path);
    const metadata = await stat(path);
    if (sha256(bytes) !== file.checksumSha256 || bytes.byteLength !== file.bytes) {
      throw new Error(`School source bundle checksum/size mismatch: ${path}`);
    }
    if (!metadata.isFile()) throw new Error(`School source bundle input is not a file: ${path}`);
    files.set(file.name, file);
  }
  return { directory, manifest, files };
}

async function resolveOfflineBundle(): Promise<OfflineBundle | undefined> {
  const explicit = process.env.SCHOOLS_OFFLINE_DIR;
  if (explicit) return loadOfflineBundle(resolve(explicit));
  if (process.env.SCHOOLS_OFFLINE !== "1") return undefined;
  const pointer = JSON.parse(await readFile(ACTIVE_SOURCE_POINTER, "utf8")) as { bundleHash?: string };
  if (!pointer.bundleHash || !/^[a-f0-9]{64}$/.test(pointer.bundleHash)) throw new Error(`School source pointer has an invalid bundleHash: ${ACTIVE_SOURCE_POINTER}`);
  return loadOfflineBundle(join(SOURCES_DIR, pointer.bundleHash));
}

function bundleInput(bundle: OfflineBundle, name: string): { path: string; metadata: BundleFile } {
  const metadata = bundle.files.get(name);
  if (!metadata) throw new Error(`Offline school source bundle is missing ${name}`);
  return { path: bundlePath(bundle.directory, name), metadata };
}

async function retainSourceBundle(inputs: SourceFile[]): Promise<{ directory: string; manifest: BundleManifest }> {
  const files: BundleFile[] = [];
  const names = new Set<string>();
  for (const input of inputs) {
    if (names.has(input.name)) throw new Error(`Duplicate school source bundle filename: ${input.name}`);
    bundlePath(SOURCES_DIR, input.name);
    const bytes = await readFile(input.path);
    const metadata = await stat(input.path);
    files.push({
      name: input.name,
      sourceUrl: input.sourceUrl,
      retrievedAt: input.retrievedAt,
      checksumSha256: sha256(bytes),
      bytes: metadata.size,
    });
    names.add(input.name);
  }
  files.sort((left, right) => left.name.localeCompare(right.name));
  const sourceBundleHash = bundleHash(files);
  const directory = join(SOURCES_DIR, sourceBundleHash);
  await mkdir(directory, { recursive: true });
  const existingManifestPath = join(directory, "source-manifest.json");
  let manifest: BundleManifest;
  try {
    // A content-addressed generation is immutable. Reuse a complete existing
    // generation instead of rewriting its files or retrieval metadata.
    manifest = (await loadOfflineBundle(directory)).manifest;
    if (manifest.bundleHash !== sourceBundleHash) throw new Error(`Existing source bundle has the wrong hash: ${directory}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    for (const input of inputs) await copyFile(input.path, bundlePath(directory, input.name));
    manifest = { schemaVersion: BUNDLE_SCHEMA, bundleHash: sourceBundleHash, createdAt: now(), files };
    const partialManifestPath = `${existingManifestPath}.${randomUUID()}.partial`;
    await writeFile(partialManifestPath, JSON.stringify(manifest, null, 2) + "\n");
    await rename(partialManifestPath, existingManifestPath);
  }
  await mkdir(SOURCES_DIR, { recursive: true });
  const pointerPath = `${ACTIVE_SOURCE_POINTER}.${randomUUID()}.partial`;
  await writeFile(pointerPath, JSON.stringify({ bundleHash: sourceBundleHash, updatedAt: now() }, null, 2) + "\n");
  await rename(pointerPath, ACTIVE_SOURCE_POINTER);
  return { directory, manifest };
}

/** OSGB36 British National Grid (EPSG:27700) to WGS84, using the published
 * Ordnance Survey ellipsoid and Helmert transformation parameters. */
function bngToWgs84(easting: number, northing: number): { lat: number; lon: number } {
  const a = 6377563.396;
  const b = 6356256.909;
  const f0 = 0.9996012717;
  const lat0 = (49 * Math.PI) / 180;
  const lon0 = (-2 * Math.PI) / 180;
  const n0 = -100000;
  const e0 = 400000;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b);
  const m = (phi: number): number => {
    const d = phi - lat0;
    const s = phi + lat0;
    return b * f0 * ((1 + n + (5 / 4) * n ** 2 + (5 / 4) * n ** 3) * d
      - (3 * n + 3 * n ** 2 + (21 / 8) * n ** 3) * Math.sin(d) * Math.cos(s)
      + ((15 / 8) * n ** 2 + (15 / 8) * n ** 3) * Math.sin(2 * d) * Math.cos(2 * s)
      - (35 / 24) * n ** 3 * Math.sin(3 * d) * Math.cos(3 * s));
  };
  let phi = lat0;
  do {
    phi = (northing - n0 - m(phi)) / (a * f0) + phi;
  } while (Math.abs(northing - n0 - m(phi)) >= 0.00001);
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const tanPhi = Math.tan(phi);
  const nu = (a * f0) / Math.sqrt(1 - e2 * sinPhi ** 2);
  const rho = (a * f0 * (1 - e2)) / (1 - e2 * sinPhi ** 2) ** 1.5;
  const eta2 = nu / rho - 1;
  const dE = easting - e0;
  const vii = tanPhi / (2 * rho * nu);
  const viii = tanPhi / (24 * rho * nu ** 3) * (5 + 3 * tanPhi ** 2 + eta2 - 9 * tanPhi ** 2 * eta2);
  const ix = tanPhi / (720 * rho * nu ** 5) * (61 + 90 * tanPhi ** 2 + 45 * tanPhi ** 4);
  const x = 1 / (cosPhi * nu);
  const xi = (1 / (6 * cosPhi * nu ** 3)) * (nu / rho + 2 * tanPhi ** 2);
  const xii = (1 / (120 * cosPhi * nu ** 5)) * (5 + 28 * tanPhi ** 2 + 24 * tanPhi ** 4);
  const xiiA = (1 / (5040 * cosPhi * nu ** 7)) * (61 + 662 * tanPhi ** 2 + 1320 * tanPhi ** 4 + 720 * tanPhi ** 6);
  const lat = phi - vii * dE ** 2 + viii * dE ** 4 - ix * dE ** 6;
  const lon = lon0 + x * dE - xi * dE ** 3 + xii * dE ** 5 - xiiA * dE ** 7;

  // Convert OSGB36 geodetic to cartesian, then apply the OS Helmert transform.
  const h = 0;
  // Projection radii include the central scale factor. The geocentric
  // conversion uses the ellipsoid radius without that factor and the
  // converged projected latitude/longitude.
  const osSin = Math.sin(lat);
  const osCos = Math.cos(lat);
  const osNu = a / Math.sqrt(1 - e2 * osSin ** 2);
  const osX = (osNu + h) * osCos * Math.cos(lon);
  const osY = (osNu + h) * osCos * Math.sin(lon);
  const osZ = ((1 - e2) * osNu + h) * osSin;
  const tx = 446.448; const ty = -125.157; const tz = 542.060;
  const s = 20.4894e-6;
  const rx = (0.1502 / 3600) * (Math.PI / 180);
  const ry = (0.2470 / 3600) * (Math.PI / 180);
  const rz = (0.8421 / 3600) * (Math.PI / 180);
  const scale = 1 + s;
  const wX = tx + scale * osX - rz * osY + ry * osZ;
  const wY = ty + rz * osX + scale * osY - rx * osZ;
  const wZ = tz - ry * osX + rx * osY + scale * osZ;
  const wa = 6378137;
  const wb = 6356752.3141;
  const we2 = 1 - (wb * wb) / (wa * wa);
  const p = Math.sqrt(wX ** 2 + wY ** 2);
  let wLat = Math.atan2(wZ, p * (1 - we2));
  for (let i = 0; i < 10; i += 1) {
    const v = wa / Math.sqrt(1 - we2 * Math.sin(wLat) ** 2);
    wLat = Math.atan2(wZ + we2 * v * Math.sin(wLat), p);
  }
  return { lat: (wLat * 180) / Math.PI, lon: (Math.atan2(wY, wX) * 180) / Math.PI };
}

function validPoint(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= 49 && lat <= 56.5 && lon >= -8 && lon <= 2.5;
}

type CookieJar = Map<string, string>;
function cookieHeader(jar: CookieJar): string { return [...jar].map(([key, value]) => `${key}=${value}`).join("; "); }
function updateCookies(response: Response, jar: CookieJar): void {
  const raw = response.headers.get("set-cookie") ?? "";
  for (const part of raw.split(/,(?=[^;,]+=)/)) {
    const match = part.match(/^\s*([^=;]+)=([^;]*)/);
    if (match) jar.set(match[1], match[2]);
  }
}
async function request(url: string, init: RequestInit = {}, jar?: CookieJar): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("user-agent", "weca-collision-map school catalogue refresh");
  if (jar && jar.size) headers.set("cookie", cookieHeader(jar));
  const response = await fetch(url, { ...init, headers });
  if (jar) updateCookies(response, jar);
  if (!response.ok && response.status !== 302 && response.status !== 303) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response;
}

function inputValue(html: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<input\\b[^>]*\\bname=["']${escaped}["'][^>]*>`, "i"));
  return match?.[0].match(/\bvalue=["']([^"']*)["']/i)?.[1] ?? "";
}
function allInputs(html: string): Array<[string, string]> {
  return [...html.matchAll(/<input\b[^>]*>/gi)].flatMap((match) => {
    const name = match[0].match(/\bname=["']([^"']+)["']/i)?.[1];
    if (!name) return [];
    return [[name, match[0].match(/\bvalue=["']([^"']*)["']/i)?.[1] ?? ""]];
  });
}

async function downloadGiasZip(tempRoot: string): Promise<{ zipPath: string; retrievedAt: string; sourceUrl: string; checksumSha256: string }> {
  const jar: CookieJar = new Map();
  const page = await request(GIAS_DOWNLOADS, {}, jar);
  const html = await page.text();
  const token = inputValue(html, "__RequestVerificationToken");
  if (!token) throw new Error("GIAS download page did not contain its anti-forgery token");
  const body = new URLSearchParams();
  for (const [name, value] of allInputs(html)) body.append(name, value);
  body.set("__RequestVerificationToken", token);
  body.set("Downloads[0].Tag", GIAS_TAG);
  body.set("Downloads[0].Selected", "true");
  const collate = await request(`${GIAS_DOWNLOADS}/Collate`, { method: "POST", body }, jar);
  const collateText = await collate.text();
  const parsed = JSON.parse(collateText) as unknown;
  const payload = typeof parsed === "string" ? JSON.parse(parsed) as Record<string, unknown> : parsed as Record<string, unknown>;
  const id = text(payload.id ?? payload.guid ?? payload.GUID ?? payload.requestId);
  if (!id) throw new Error(`GIAS collate response did not contain a generation id: ${collateText.slice(0, 200)}`);
  let generatedUrl = "";
  for (let i = 0; i < 90; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    const poll = await request(`${GIAS_DOWNLOADS}/GenerateAjax/${encodeURIComponent(id)}`, {}, jar);
    const raw = await poll.text();
    const value = JSON.parse(raw) as unknown;
    const status = (typeof value === "string" ? JSON.parse(value) : value) as Record<string, unknown>;
    const ready = status.status === true || status.Status === true || status.complete === true || status.ready === true;
    if (ready) {
      generatedUrl = new URL(text(status.url ?? status.location ?? status.redirect ?? `${GIAS_DOWNLOADS}/Generate/${id}`), GIAS_DOWNLOADS).toString();
      break;
    }
  }
  if (!generatedUrl) throw new Error("GIAS ZIP generation timed out");
  const generated = await request(generatedUrl, {}, jar);
  const generatedHtml = await generated.text();
  const formAction = generatedHtml.match(/<form\b[^>]*action=["']([^"']+)["'][^>]*>/i)?.[1] ?? `${GIAS_DOWNLOADS}/Download/Extract`;
  const extractBody = new URLSearchParams(allInputs(generatedHtml));
  const extracted = await request(new URL(formAction, GIAS_DOWNLOADS).toString(), { method: "POST", body: extractBody, redirect: "manual" }, jar);
  const location = extracted.headers.get("location");
  if (!location) throw new Error("GIAS extract response did not contain a ZIP location");
  const zip = await request(new URL(location, generatedUrl).toString(), {}, jar);
  const bytes = Buffer.from(await zip.arrayBuffer());
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error("GIAS download was not a ZIP archive");
  const zipPath = join(tempRoot, "gias.zip");
  await writeFile(zipPath, bytes);
  return { zipPath, retrievedAt: now(), sourceUrl: zip.url || new URL(location, generatedUrl).toString(), checksumSha256: sha256(bytes) };
}

async function extractGiasCsv(zipPath: string, tempRoot: string): Promise<string> {
  const listed = await execFile("unzip", ["-Z1", zipPath], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  const files = String(listed.stdout).split(/\r?\n/).map((v) => v.trim()).filter((v) => v.toLowerCase().endsWith(".csv"));
  const filename = files.find((v) => v.toLowerCase().includes("edubase")) ?? files[0];
  if (!filename) throw new Error("GIAS ZIP contained no CSV");
  const csvPath = join(tempRoot, "gias.csv");
  const unzipped = await execFile("unzip", ["-p", zipPath, filename], { encoding: "buffer", maxBuffer: 120 * 1024 * 1024 });
  await writeFile(csvPath, unzipped.stdout as Buffer);
  return csvPath;
}

async function readEngland(csvPath: string): Promise<{ records: SchoolRecord[]; counters: Counters }> {
  const counters = emptyCounters();
  const records: SchoolRecord[] = [];
  // GIAS is Windows-1252.  Decode the temporary file before passing it to
  // csv-parse because Node's stream encodings do not include Windows-1252.
  const csvText = new TextDecoder("windows-1252").decode(await readFile(csvPath));
  const requiredHeaders = new Set(["URN", "EstablishmentName", "EstablishmentTypeGroup (name)", "EstablishmentStatus (name)", "PhaseOfEducation (name)", "GSSLACode (name)", "Easting", "Northing"]);
  const parser = parse({
    columns: (headers: string[]) => {
      const missing = [...requiredHeaders].filter((header) => !headers.includes(header));
      if (missing.length) throw new Error(`GIAS CSV is missing required columns: ${missing.join(", ")}`);
      return headers;
    },
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });
  Readable.from([csvText]).pipe(parser);
  for await (const row of parser as AsyncIterable<Record<string, string>>) {
    counters.sourceRows += 1;
    const gss = text(row["GSSLACode (name)"]);
    if (!(gss.startsWith("E") || gss === "X999999")) { exclude(counters, "outsideEnglandScope"); continue; }
    if (!SCHOOL_GROUPS.has(text(row["EstablishmentTypeGroup (name)"]))) { exclude(counters, "notSchoolEstablishmentGroup"); continue; }
    counters.candidateRows += 1;
    const country = text(row["Country (name)"]);
    if (country && !/united kingdom/i.test(country)) { exclude(counters, "foreignCountry"); continue; }
    const urn = text(row.URN);
    if (!/^\d+$/.test(urn)) { exclude(counters, "missingId"); continue; }
    const name = text(row.EstablishmentName);
    if (!name) { exclude(counters, "missingName"); continue; }
    const status = text(row["EstablishmentStatus (name)"]);
    if (!status) { exclude(counters, "missingStatus"); continue; }
    if (!OPERATIONAL_STATUSES.has(status)) { exclude(counters, "nonOperationalStatus"); continue; }
    const phase = text(row["PhaseOfEducation (name)"]);
    if (!phase) { exclude(counters, "missingPhase"); continue; }
    const rawEasting = text(row.Easting); const rawNorthing = text(row.Northing);
    if (!rawEasting || !rawNorthing) { exclude(counters, "missingCoordinate"); continue; }
    const easting = number(rawEasting); const northing = number(rawNorthing);
    if (!Number.isFinite(easting) || !Number.isFinite(northing) || easting <= 0 || northing <= 0) { exclude(counters, "invalidCoordinate"); continue; }
    const point = bngToWgs84(easting, northing);
    if (!validPoint(point.lat, point.lon)) { exclude(counters, "invalidCoordinate"); continue; }
    records.push({ id: `england:${urn}`, name, country: "England", lat: Math.round(point.lat * 1e6) / 1e6, lon: Math.round(point.lon * 1e6) / 1e6, status, phase, source: "DfE GIAS" });
    counters.includedRows += 1;
  }
  if (counters.sourceRows === 0) throw new Error("GIAS CSV contained no data rows");
  return { records, counters };
}

async function fetchJson(url: string, offlinePath?: string, offlineMetadata?: BundleFile): Promise<JsonSource> {
  if (offlinePath) {
    const bytes = await readFile(offlinePath);
    return { value: JSON.parse(bytes.toString("utf8")) as GeoJson, retrievedAt: offlineMetadata?.retrievedAt ?? (await stat(offlinePath)).mtime.toISOString(), checksumSha256: sha256(bytes), bytes, path: offlinePath, sourceUrl: offlineMetadata?.sourceUrl ?? url };
  }
  const retrievedAt = now();
  const response = await request(url);
  const bytes = Buffer.from(await response.arrayBuffer());
  return { value: JSON.parse(bytes.toString("utf8")) as GeoJson, retrievedAt, checksumSha256: sha256(bytes), bytes, path: "", sourceUrl: url };
}
function readWalesLayer(json: GeoJson, kind: "maintained" | "pru"): { records: SchoolRecord[]; counters: Counters } {
  const counters = emptyCounters(); const records: SchoolRecord[] = [];
  const features = json.features ?? [];
  if (features.length === 0) throw new Error(`Welsh ${kind} layer contained no features`);
  for (const feature of features) {
    counters.sourceRows += 1;
    const p = feature.properties ?? {}; const coords = feature.geometry?.coordinates;
    const idValue = kind === "maintained" ? p.school_code : p.school_number;
    const id = text(idValue); const name = text(kind === "maintained" ? p.school_name : p.school_name);
    counters.candidateRows += 1;
    if (!id) { exclude(counters, "missingId"); continue; }
    if (!name) { exclude(counters, "missingName"); continue; }
    if (feature.geometry?.type !== "Point") { exclude(counters, "invalidGeometry"); continue; }
    if (!Array.isArray(coords) || coords.length < 2) { exclude(counters, "missingCoordinate"); continue; }
    const lon = number(coords[0]); const lat = number(coords[1]);
    if (!validPoint(lat, lon)) { exclude(counters, "invalidCoordinate"); continue; }
    const phase = kind === "maintained" ? text(p.school_type) : "Pupil referral unit";
    if (!phase) { exclude(counters, "missingPhase"); continue; }
    records.push({ id: `wales:${kind}:${id}`, name, country: "Wales", lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, status: "current-listed", phase, source: "Welsh Government DataMapWales" });
    counters.includedRows += 1;
  }
  return { records, counters };
}

type CoverageResult = { sourceUrl: string; fileUrl: string | null; independentRows: number | null; checksumSha256?: string; error?: string; inputFiles: SourceFile[] };

async function independentAddressCoverage(tempRoot: string, offlineBundle?: OfflineBundle): Promise<CoverageResult> {
  const inputFiles: SourceFile[] = [];
  try {
    let html: string;
    if (offlineBundle) {
      const page = bundleInput(offlineBundle, "wales-address-list.html");
      html = await readFile(page.path, "utf8");
      inputFiles.push({ name: "wales-address-list.html", sourceUrl: page.metadata.sourceUrl, retrievedAt: page.metadata.retrievedAt, path: page.path });
    } else {
      const pageResponse = await request(WALES_ADDRESS_PAGE);
      const pageBytes = Buffer.from(await pageResponse.arrayBuffer());
      const pagePath = join(tempRoot, "wales-address-list.html");
      await writeFile(pagePath, pageBytes);
      html = pageBytes.toString("utf8");
      inputFiles.push({ name: "wales-address-list.html", sourceUrl: pageResponse.url, retrievedAt: now(), path: pagePath });
    }
    const href = html.match(/href=["']([^"']+\.ods)["']/i)?.[1];
    if (!href) return { sourceUrl: WALES_ADDRESS_PAGE, fileUrl: null, independentRows: null, error: "ODS link not found", inputFiles };
    const fileUrl = new URL(href, WALES_ADDRESS_PAGE).toString();
    let bytes: Buffer; let path: string; let odsUrl = fileUrl; let odsRetrievedAt = now();
    if (offlineBundle) {
      const ods = bundleInput(offlineBundle, "wales-addresses.ods");
      bytes = await readFile(ods.path); path = ods.path; odsUrl = ods.metadata.sourceUrl; odsRetrievedAt = ods.metadata.retrievedAt ?? odsRetrievedAt;
    } else {
      const odsResponse = await request(fileUrl);
      bytes = Buffer.from(await odsResponse.arrayBuffer()); path = join(tempRoot, "wales-addresses.ods"); await writeFile(path, bytes);
      odsUrl = odsResponse.url; odsRetrievedAt = now();
    }
    inputFiles.push({ name: "wales-addresses.ods", sourceUrl: odsUrl, retrievedAt: odsRetrievedAt, path });
    const xml = await execFile("unzip", ["-p", path, "content.xml"], { encoding: "utf8", maxBuffer: 30 * 1024 * 1024 });
    const sheet = String(xml.stdout).match(/<table:table\b[^>]*table:name=["']Independent["'][^>]*>([\s\S]*?)<\/table:table>/i)?.[1];
    if (!sheet) return { sourceUrl: WALES_ADDRESS_PAGE, fileUrl, independentRows: null, checksumSha256: sha256(bytes), error: "Independent sheet not found", inputFiles };
    const rows = (sheet.match(/<table:table-row\b/g) ?? []).length;
    return { sourceUrl: WALES_ADDRESS_PAGE, fileUrl, independentRows: Math.max(0, rows - 1), checksumSha256: sha256(bytes), inputFiles };
  } catch (error) {
    return { sourceUrl: WALES_ADDRESS_PAGE, fileUrl: null, independentRows: null, error: error instanceof Error ? error.message : String(error), inputFiles };
  }
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), "weca-schools-"));
  try {
    const offlineBundle = await resolveOfflineBundle();
    const gias = offlineBundle
      ? (() => {
        const zip = bundleInput(offlineBundle, "gias.zip");
        return { zipPath: zip.path, retrievedAt: zip.metadata.retrievedAt ?? offlineBundle.manifest.createdAt, sourceUrl: zip.metadata.sourceUrl, checksumSha256: zip.metadata.checksumSha256 };
      })()
      : await downloadGiasZip(tempRoot);
    const giasCsv = offlineBundle ? bundleInput(offlineBundle, "gias.csv").path : await extractGiasCsv(gias.zipPath, tempRoot);
    const [england, maintained, pru, coverage] = await Promise.all([
      readEngland(giasCsv),
      fetchJson(WALES_MAINTAINED, offlineBundle ? bundleInput(offlineBundle, "wales-maintained.json").path : undefined, offlineBundle?.files.get("wales-maintained.json")),
      fetchJson(WALES_PRU, offlineBundle ? bundleInput(offlineBundle, "wales-pru.json").path : undefined, offlineBundle?.files.get("wales-pru.json")),
      independentAddressCoverage(tempRoot, offlineBundle),
    ]);
    if (!offlineBundle) {
      maintained.path = join(tempRoot, "wales-maintained.json");
      await writeFile(maintained.path, maintained.bytes);
      pru.path = join(tempRoot, "wales-pru.json");
      await writeFile(pru.path, pru.bytes);
    }
    const rawInputs: SourceFile[] = [
      { name: "gias.zip", sourceUrl: gias.sourceUrl, retrievedAt: gias.retrievedAt, path: gias.zipPath },
      { name: "gias.csv", sourceUrl: gias.sourceUrl, retrievedAt: gias.retrievedAt, path: giasCsv },
      { name: "wales-maintained.json", sourceUrl: maintained.sourceUrl, retrievedAt: maintained.retrievedAt, path: maintained.path },
      { name: "wales-pru.json", sourceUrl: pru.sourceUrl, retrievedAt: pru.retrievedAt, path: pru.path },
      ...coverage.inputFiles,
    ];
    // External offline bundles are copied into the local content-addressed
    // source store before provenance is written. This keeps the recorded
    // data/schools/sources/<hash> path valid after the caller's staging
    // directory is removed or moved.
    const rawBundle = offlineBundle
      ? await retainSourceBundle(offlineBundle.manifest.files.map((file) => ({
        name: file.name,
        sourceUrl: file.sourceUrl,
        retrievedAt: file.retrievedAt,
        path: bundleInput(offlineBundle, file.name).path,
      })))
      : await retainSourceBundle(rawInputs);
    const coverageDetails = {
      sourceUrl: coverage.sourceUrl,
      fileUrl: coverage.fileUrl,
      independentRows: coverage.independentRows,
      ...(coverage.checksumSha256 ? { checksumSha256: coverage.checksumSha256 } : {}),
      ...(coverage.error ? { error: coverage.error } : {}),
    };
    const maintainedRecords = readWalesLayer(maintained.value, "maintained");
    const pruRecords = readWalesLayer(pru.value, "pru");
    const duplicateIds = new Set<string>(); const records: SchoolRecord[] = [];
    for (const record of [...england.records, ...maintainedRecords.records, ...pruRecords.records]) {
      if (records.some((existing) => existing.id === record.id)) { duplicateIds.add(record.id); continue; }
      records.push(record);
    }
    records.sort((a, b) => a.country.localeCompare(b.country) || a.id.localeCompare(b.id));
    const generatedAt = now();
    const output = JSON.stringify(records, null, 2) + "\n";
    const provenance = {
      generatedAt,
      script: "scripts/schools/ingest.ts",
      sources: [
        { name: "DfE Get Information about Schools (GIAS)", url: GIAS_DOWNLOADS, downloadUrl: gias.sourceUrl, retrievedAt: gias.retrievedAt, checksumSha256: sha256(await readFile(giasCsv)), bundleFiles: ["gias.zip", "gias.csv"], licence: "Open Government Licence v3.0", notes: "Current generated all.edubase.data download; only operational records (Open or Open, but proposed to close) are included; Easting/Northing converted from EPSG:27700 to WGS84." },
        { name: "Welsh Government DataMapWales maintained schools", url: WALES_MAINTAINED, retrievedAt: maintained.retrievedAt, checksumSha256: maintained.checksumSha256, bundleFiles: ["wales-maintained.json"], licence: "Open Government Licence v3.0", notes: "Current-listed status is used because the layer has no status field." },
        { name: "Welsh Government DataMapWales pupil referral units", url: WALES_PRU, retrievedAt: pru.retrievedAt, checksumSha256: pru.checksumSha256, bundleFiles: ["wales-pru.json"], licence: "Open Government Licence v3.0", notes: "Current-listed status is used because the layer has no status field." },
      ],
      rawInputBundle: {
        schemaVersion: rawBundle.manifest.schemaVersion,
        bundleHash: rawBundle.manifest.bundleHash,
        path: `data/schools/sources/${rawBundle.manifest.bundleHash}`,
        manifestPath: `data/schools/sources/${rawBundle.manifest.bundleHash}/source-manifest.json`,
        files: rawBundle.manifest.files,
        offlineMode: Boolean(offlineBundle),
      },
      output: { recordCount: records.length, fields: ["id", "name", "country", "lat", "lon", "status", "phase", "source"], checksumSha256: sha256(output), piiExcluded: ["addresses", "postcodes", "telephone numbers", "staff names", "pupil counts"] },
      counts: { england: england.counters, walesMaintained: maintainedRecords.counters, walesPru: pruRecords.counters, duplicateIdsRemoved: duplicateIds.size },
      coverage: { independentWelshAddressList: { ...coverageDetails, excludedReason: "The current official address list provides names and addresses but no authoritative point coordinates; no postcode geocoding or inferred coordinates is performed." }, note: "Welsh DataMapWales maintained-school and PRU layers are included. Independent Welsh schools remain explicitly outside the point catalogue until an authoritative coordinate layer is available." },
    };
    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(join(OUTPUT_DIR, "schools.json"), output);
    await writeFile(join(OUTPUT_DIR, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
    console.log(JSON.stringify({ recordCount: records.length, england: england.counters, walesMaintained: maintainedRecords.counters, walesPru: pruRecords.counters, rawInputBundle: rawBundle.manifest.bundleHash, offline: Boolean(offlineBundle), output: OUTPUT_DIR }, null, 2));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
