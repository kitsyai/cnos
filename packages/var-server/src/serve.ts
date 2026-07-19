import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { varServer, type VarServerOptions } from './httpServer.js';
import type { VarStore } from './types.js';

export interface ServeVarServerOptions extends VarServerOptions {
  host?: string;
  /** Port to listen on; `0` (default) picks a random free port. */
  port?: number;
}

export interface RunningVarServer {
  server: Server;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

/**
 * Thin standalone wrapper: mounts {@link varServer} on a fresh `http.createServer` and
 * starts listening. This backs `cnos var serve` and the testkit's ephemeral server. One
 * server implementation total — standalone vs embedded is a packaging choice.
 */
export async function serveVarServer(store: VarStore, options: ServeVarServerOptions = {}): Promise<RunningVarServer> {
  const host = options.host ?? '127.0.0.1';
  const base = options.base ?? '/cnos/vars';
  const handler = varServer(store, options);
  const server = createServer(handler);

  server.listen(options.port ?? 0, host);
  await once(server, 'listening');

  const address = server.address() as AddressInfo;
  const port = address.port;
  const url = `http://${host}:${port}${base}`;

  return {
    server,
    host,
    port,
    url,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
