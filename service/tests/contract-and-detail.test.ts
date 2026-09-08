import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { QueryParseError, parseQuery } from '../contract';
import { readDetailEvidence } from '../src/detail';
import { createSqliteD1 } from './helpers';

const encodeBase64 = (value: Uint8Array): string => {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
};

describe('national contract and detail evidence', () => {
  it('normalizes world and antimeridian bboxes', () => {
    const world = parseQuery(new URL('https://example.test/view?bbox=-180,-90,180,90'));
    expect(world.bbox?.world).toBe(true);
    const crossing = parseQuery(new URL('https://example.test/view?bbox=179,49,-179,56'));
    expect(crossing.bbox).toMatchObject({ west: 179, east: -179, south: 49, north: 56 });
  });

  it('rejects invalid analysis parameters before a database query', () => {
    expect(() => parseQuery(new URL('https://example.test/analysis?radius=75'))).toThrow(QueryParseError);
    expect(() => parseQuery(new URL('https://example.test/analysis?bbox=0,0,1,1&limit=0'))).toThrow(QueryParseError);
  });

  it('decompresses one detail chunk and preserves joined child evidence', async () => {
    const { database, d1 } = createSqliteD1();
    const detail = { id: 'c1', raw: { collision: { collision_index: 'c1' }, casualties: [{ casualty_reference: '1' }], vehicles: [{ vehicle_reference: '1' }] }, join: { casualtyRowsJoined: 1 } };
    const payload = encodeBase64(gzipSync(Buffer.from(`${JSON.stringify(detail)}\n`)));
    database.prepare('INSERT INTO detail_chunks (chunk_id, dataset_version, row_count, payload_base64) VALUES (?, ?, ?, ?)').run('details-000000', 'test-v1', 1, payload);
    database.prepare('INSERT INTO detail_lookup (collision_id, chunk_id) VALUES (?, ?)').run('c1', 'details-000000');
    await expect(readDetailEvidence(d1, 'c1')).resolves.toEqual({ collision: { collision_index: 'c1' }, casualties: [{ casualty_reference: '1' }], vehicles: [{ vehicle_reference: '1' }], join: { casualtyRowsJoined: 1 } });
    await expect(readDetailEvidence(d1, 'missing')).resolves.toBeNull();
  });
});
