
// 持久化：打开数据库、应用迁移、通用查询助手与审计追加。

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nowIso } from "./time.js";
import type { AuditEventRow } from "./types.js";

export function openDatabase(databasePath: string): DatabaseSync {
  if (databasePath !== ":memory:") {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export function applyMigrations(db: DatabaseSync, migrationsDir: string): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: string }>).map(
      (r) => r.version,
    ),
  );
  const done: string[] = [];
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
      db.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)").run(version);
      db.exec("COMMIT");
      done.push(version);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return done;
}

let idCounter = 0;

/** 单调短 id：时间基 + 进程内序号，便于按 id 排序近似时间序 */
export function newId(prefix: string): string {
  idCounter = (idCounter + 1) % 0xffff;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36).padStart(3, "0")}${Math.floor(
    Math.random() * 0xffff,
  )
    .toString(36)
    .padStart(3, "0")}`;
}

export function get<T>(db: DatabaseSync, sql: string, ...params: unknown[]): T | null {
  const row = db.prepare(sql).get(...(params as never[]));
  return (row ?? null) as T | null;
}

export function all<T>(db: DatabaseSync, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

export function run(db: DatabaseSync, sql: string, ...params: unknown[]): void {
  db.prepare(sql).run(...(params as never[]));
}

/** 事务包装：嵌套调用复用外层事务 */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  const inTx = (db as unknown as { __inTx?: boolean }).__inTx === true;
  if (inTx) return fn();
  (db as unknown as { __inTx?: boolean }).__inTx = true;
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    (db as unknown as { __inTx?: boolean }).__inTx = false;
  }
}

export function audit(
  db: DatabaseSync,
  entry: {
    cooperation_ref?: string | null;
    actor_party?: string | null;
    action: string;
    entity_type: string;
    entity_id?: string | null;
    payload?: unknown;
  },
): void {
  run(
    db,
    `INSERT INTO audit_events (id, cooperation_ref, actor_party, action, entity_type, entity_id, payload_json, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    newId("aud"),
    entry.cooperation_ref ?? null,
    entry.actor_party ?? null,
    entry.action,
    entry.entity_type,
    entry.entity_id ?? null,
    entry.payload === undefined ? null : JSON.stringify(entry.payload),
    nowIso(),
  );
}

export function listAudit(db: DatabaseSync, cooperationRef: string): AuditEventRow[] {
  return all<AuditEventRow>(
    db,
    "SELECT * FROM audit_events WHERE cooperation_ref = ? ORDER BY occurred_at, id",
    cooperationRef,
  );
}
