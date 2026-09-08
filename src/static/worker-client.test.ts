import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StaticOverview } from './contract';
import { STATIC_SCHEMA_VERSION } from './contract';
import { StaticWorkerClient } from './worker-client';

const overview: StaticOverview = { schemaVersion: STATIC_SCHEMA_VERSION, cellSizeDegrees: .25, cells: {} };

class RecoverableWorker {
  static instances: RecoverableWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  constructor() { RecoverableWorker.instances.push(this); }

  postMessage(message: { id: number }): void {
    queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true, value: true } } as MessageEvent));
  }

  terminate(): void { /* fixture worker */ }
}

describe('static worker recovery', () => {
  afterEach(() => { RecoverableWorker.instances = []; vi.unstubAllGlobals(); });

  it('reinitializes the replacement worker after a worker crash', async () => {
    vi.stubGlobal('Worker', RecoverableWorker);
    const client = new StaticWorkerClient();
    await client.initialize(overview);
    expect(client.isInitialized).toBe(true);

    RecoverableWorker.instances[0]?.onerror?.({ message: 'fixture crash' } as ErrorEvent);
    expect(client.isInitialized).toBe(false);

    await client.initialize(overview);
    expect(RecoverableWorker.instances).toHaveLength(2);
    expect(client.isInitialized).toBe(true);
    client.dispose();
  });
});
