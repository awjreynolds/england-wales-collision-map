-- Canonical read-only query tables. The import builder writes data separately;
-- this migration deliberately contains schema only so deployment never mutates
-- source records as part of a request.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS dataset_metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collisions (
  id TEXT PRIMARY KEY NOT NULL,
  dataset_version TEXT NOT NULL,
  year INTEGER,
  date TEXT,
  time TEXT,
  country TEXT CHECK (country IS NULL OR country IN ('England', 'Wales')),
  authority_code TEXT,
  authority_name TEXT,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  latitude_cell INTEGER NOT NULL,
  longitude_cell INTEGER NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('fatal', 'serious', 'slight', 'unknown')),
  casualty_count INTEGER,
  fatalities INTEGER,
  serious_casualties INTEGER,
  slight_casualties INTEGER,
  ksi_casualties INTEGER,
  pedestrian_involved INTEGER CHECK (pedestrian_involved IS NULL OR pedestrian_involved IN (0, 1)),
  cycle_involved INTEGER CHECK (cycle_involved IS NULL OR cycle_involved IN (0, 1)),
  motorcycle_involved INTEGER CHECK (motorcycle_involved IS NULL OR motorcycle_involved IN (0, 1)),
  road_name TEXT,
  road_number TEXT,
  speed_limit INTEGER,
  junction_detail TEXT,
  source_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS collisions_year_idx ON collisions (year);
CREATE INDEX IF NOT EXISTS collisions_country_year_idx ON collisions (country, year);
CREATE INDEX IF NOT EXISTS collisions_authority_year_idx ON collisions (authority_code, year);
CREATE INDEX IF NOT EXISTS collisions_lat_lon_idx ON collisions (latitude, longitude);
CREATE INDEX IF NOT EXISTS collisions_lat_cell_lon_cell_idx ON collisions (latitude_cell, longitude_cell);
CREATE INDEX IF NOT EXISTS collisions_severity_idx ON collisions (severity);

CREATE TABLE IF NOT EXISTS schools (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  country TEXT NOT NULL CHECK (country IN ('England', 'Wales')),
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  status TEXT,
  phase TEXT,
  source_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS schools_lat_lon_idx ON schools (latitude, longitude);
CREATE INDEX IF NOT EXISTS schools_country_idx ON schools (country);

CREATE TABLE IF NOT EXISTS precomputed_summaries (
  key TEXT PRIMARY KEY NOT NULL,
  dataset_version TEXT NOT NULL,
  filters_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS map_cells (
  cell_level INTEGER NOT NULL,
  latitude_cell INTEGER NOT NULL,
  longitude_cell INTEGER NOT NULL,
  dataset_version TEXT NOT NULL,
  count INTEGER NOT NULL,
  fatal_count INTEGER NOT NULL,
  serious_count INTEGER NOT NULL,
  slight_count INTEGER NOT NULL,
  unknown_count INTEGER NOT NULL,
  casualty_total INTEGER,
  casualty_unknown INTEGER NOT NULL,
  ksi_collision_count INTEGER NOT NULL,
  years_json TEXT NOT NULL,
  PRIMARY KEY (cell_level, latitude_cell, longitude_cell, dataset_version)
);

CREATE INDEX IF NOT EXISTS map_cells_level_idx ON map_cells (cell_level, latitude_cell, longitude_cell);
