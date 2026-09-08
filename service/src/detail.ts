import type { CollisionEvidence } from '../contract';

interface DetailLookupRow {
  chunk_id: string;
}

interface DetailChunkRow {
  payload_base64: string;
}

interface DetailRecord {
  id?: unknown;
  raw?: {
    collision?: unknown;
    casualties?: unknown;
    vehicles?: unknown;
  };
  join?: unknown;
}

const objectOrEmpty = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const objectArray = (value: unknown): Array<Record<string, unknown>> => (
  Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : []
);

const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const inflateGzipText = async (payloadBase64: string): Promise<string> => {
  const compressed = decodeBase64(payloadBase64);
  const buffer = new ArrayBuffer(compressed.byteLength);
  new Uint8Array(buffer).set(compressed);
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
};

const evidenceFromRecord = (record: DetailRecord): CollisionEvidence => ({
  collision: objectOrEmpty(record.raw?.collision),
  casualties: objectArray(record.raw?.casualties),
  vehicles: objectArray(record.raw?.vehicles),
  join: objectOrEmpty(record.join),
});

/** Read one full detail record from the compressed evidence store. */
export const readDetailEvidence = async (db: D1Database, collisionId: string): Promise<CollisionEvidence | null> => {
  const lookup = await db.prepare('SELECT chunk_id FROM detail_lookup WHERE collision_id = ?1').bind(collisionId).first<DetailLookupRow>();
  if (!lookup) return null;
  const chunk = await db.prepare('SELECT payload_base64 FROM detail_chunks WHERE chunk_id = ?1').bind(lookup.chunk_id).first<DetailChunkRow>();
  if (!chunk) return null;
  const text = await inflateGzipText(chunk.payload_base64);
  for (const line of text.split('\n')) {
    if (!line) continue;
    const record = JSON.parse(line) as DetailRecord;
    if (record.id === collisionId) return evidenceFromRecord(record);
  }
  return null;
};
