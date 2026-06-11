import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  GrpcAhpClientTransport,
  createGrpcUdsServer,
  grpcUdsAddress,
  type ServerTransport,
} from '../src/index.js';

test('routes JSON-RPC frames over gRPC on a Unix domain socket', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ahp-grpc-'));
  const socketPath = join(directory, 'ahp.sock');
  let resolveServerTransport: (transport: ServerTransport) => void;
  const serverTransportPromise = new Promise<ServerTransport>(resolve => {
    resolveServerTransport = resolve;
  });
  const server = createGrpcUdsServer({
    socketPath,
    onTransport: transport => {
      resolveServerTransport(transport);
    },
  });

  await server.listen();
  assert.equal(grpcUdsAddress(socketPath), `unix://${socketPath}`);

  const client = new GrpcAhpClientTransport({ socketPath });
  await client.ready();
  const serverTransport = await serverTransportPromise;

  await client.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
  const serverFrame = await serverTransport.recv();
  assert.equal(serverFrame?.kind, 'text');
  assert.deepEqual(JSON.parse(serverFrame.kind === 'text' ? serverFrame.text : ''), {
    jsonrpc: '2.0',
    id: 1,
    method: 'ping',
  });

  await serverTransport.send({ jsonrpc: '2.0', id: 1, result: null });
  const frame = await client.recv();
  assert.equal(frame?.kind, 'text');
  assert.deepEqual(JSON.parse(frame.kind === 'text' ? frame.text : ''), {
    jsonrpc: '2.0',
    id: 1,
    result: null,
  });

  client.close();
  await server.close();
  rmSync(directory, { recursive: true, force: true });
});
