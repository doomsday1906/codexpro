import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve('.');
const authToken = 'M004_AUTH_SENTINEL_8d5f1c2a';
const requestBodyMarker = 'M004_REQUEST_BODY_SENTINEL_6a9c7e1b';
const tunnelSecret = 'M004_TUNNEL_SECRET_SENTINEL_3f2b8a7d';

process.env.CODEXPRO_TUNNEL_SECRET = tunnelSecret;
process.env.CODEXPRO_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-m004-diagnostic-context-'));
process.env.CODEXPRO_ALLOWED_ROOTS = process.env.CODEXPRO_ROOT;
process.env.CODEXPRO_HOST = '127.0.0.1';
process.env.CODEXPRO_TOOL_MODE = 'full';
process.env.CODEXPRO_BASH_MODE = 'off';
process.env.CODEXPRO_WRITE_MODE = 'off';
process.env.CODEXPRO_TOOL_CARDS = '0';
process.env.CODEXPRO_ALLOW_NO_HTTP_TOKEN = '0';
process.env.CODEXPRO_HTTP_TOKEN = authToken;

const { loadConfig } = await import('../dist/config.js');
const { createCodexProHttpApp } = await import('../dist/http.js');

const root = process.env.CODEXPRO_ROOT;
const baseConfig = loadConfig();

function testConfig(overrides = {}) {
  return {
    ...baseConfig,
    defaultRoot: root,
    allowedRoots: [root],
    host: '127.0.0.1',
    authToken,
    requireHttpToken: true,
    ...overrides
  };
}

function authHeaders(extra = {}) {
  return {
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${authToken}`,
    ...extra
  };
}

function initializeBody(id) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: requestBodyMarker, version: '0.0.0' }
    }
  };
}

async function listenWithContexts(config, contexts) {
  const callbackPids = [];
  const app = createCodexProHttpApp(config, {
    onDiagnosticContext: (context) => {
      callbackPids.push(process.pid);
      contexts.push(context);
    }
  });
  const listener = await new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
  const address = listener.address();
  assert.equal(typeof address, 'object');
  assert(address?.port, 'test HTTP listener did not expose a port');
  return { listener, baseUrl: `http://127.0.0.1:${address.port}`, callbackPids };
}

async function initialize(baseUrl, id) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(initializeBody(id))
  });
  const body = await response.text();
  const sessionId = response.headers.get('mcp-session-id');
  assert.equal(response.status, 200, `initialize ${id} failed: ${body}`);
  assert.match(sessionId ?? '', /^[0-9a-f-]{36}$/i, `initialize ${id} did not return a UUID session id`);
  assert.match(body, /event: message\ndata: /, `initialize ${id} did not return an SSE envelope`);
  return { response, body, sessionId };
}

async function sessionRequest(baseUrl, sessionId, method = 'tools/list') {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: authHeaders({
      'content-type': 'application/json',
      'mcp-session-id': sessionId
    }),
    body: JSON.stringify({ jsonrpc: '2.0', id: 100, method, params: {} })
  });
  return { response, body: await response.text() };
}

async function closeSession(baseUrl, sessionId) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'DELETE',
    headers: authHeaders({ 'mcp-session-id': sessionId })
  });
  return { response, body: await response.text() };
}

async function waitFor(predicate, label, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = predicate();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(lastValue)}`);
}

function publicContext(context) {
  return {
    generation: context.generation,
    fingerprint: context.fingerprint,
    transportKind: context.transportKind,
    createdAt: context.createdAt,
    http: context.getHttpSnapshot?.()
  };
}

function assertFrozenSnapshot(snapshot, label) {
  assert.equal(Object.isFrozen(snapshot), true, `${label} snapshot must be frozen`);
  if (snapshot.currentSession) {
    assert.equal(Object.isFrozen(snapshot.currentSession), true, `${label} current session must be frozen`);
  }
  const originalActive = snapshot.active;
  assert.throws(() => {
    snapshot.active = originalActive + 100;
  }, TypeError, `${label} snapshot accepted mutation`);
  assert.equal(snapshot.active, originalActive, `${label} snapshot changed after rejected mutation`);
}

function assertNoSecretOrRoutingLeak(serialized, sessionIds, label) {
  for (const sessionId of sessionIds) {
    assert.equal(serialized.includes(sessionId), false, `${label} contains raw MCP routing id`);
  }
  for (const secret of [authToken, tunnelSecret, requestBodyMarker]) {
    assert.equal(serialized.includes(secret), false, `${label} contains sensitive input ${secret}`);
  }
}

async function closeListener(listener) {
  await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
}

const primaryContexts = [];
const primary = await listenWithContexts(testConfig({ maxHttpSessions: 2, httpSessionTtlMs: 120 }), primaryContexts);
const capacityContexts = [];
const capacity = await listenWithContexts(testConfig({ maxHttpSessions: 1, httpSessionTtlMs: 1_000 }), capacityContexts);

try {
  const sessionA = await initialize(primary.baseUrl, 1);
  assert.equal(primaryContexts.length, 1, 'first real HTTP initialize did not create one context');
  const contextA = primaryContexts[0];
  const contextAIdentity = {
    generation: contextA.generation,
    fingerprint: contextA.fingerprint,
    createdAt: contextA.createdAt
  };
  assert.equal(Object.isFrozen(contextA), true, 'real HTTP diagnostic context is not frozen');
  assert.throws(() => {
    contextA.generation = -1;
  }, TypeError, 'real HTTP diagnostic context accepted mutation');

  const firstA = contextA.getHttpSnapshot?.();
  assert(firstA, 'real HTTP context omitted its snapshot callback');
  assertFrozenSnapshot(firstA, 'session A initial');
  assert.equal(firstA.active, 1);
  assert.equal(firstA.max, 2);
  assert.equal(firstA.ttlMs, 120);
  assert.equal(firstA.totalInitialized, 1);
  assert.equal(firstA.totalClosed, 0);
  assert.equal(firstA.totalExpired, 0);
  assert.equal(firstA.totalCapacityEvicted, 0);
  assert(firstA.currentSession, 'session A snapshot omitted current created/last-seen facts');
  assert(firstA.currentSession.createdAt <= firstA.currentSession.lastSeenAt);
  const firstALastSeen = firstA.currentSession.lastSeenAt;

  const repeatedA = await sessionRequest(primary.baseUrl, sessionA.sessionId);
  assert.equal(repeatedA.response.status, 200, 'same actual HTTP session did not accept repeated request');
  assert.equal(repeatedA.response.headers.get('mcp-session-id'), sessionA.sessionId, 'same session response changed routing id');
  assert.equal(primaryContexts.length, 1, 'same actual HTTP session created a second diagnostic context');
  assert.deepEqual(
    { generation: contextA.generation, fingerprint: contextA.fingerprint, createdAt: contextA.createdAt },
    contextAIdentity,
    'same actual HTTP session changed diagnostic identity'
  );
  const afterRepeatedA = contextA.getHttpSnapshot?.();
  assert(afterRepeatedA?.currentSession);
  assert(afterRepeatedA.currentSession.lastSeenAt >= firstALastSeen, 'same-session HTTP request did not preserve/update lastSeenAt');
  assert.equal(afterRepeatedA.totalInitialized, 1);

  const sessionB = await initialize(primary.baseUrl, 2);
  assert.equal(primaryContexts.length, 2, 'second real HTTP initialize did not create a second context');
  const contextB = primaryContexts[1];
  assert.notEqual(contextA, contextB, 'distinct actual HTTP sessions share a diagnostic context object');
  assert.notEqual(contextA.generation, contextB.generation, 'distinct actual HTTP sessions share diagnostic generation');
  assert.notEqual(contextA.fingerprint, contextB.fingerprint, 'distinct actual HTTP sessions share diagnostic fingerprint');
  assert.equal(primary.callbackPids.every((pid) => pid === process.pid), true, 'A/B contexts were not observed in one process');
  assert.equal(contextA.transportKind, 'http');
  assert.equal(contextB.transportKind, 'http');
  assert.notEqual(contextA.fingerprint, sessionA.sessionId);
  assert.notEqual(contextB.fingerprint, sessionB.sessionId);
  assert.equal(contextA.fingerprint.includes(sessionA.sessionId), false);
  assert.equal(contextB.fingerprint.includes(sessionB.sessionId), false);
  for (const [fingerprint, sessionId] of [[contextA.fingerprint, sessionA.sessionId], [contextB.fingerprint, sessionB.sessionId]]) {
    const obviousDerivations = [
      sessionId,
      sessionId.toLowerCase(),
      sessionId.replaceAll('-', ''),
      Buffer.from(sessionId).toString('base64url')
    ];
    assert.equal(obviousDerivations.includes(fingerprint), false, 'fingerprint matched an obvious reversible routing-id derivation');
  }
  assert.match(contextA.fingerprint, /^[A-Za-z0-9_-]{32}$/);
  assert.match(contextB.fingerprint, /^[A-Za-z0-9_-]{32}$/);

  const secondA = contextA.getHttpSnapshot?.();
  const firstB = contextB.getHttpSnapshot?.();
  assert(secondA && firstB);
  assertFrozenSnapshot(secondA, 'session A with B active');
  assertFrozenSnapshot(firstB, 'session B initial');
  assert.equal(secondA.active, 2);
  assert.equal(secondA.totalInitialized, 2);
  assert.equal(firstB.active, 2);
  assert(firstB.currentSession);

  const bLastSeenBeforeARead = firstB.currentSession.lastSeenAt;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const aRead = contextA.getHttpSnapshot?.();
  const bAfterARead = contextB.getHttpSnapshot?.();
  assert(aRead && bAfterARead?.currentSession);
  assert.equal(bAfterARead.currentSession.lastSeenAt, bLastSeenBeforeARead, 'reading A diagnostics refreshed B lastSeenAt');

  const fingerprintAsRoutingId = await sessionRequest(primary.baseUrl, contextA.fingerprint);
  assert.equal(fingerprintAsRoutingId.response.status, 400, 'diagnostic fingerprint was accepted as a routing id');
  assert.match(fingerprintAsRoutingId.body, /invalid MCP session id/);

  const diagnosticPayloadA = JSON.stringify(publicContext(contextA));
  const diagnosticPayloadB = JSON.stringify(publicContext(contextB));
  assertNoSecretOrRoutingLeak(diagnosticPayloadA, [sessionA.sessionId, sessionB.sessionId], 'session A diagnostic payload');
  assertNoSecretOrRoutingLeak(diagnosticPayloadB, [sessionA.sessionId, sessionB.sessionId], 'session B diagnostic payload');
  assert.equal(JSON.stringify(contextA).includes(sessionA.sessionId), false, 'serialized context contains session A routing id');
  assert.equal(JSON.stringify(contextA).includes(authToken), false, 'serialized context contains auth token');

  let lastARequest;
  for (let index = 0; index < 7; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    lastARequest = await sessionRequest(primary.baseUrl, sessionA.sessionId);
    assert.equal(lastARequest.response.status, 200, `A keep-alive request ${index} failed`);
    assertFrozenSnapshot(contextA.getHttpSnapshot?.(), `session A keep-alive ${index}`);
  }
  await waitFor(() => contextB.getHttpSnapshot?.()?.totalExpired === 1, 'session B TTL expiry');
  const afterExpiryA = contextA.getHttpSnapshot?.();
  const afterExpiryB = contextB.getHttpSnapshot?.();
  assert(afterExpiryA && afterExpiryB);
  assert.equal(afterExpiryA.active, 1, 'A keep-alive did not preserve A while B expired');
  assert(afterExpiryA.currentSession, 'A became inactive while only B should expire');
  assert.equal(afterExpiryB.currentSession, null, 'expired B still reported an active current session');
  assert.equal(afterExpiryB.totalInitialized, 2);
  assert.equal(afterExpiryB.totalClosed, 1);
  assert.equal(afterExpiryB.totalExpired, 1);
  assert.equal(afterExpiryB.totalCapacityEvicted, 0);

  const closeA = await closeSession(primary.baseUrl, sessionA.sessionId);
  assert.equal(closeA.response.status, 200, 'ordinary close of A did not return 200');
  const afterCloseA = await waitFor(() => {
    const snapshot = contextA.getHttpSnapshot?.();
    return snapshot?.totalClosed === 2 ? snapshot : false;
  }, 'session A ordinary close');
  assert.equal(afterCloseA.active, 0);
  assert.equal(afterCloseA.currentSession, null);
  assert.equal(afterCloseA.totalExpired, 1);
  assert.equal(afterCloseA.totalCapacityEvicted, 0);
  assert.equal(afterCloseA.totalClosed, afterCloseA.totalExpired + afterCloseA.totalCapacityEvicted + 1, 'totalClosed superset semantics changed');
  const afterCloseRequest = await sessionRequest(primary.baseUrl, sessionA.sessionId);
  assert.equal(afterCloseRequest.response.status, 404);
  assert.match(afterCloseRequest.body, /Session not found/);

  const sessionC = await initialize(capacity.baseUrl, 3);
  const contextC = capacityContexts[0];
  const sessionD = await initialize(capacity.baseUrl, 4);
  const contextD = capacityContexts[1];
  assert.equal(capacityContexts.length, 2);
  const afterCapacityC = contextC.getHttpSnapshot?.();
  const afterCapacityD = contextD.getHttpSnapshot?.();
  assert(afterCapacityC && afterCapacityD);
  assert.equal(afterCapacityC.active, 1);
  assert.equal(afterCapacityC.currentSession, null, 'capacity-evicted C remained active');
  assert.equal(afterCapacityC.totalInitialized, 2);
  assert.equal(afterCapacityC.totalClosed, 1);
  assert.equal(afterCapacityC.totalExpired, 0);
  assert.equal(afterCapacityC.totalCapacityEvicted, 1);
  assert.equal(afterCapacityD.active, 1);
  assert(afterCapacityD.currentSession);
  const evictedRequest = await sessionRequest(capacity.baseUrl, sessionC.sessionId);
  assert.equal(evictedRequest.response.status, 404, 'capacity-evicted C still routed successfully');
  assert.match(evictedRequest.body, /Session not found/);
  const closeD = await closeSession(capacity.baseUrl, sessionD.sessionId);
  assert.equal(closeD.response.status, 200);
  const afterCloseD = await waitFor(() => {
    const snapshot = contextD.getHttpSnapshot?.();
    return snapshot?.totalClosed === 2 ? snapshot : false;
  }, 'session D ordinary close');
  assert.equal(afterCloseD.active, 0);
  assert.equal(afterCloseD.totalExpired, 0);
  assert.equal(afterCloseD.totalCapacityEvicted, 1);
  assert.equal(afterCloseD.totalClosed, afterCloseD.totalExpired + afterCloseD.totalCapacityEvicted + 1, 'capacity totalClosed superset semantics changed');

  const proof = {
    target: {
      producer: 'createCodexProHttpApp -> real StreamableHTTPServerTransport -> createCodexProServer',
      process_pid: process.pid,
      actual_http_requests: true,
      actual_transport_sessions: true
    },
    same_session: {
      repeated_request_status: repeatedA.response.status,
      repeated_response_session_id_same: repeatedA.response.headers.get('mcp-session-id') === sessionA.sessionId,
      context_object_reused: primaryContexts.length === 2 && contextA === primaryContexts[0],
      initial_generation: contextA.generation,
      initial_fingerprint_length: contextA.fingerprint.length
    },
    distinct_sessions_same_process: {
      distinct_generation: contextA.generation !== contextB.generation,
      distinct_fingerprint: contextA.fingerprint !== contextB.fingerprint,
      same_process: primary.callbackPids.every((pid) => pid === process.pid),
      routing_id_not_equal_or_accepted: fingerprintAsRoutingId.response.status === 400
    },
    raw_diagnostic_serialization: {
      session_ids_absent: !diagnosticPayloadA.includes(sessionA.sessionId) && !diagnosticPayloadB.includes(sessionB.sessionId),
      auth_tunnel_request_body_secrets_absent: [authToken, tunnelSecret, requestBodyMarker].every(
        (secret) => !diagnosticPayloadA.includes(secret) && !diagnosticPayloadB.includes(secret)
      ),
      payload_a: diagnosticPayloadA,
      payload_b: diagnosticPayloadB
    },
    ttl: {
      config_ttl_ms: 120,
      active_after_b_expiry: afterExpiryA.active,
      total_initialized: afterExpiryB.totalInitialized,
      total_closed: afterExpiryB.totalClosed,
      total_expired: afterExpiryB.totalExpired,
      total_capacity_evicted: afterExpiryB.totalCapacityEvicted,
      b_last_seen_unchanged_by_a_read: bAfterARead.currentSession.lastSeenAt === bLastSeenBeforeARead
    },
    capacity: {
      config_max_sessions: 1,
      active_after_eviction: afterCapacityD.active,
      total_initialized: afterCapacityD.totalInitialized,
      total_closed_after_d_close: afterCloseD.totalClosed,
      total_expired: afterCloseD.totalExpired,
      total_capacity_evicted: afterCloseD.totalCapacityEvicted
    },
    snapshot_freeze: true,
    total_closed_is_superset: true,
    raw_envelopes: {
      initialize_a_status: sessionA.response.status,
      initialize_b_status: sessionB.response.status,
      repeated_a_body_bytes: Buffer.byteLength(repeatedA.body),
      fingerprint_routing_probe_status: fingerprintAsRoutingId.response.status,
      closed_a_probe_status: afterCloseRequest.response.status,
      evicted_c_probe_status: evictedRequest.response.status
    }
  };
  console.log(JSON.stringify(proof, null, 2));
  console.log('✓ diagnostic context and HTTP lifecycle smoke test passed');
} finally {
  await closeListener(primary.listener);
  await closeListener(capacity.listener);
  await fs.rm(root, { recursive: true, force: true });
}
