import { type AddressInfo, createServer, type Socket } from 'node:net';
import { expect, it } from 'vitest';
import { runLmspeedAudit } from '../src/compat/lmspeed.js';
import { isPublicAddress } from '../src/protocols/transport.js';
import { FeatureRelay } from './feature-relay.js';

it('user can query the public registry without allowing special-purpose addresses', () => {
  // Given public IANA registry addresses sharing the first two octets with special-purpose networks.
  // A direct address-policy contract avoids sending probes to real private infrastructure.
  const registry = [
    [192, 0, 32, 59],
    [192, 0, 47, 59],
  ].map((octets) => octets.join('.'));
  const special = [
    '192.0.0.1',
    '192.0.2.1',
    '192.168.1.1',
    '198.51.100.1',
    '203.0.113.1',
    '127.0.0.1',
  ];
  // When the hosted audit validates registry and special-purpose destinations.
  const allowed = registry.map(isPublicAddress);
  const blocked = special.map(isPublicAddress);
  // Then actual public registry routes remain usable while reserved destinations stay blocked.
  expect(allowed).toEqual([true, true]);
  expect(blocked).toEqual([false, false, false, false, false, false]);
});

it.each(['oversized', 'empty', 'budget'])(
  'user retains infrastructure failures without inventing WHOIS evidence for %s',
  async (mode) => {
    // Given a real entry point and a WHOIS server with an oversized or absent registration response.
    // The TCP fixture tests protocol and resource limits; authoritative registry equivalence is not claimed.
    const relay = new FeatureRelay();
    const baseUrl = await relay.start();
    let received = false;
    const server = createServer((socket) => {
      socket.once('data', () => {
        received = true;
        socket.end(
          mode === 'oversized' ? 'x'.repeat(512) : 'No matching domain'
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    try {
      // When the user collects infrastructure under a byte or shared request cap.
      const report = await runLmspeedAudit(
        {
          baseUrl,
          modelId: 'test-model',
          apiKey: 'infrastructure-private-key',
        },
        {
          networkPolicy: 'local',
          stepIds: ['infrastructure_recon'],
          limits: {
            maxResponseBytes: 256,
            maxRequests: mode === 'budget' ? 1 : 20,
          },
          infrastructure: {
            whoisServer: {
              host: '127.0.0.1',
              port: (server.address() as AddressInfo).port,
            },
          },
        }
      );
      // Then missing evidence is explicit, and no WHOIS traffic escapes an exhausted request budget.
      const whois = report.steps[0]!.tests.find(
        (test) => test.id === 'whois_lookup'
      );
      expect(whois?.severity).toBe('unknown');
      expect(whois?.evidenceEn).toContain(
        mode === 'oversized'
          ? 'byte budget exceeded'
          : mode === 'empty'
            ? 'no domain registration fields'
            : 'request budget exceeded'
      );
      expect(received).toBe(mode !== 'budget');
      expect(
        report.steps[0]!.tests.find(
          (test) => test.id === 'endpoint_reachability'
        )?.status
      ).toBe('passed');
    } finally {
      await relay.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
);

it('user cancels WHOIS collection without leaving the socket running', async () => {
  // Given a WHOIS endpoint that accepts the query but never completes its response.
  const relay = new FeatureRelay();
  const baseUrl = await relay.start();
  const controller = new AbortController();
  let queryReceived!: () => void;
  const query = new Promise<void>((resolve) => {
    queryReceived = resolve;
  });
  let connectionClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    connectionClosed = resolve;
  });
  const connections = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    connections.add(socket);
    socket.once('data', queryReceived);
    socket.once('end', () => socket.end());
    socket.once('close', () => {
      connections.delete(socket);
      connectionClosed();
    });
    socket.once('error', () => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    // When the user aborts after the actual query reaches the WHOIS server.
    const audit = runLmspeedAudit(
      { baseUrl, modelId: 'test-model', apiKey: 'infrastructure-private-key' },
      {
        networkPolicy: 'local',
        stepIds: ['infrastructure_recon'],
        signal: controller.signal,
        infrastructure: {
          whoisServer: {
            host: '127.0.0.1',
            port: (server.address() as AddressInfo).port,
          },
        },
      }
    );
    await query;
    controller.abort(new Error('User cancelled the audit'));
    // Then cancellation propagates through the SDK rather than returning a completed WHOIS result.
    await expect(audit).rejects.toThrow('User cancelled the audit');
    await closed;
    expect(connections.size).toBe(0);
  } finally {
    for (const socket of connections) socket.destroy();
    await closed;
    await relay.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
