
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const databasePath = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.sqlite3");
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);

database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
`);

const migrationsDir = path.join(process.cwd(), "migrations");
const applied = new Set(database.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version));
const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();

for (const file of files) {
  const version = file.replace(/\.sql$/, "");
  if (applied.has(version)) continue;
  database.exec("BEGIN");
  try {
    database.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
    database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)").run(version);
    database.exec("COMMIT");
    console.log(`应用迁移：${version}`);
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

database.close();
console.log(`数据库迁移完成：${databasePath}`);
