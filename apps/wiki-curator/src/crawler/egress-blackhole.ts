import { createServer, type Server, type Socket } from 'node:net';

/**
 * Fail-closed egress backstop for Tier 2. Chromium is launched with this loopback listener as its ONLY
 * proxy (implicit loopback bypass removed), so any socket Chromium tries to open on its own (anything our
 * `context.route` layer did not fulfil: TURN over TCP/TLS, preconnects, a WebSocket missed by
 * routeWebSocket, a worker's request, ...) lands here and is dropped without a byte being forwarded.
 * Every such attempt is counted; a non-zero count means a containment layer above was bypassed.
 */
export class EgressBlackhole {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private attempts = 0;

  /** Connection attempts that reached the backstop since start. */
  get blockedConnections(): number {
    return this.attempts;
  }

  async start(): Promise<number> {
    const server = createServer((socket) => {
      this.attempts += 1;
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('error', () => undefined);
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('egress blackhole has no TCP port');
    return address.port;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
