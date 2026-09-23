
import http from "node:http";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { applyMigrations, openDatabase } from "./repo.js";
import { createRouter } from "./routes.js";

export interface ServerOptions {
  databasePath?: string;
  migrationsDir?: string;
  applySchema?: boolean;
}

export function createServer(options: ServerOptions = {}): http.Server {
  const databasePath =
    options.databasePath ?? process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "app.sqlite3");
  const migrationsDir = options.migrationsDir ?? path.join(process.cwd(), "migrations");
  const db: DatabaseSync = openDatabase(databasePath);
  if (options.applySchema !== false) {
    applyMigrations(db, migrationsDir);
  }
  return http.createServer(createRouter(db));
}

if (process.argv[1]?.endsWith("/server.js")) {
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  createServer().listen(port, "0.0.0.0", () => {
    console.log(`证据对账服务已启动：0.0.0.0:${port}`);
  });
}
