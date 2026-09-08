import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertSqlStatementWithinLimit,
  deriveServiceDatasetIdentity,
  MAX_SQL_STATEMENT_BYTES,
  SQL_STATEMENT_BATCH_BYTES,
  SqlWriter,
  pinNationalGeneration,
} from '../scripts/build-import';
import { createSqliteD1 } from './helpers';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const writeGeneration = async (aliasDir: string, name: string, datasetVersion: string): Promise<string> => {
  const directory = join(aliasDir, name);
  await mkdir(directory, { recursive: true });
  const artifacts: Record<string, string> = {
    'summary.json': JSON.stringify({ datasetVersion, byYear: {} }),
    'collisions.ndjson': '{"id":"collision-1"}\n',
    'details.ndjson': '{"id":"collision-1","raw":{}}\n',
    'authority-lookup.json': JSON.stringify({ authorities: {} }),
  };
  const artifactHashes: Record<string, string> = {};
  for (const [file, content] of Object.entries(artifacts)) {
    await writeFile(join(directory, file), content, 'utf8');
    artifactHashes[file] = sha256(content);
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ datasetVersion, artifactHashes }), 'utf8');
  return directory;
};

const withTempAlias = async (callback: (aliasDir: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'weca-import-'));
  const aliasDir = join(root, 'alias');
  await mkdir(aliasDir, { recursive: true });
  try {
    await callback(aliasDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe('national importer identity', () => {
  it('rejects SQL statements over the D1 per-statement byte limit', () => {
    assertSqlStatementWithinLimit('x'.repeat(MAX_SQL_STATEMENT_BYTES));
    expect(() => assertSqlStatementWithinLimit('x'.repeat(MAX_SQL_STATEMENT_BYTES + 1))).toThrow(/exceeds D1 limit/);
  });

  it('batches compatible inserts with SQLite-equivalent upsert semantics', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'weca-sql-writer-'));
    const prefix = 'INSERT OR REPLACE INTO writer_test (id, value) VALUES ';
    const tuples = [
      "('a', 'O''Brien, west')",
      "('b', 'line 1\\nline 2')",
      "('a', 'replacement')",
    ];
    try {
      const writer = new SqlWriter('writer-test', outputDir);
      for (const tuple of tuples) await writer.addValues(prefix, tuple);
      await writer.finish();
      const sql = await readFile(join(outputDir, 'writer-test-00000.sql'), 'utf8');
      expect(sql.trim().startsWith(prefix)).toBe(true);
      expect(sql.trim().match(/INSERT OR REPLACE/g)).toHaveLength(1);
      expect(Buffer.byteLength(sql.trim(), 'utf8')).toBeLessThanOrEqual(SQL_STATEMENT_BATCH_BYTES);

      const batched = createSqliteD1().database;
      const individual = createSqliteD1().database;
      for (const database of [batched, individual]) database.exec('CREATE TABLE writer_test (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
      batched.exec(sql);
      for (const tuple of tuples) individual.exec(`${prefix}${tuple};`);
      const readRows = (database: typeof batched) => database.prepare('SELECT id, value FROM writer_test ORDER BY id').all();
      expect(readRows(batched)).toEqual(readRows(individual));
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('pins one generation and validates every canonical artifact hash', async () => {
    await withTempAlias(async (aliasDir) => {
      const generation = await writeGeneration(aliasDir, 'generation-a', 'national-a');
      await symlink(relative(aliasDir, generation), join(aliasDir, 'current'), 'dir');

      const pinned = await pinNationalGeneration(aliasDir);
      const replacement = await writeGeneration(aliasDir, 'generation-b', 'national-b');
      await rename(join(aliasDir, 'current'), join(aliasDir, 'current-old'));
      await symlink(relative(aliasDir, replacement), join(aliasDir, 'current'), 'dir');

      expect(pinned.directory).toBe(await realpath(generation));
      expect(pinned.manifest.datasetVersion).toBe('national-a');
      expect(pinned.summary.datasetVersion).toBe('national-a');
      expect(JSON.parse(await readFile(join(pinned.directory, 'summary.json'), 'utf8')).datasetVersion).toBe('national-a');
    });
  });

  it('rejects a tampered artifact before parsing its summary', async () => {
    await withTempAlias(async (aliasDir) => {
      const generation = await writeGeneration(aliasDir, 'generation-a', 'national-a');
      await symlink(relative(aliasDir, generation), join(aliasDir, 'current'), 'dir');
      await writeFile(join(generation, 'details.ndjson'), '{"id":"tampered"}\n', 'utf8');

      await expect(pinNationalGeneration(aliasDir)).rejects.toThrow(/hash mismatch.*details\.ndjson/);
    });
  });

  it('changes the service identity when the school output or importer changes', () => {
    const first = deriveServiceDatasetIdentity({
      nationalDatasetVersion: 'national-a',
      schoolOutputSha256: 'a'.repeat(64),
      schoolProvenanceSha256: 'c'.repeat(64),
      importerTransformSha256: 'b'.repeat(64),
      contractSourceSha256: 'd'.repeat(64),
    });
    const schoolChanged = deriveServiceDatasetIdentity({ ...first, nationalDatasetVersion: 'national-a', schoolOutputSha256: 'e'.repeat(64) });
    const provenanceChanged = deriveServiceDatasetIdentity({ ...first, nationalDatasetVersion: 'national-a', schoolProvenanceSha256: 'f'.repeat(64) });
    const importerChanged = deriveServiceDatasetIdentity({ ...first, nationalDatasetVersion: 'national-a', importerTransformSha256: 'e'.repeat(64) });
    const contractChanged = deriveServiceDatasetIdentity({ ...first, nationalDatasetVersion: 'national-a', contractSourceSha256: 'f'.repeat(64) });

    expect(first.datasetVersion).toContain('national-a');
    expect(first.nationalDatasetVersion).toBe('national-a');
    expect(schoolChanged.datasetVersion).not.toBe(first.datasetVersion);
    expect(provenanceChanged.datasetVersion).not.toBe(first.datasetVersion);
    expect(importerChanged.datasetVersion).not.toBe(first.datasetVersion);
    expect(contractChanged.datasetVersion).not.toBe(first.datasetVersion);
  });
});
