import { spawnSync } from "node:child_process";

// Read-only engine contract discovery. This does not list resident session
// contents or perform eviction, deletion, or lifecycle close.
const requested = new Set([
  "debug.location.list", "debug.location.evict", "session.list",
  "session.get", "session.remove", "experimental.session.export"
]);
const result = spawnSync("opencode", ["api", "GET", "/openapi.json"], {
  encoding: "utf8", timeout: 12000, maxBuffer: 8 * 1024 * 1024
});
if (result.error || result.status !== 0) {
  throw new Error("engine catalog request failed; status=" + result.status);
}
const doc = JSON.parse(result.stdout);
const operations = [];
for (const [route, methods] of Object.entries(doc.paths ?? {})) {
  for (const [method, spec] of Object.entries(methods ?? {})) {
    if (!requested.has(spec?.operationId)) continue;
    operations.push({
      route, method, operationId: spec.operationId,
      parameters: spec.parameters,
      requestBody: spec.requestBody,
      responseSchema: spec.responses?.["200"]?.content?.["application/json"]?.schema
    });
  }
}
operations.sort((a, b) => a.operationId.localeCompare(b.operationId));
const found = new Set(operations.map((item) => item.operationId));
const missing = [...requested].filter((name) => !found.has(name));
process.stdout.write(JSON.stringify({
  catalogVersion: doc.info?.version,
  operations,
  sessionsResponse: doc.components?.schemas?.SessionsResponse,
  missing
}, null, 2) + "\n");
if (missing.length) process.exitCode = 1;
