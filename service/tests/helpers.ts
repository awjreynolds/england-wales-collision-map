import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { D1Database } from '@cloudflare/workers-types';

type SqliteDatabase = InstanceType<typeof DatabaseSync>;

export const createSqliteD1 = (): { database: SqliteDatabase; d1: D1Database } => {
  const database = new DatabaseSync(':memory:');
  database.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  database.exec(readFileSync(new URL('../migrations/0002_detail_chunks.sql', import.meta.url), 'utf8'));
  const d1 = {
    prepare(sql: string) {
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]) { params = values; return this; },
        async first<T>() { return (database.prepare(sql).get(...params as never[]) as T | undefined) ?? null; },
        async all<T>() { return { results: database.prepare(sql).all(...params as never[]) as T[] }; },
        async run() { database.prepare(sql).run(...params as never[]); return { success: true, meta: {} }; },
      };
    },
  } as unknown as D1Database;
  return { database, d1 };
};

export const insertCollision = (database: SqliteDatabase, row: Partial<Record<string, unknown>> & { id: string; latitude: number; longitude: number }): void => {
  const values = {
    dataset_version: 'test-v1', year: null, date: null, time: null, country: 'England', authority_code: 'E1', authority_name: 'Test Authority',
    severity: 'slight', casualty_count: 1, fatalities: 0, serious_casualties: 0, slight_casualties: 1, ksi_casualties: 0,
    pedestrian_involved: null, cycle_involved: null, motorcycle_involved: null, road_name: null, road_number: null, speed_limit: null, junction_detail: null, source_json: '{}',
    ...row,
  };
  database.prepare(`INSERT INTO collisions (id, dataset_version, year, date, time, country, authority_code, authority_name, latitude, longitude, latitude_cell, longitude_cell, severity, casualty_count, fatalities, serious_casualties, slight_casualties, ksi_casualties, pedestrian_involved, cycle_involved, motorcycle_involved, road_name, road_number, speed_limit, junction_detail, source_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(values.id, values.dataset_version, values.year, values.date, values.time, values.country, values.authority_code, values.authority_name, values.latitude, values.longitude, Math.floor((values.latitude as number + 90)), Math.floor((values.longitude as number + 180)), values.severity, values.casualty_count, values.fatalities, values.serious_casualties, values.slight_casualties, values.ksi_casualties, values.pedestrian_involved, values.cycle_involved, values.motorcycle_involved, values.road_name, values.road_number, values.speed_limit, values.junction_detail, values.source_json);
};

export const insertSchool = (database: SqliteDatabase, row: { id: string; name: string; country?: string; latitude: number; longitude: number }): void => {
  database.prepare('INSERT INTO schools (id, name, country, latitude, longitude, status, phase, source_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, row.name, row.country ?? 'England', row.latitude, row.longitude, null, null, '{}');
};
