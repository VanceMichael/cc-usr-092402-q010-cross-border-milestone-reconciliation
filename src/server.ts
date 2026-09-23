
import http, { IncomingMessage, ServerResponse } from "node:http";

export function createServer(): http.Server {
  return http.createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
}

if (process.argv[1]?.endsWith("/server.js")) {
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  createServer().listen(port, "0.0.0.0");
}
