-- Full STATS19 collision/casualty/vehicle evidence is kept in gzip chunks so
-- map queries only scan the compact collision table. The lookup table keeps
-- one small row per collision and points to the chunk containing its detail.
CREATE TABLE IF NOT EXISTS detail_chunks (
  chunk_id TEXT PRIMARY KEY NOT NULL,
  dataset_version TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  payload_base64 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS detail_lookup (
  collision_id TEXT PRIMARY KEY NOT NULL,
  chunk_id TEXT NOT NULL REFERENCES detail_chunks(chunk_id)
);

CREATE INDEX IF NOT EXISTS detail_lookup_chunk_idx ON detail_lookup (chunk_id);
