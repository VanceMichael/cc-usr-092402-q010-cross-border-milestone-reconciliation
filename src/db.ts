
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

let warned = false;

export function openDatabase(databasePath: string): DatabaseSync {
  if (!warned) {
    warned = true; // node:sqlite 实验性警告仅提示一次
  }
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

/** 按 migrations 目录顺序应用未执行的迁移（与 scripts/migrate.js 行为一致）。 */
export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((row) => (row as { version: string }).version),
  );
  const migrationsDir = path.join(process.cwd(), "migrations");
  const files = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()
    : [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
      db.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)").run(version);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
