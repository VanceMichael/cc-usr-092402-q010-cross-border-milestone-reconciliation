
import path from "node:path";
import http from "node:http";
import { openDatabase } from "./db.js";
import { Store } from "./store.js";
import { createRouter } from "./http.js";

export interface ServerOptions {
  databasePath?: string;
  clock?: () => number;
}

export function createServer(options: ServerOptions = {}): http.Server {
  const databasePath = options.databasePath ?? process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "app.sqlite3");
  const db = openDatabase(databasePath);
  const store = new Store(db, { clock: options.clock });
  return http.createServer(createRouter(store));
}

if (process.argv[1]?.endsWith("/server.js")) {
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  createServer().listen(port, "0.0.0.0");
}
