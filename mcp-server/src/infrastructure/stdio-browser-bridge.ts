import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from './logger.js';
import { DomSnapshotStore } from './dom-snapshot-store.js';
import { createDomSnapshotRoutes } from './dom-snapshot-routes.js';

const LOOPBACK_ADDRESS = '127.0.0.1';

export interface StdioBrowserBridge {
  store: DomSnapshotStore;
  publicBaseUrl: string;
  address: string;
  port: number;
  close(): Promise<void>;
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

export async function startStdioBrowserBridge(logger: Logger): Promise<StdioBrowserBridge> {
  const store = new DomSnapshotStore();
  const app = express();
  app.use('/api/dom-snapshots', createDomSnapshotRoutes({ store, logger }));

  const server = app.listen(0, LOOPBACK_ADDRESS);
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.once('listening', () => {
      server.off('error', onError);
      resolve();
    });
  });

  const info = server.address() as AddressInfo;
  return {
    store,
    publicBaseUrl: `http://${LOOPBACK_ADDRESS}:${info.port}`,
    address: info.address,
    port: info.port,
    close: () => closeServer(server),
  };
}
