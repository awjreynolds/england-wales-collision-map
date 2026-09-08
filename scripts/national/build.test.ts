import { equal, rejects, strictEqual, throws } from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { after, describe, it } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireExclusiveDirectoryLock, assertVehicleJoinRegression, publishStableAliasAt } from './build.ts';

const expectedVehicleJoins = {
  '2021': { sourceChildRows: { vehicle: 179_607 }, mappableChildRows: { vehicle: 179_572 }, collisionsWithCompleteVehicleJoin: 97_185 },
  '2022': { sourceChildRows: { vehicle: 186_358 }, mappableChildRows: { vehicle: 186_317 }, collisionsWithCompleteVehicleJoin: 101_879 },
  '2023': { sourceChildRows: { vehicle: 182_532 }, mappableChildRows: { vehicle: 182_511 }, collisionsWithCompleteVehicleJoin: 100_026 },
  '2024': { sourceChildRows: { vehicle: 176_253 }, mappableChildRows: { vehicle: 176_253 }, collisionsWithCompleteVehicleJoin: 96_760 },
  '2025': { sourceChildRows: { vehicle: 176_788 }, mappableChildRows: { vehicle: 176_784 }, collisionsWithCompleteVehicleJoin: 97_421 },
};

const temporaryDirectories: string[] = [];

after(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('national publication guards', () => {
  it('fails closed for concurrent lock waiters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weca-national-lock-test-'));
    temporaryDirectories.push(root);
    const lockPath = join(root, 'build.lock');
    const firstRelease = await acquireExclusiveDirectoryLock(lockPath);
    const waiters = await Promise.allSettled([
      acquireExclusiveDirectoryLock(lockPath),
      acquireExclusiveDirectoryLock(lockPath),
    ]);
    for (const waiter of waiters) {
      strictEqual(waiter.status, 'rejected');
      if (waiter.status === 'rejected') {
        strictEqual(waiter.reason instanceof Error, true);
        strictEqual(waiter.reason.message.includes('manually'), true);
      }
    }
    await firstRelease();
  });

  it('fails closed for a live lock even when its directory is aged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weca-national-aged-lock-test-'));
    temporaryDirectories.push(root);
    const lockPath = join(root, 'build.lock');
    const ownerFile = join(lockPath, 'owner.json');
    const owner = JSON.stringify({ pid: 1234, token: 'held-by-another-build', acquiredAt: '2020-01-01T00:00:00.000Z' });
    await mkdir(lockPath, { recursive: true });
    await writeFile(ownerFile, `${owner}\n`);
    const old = new Date('2020-01-02T00:00:00.000Z');
    await utimes(lockPath, old, old);

    await rejects(acquireExclusiveDirectoryLock(lockPath), /already exists.*owner information.*manually/);
    equal(await readFile(ownerFile, 'utf8'), `${owner}\n`);
  });

  it('rejects a truncated vehicle child input', () => {
    const truncated = structuredClone(expectedVehicleJoins);
    truncated['2023'].sourceChildRows.vehicle -= 1;
    throws(() => assertVehicleJoinRegression(truncated), /vehicle join regression mismatch for 2023/);
  });

  it('keeps each generation immutable while aliases follow one current pointer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weca-national-alias-test-'));
    temporaryDirectories.push(root);
    const generations = join(root, 'generations');
    const alias = join(root, '2021-2025');
    for (const version of ['v1', 'v2']) {
      const generation = join(generations, version);
      await mkdir(generation, { recursive: true });
      await writeFile(join(generation, 'manifest.json'), JSON.stringify({ datasetVersion: version }));
      await writeFile(join(generation, 'summary.json'), version);
      await writeFile(join(generation, 'collisions.ndjson'), version);
      await writeFile(join(generation, 'details.ndjson'), version);
      await writeFile(join(generation, 'authority-lookup.json'), version);
    }

    await publishStableAliasAt(alias, generations, 'v1', 'first');
    await publishStableAliasAt(alias, generations, 'v2', 'second');

    equal(await readlink(join(alias, 'current')), '../generations/v2');
    for (const artifact of ['manifest.json', 'summary.json', 'collisions.ndjson', 'details.ndjson', 'authority-lookup.json']) {
      equal(await readlink(join(alias, artifact)), `current/${artifact}`);
      strictEqual((await readFile(join(generations, 'v1', artifact), 'utf8')).includes('v1'), true);
      strictEqual((await readFile(join(generations, 'v2', artifact), 'utf8')).includes('v2'), true);
    }
  });

  it('rejects a legacy regular alias before changing current', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weca-national-legacy-alias-test-'));
    temporaryDirectories.push(root);
    const generations = join(root, 'generations');
    const alias = join(root, '2021-2025');
    for (const version of ['v1', 'v2']) {
      const generation = join(generations, version);
      await mkdir(generation, { recursive: true });
      await writeFile(join(generation, 'manifest.json'), JSON.stringify({ datasetVersion: version }));
      await writeFile(join(generation, 'summary.json'), version);
      await writeFile(join(generation, 'collisions.ndjson'), version);
      await writeFile(join(generation, 'details.ndjson'), version);
      await writeFile(join(generation, 'authority-lookup.json'), version);
    }

    await publishStableAliasAt(alias, generations, 'v1', 'first');
    await rm(join(alias, 'summary.json'));
    await writeFile(join(alias, 'summary.json'), 'legacy alias');

    await rejects(publishStableAliasAt(alias, generations, 'v2', 'second'), /Refusing automatic alias migration/);
    equal(await readlink(join(alias, 'current')), '../generations/v1');
    equal(await readFile(join(alias, 'summary.json'), 'utf8'), 'legacy alias');
    equal(await readFile(join(generations, 'v1', 'summary.json'), 'utf8'), 'v1');

    await rm(join(alias, 'summary.json'));
    await symlink('current/summary.json', join(alias, 'summary.json'));
    await rm(join(alias, 'details.ndjson'));
    await symlink('../generations/v1/details.ndjson', join(alias, 'details.ndjson'));
    await rejects(publishStableAliasAt(alias, generations, 'v2', 'third'), /Refusing automatic alias migration/);
    equal(await readlink(join(alias, 'current')), '../generations/v1');
  });
});
