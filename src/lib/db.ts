// Thin data-access layer.
// SQLite today; the surface (all/get/run/tx) is deliberately narrow so a
// PostgreSQL driver can be swapped in behind the same four functions.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config, ROOT, CONFIG_DEFAULTS } from '../config.ts';

mkdirSync(dirname(config.dbFile), { recursive: true });
export const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

/**
 * Columns added after a database was first created. SQLite has no
 * "ADD COLUMN IF NOT EXISTS", and an existing install should not have to be
 * wiped to pick up a new field — so check the table and add what's missing.
 */
function addColumnIfMissing(table: string, column: string, ddl: string) {
  const cols = all<any>(`PRAGMA table_info(${table})`).map((c: any) => c.name);
  if (!cols.includes(column)) run(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export function migrate() {
  db.exec(readFileSync(join(ROOT, 'db', 'schema.sql'), 'utf8'));
  // --- incremental columns -------------------------------------------
  addColumnIfMissing('locations', 'lore', 'lore TEXT');
  addColumnIfMissing('locations', 'external_source', 'external_source TEXT');
  addColumnIfMissing('locations', 'external_id', 'external_id TEXT');

}

type Row = Record<string, any>;

export function all<T = Row>(sql: string, params: any[] = []): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function get<T = Row>(sql: string, params: any[] = []): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function run(sql: string, params: any[] = []) {
  return db.prepare(sql).run(...params);
}
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---- admin-editable config, DB backed with code defaults as fallback ----
export function cfg<T = any>(key: string): T {
  const row = get<{ value_json: string }>('SELECT value_json FROM app_config WHERE key = ?', [key]);
  if (row) { try { return JSON.parse(row.value_json) as T; } catch { /* fall through */ } }
  return CONFIG_DEFAULTS[key] as T;
}
export function setCfg(key: string, value: unknown, actor?: string) {
  run(
    `INSERT INTO app_config (key, value_json, updated_by, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value), actor ?? null, new Date().toISOString()],
  );
}
export function allCfg(): Record<string, unknown> {
  const out: Record<string, unknown> = { ...CONFIG_DEFAULTS };
  for (const r of all<{ key: string; value_json: string }>('SELECT key, value_json FROM app_config')) {
    try { out[r.key] = JSON.parse(r.value_json); } catch { /* ignore */ }
  }
  return out;
}