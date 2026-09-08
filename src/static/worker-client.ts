import type { AnalysisPayload, BBox, QueryFilters, SummaryMetrics, ViewPayload } from '../../service/contract';
import type { StaticCollisionRecord, StaticOverview, StaticSchoolRecord } from './contract';
import type { RequestMessage, ResponseMessage } from './worker';

type WorkerValue = SummaryMetrics | ViewPayload | AnalysisPayload | StaticSchoolRecord[] | boolean;
type WorkerRequestPayload<T> = T extends { id: number } ? Omit<T, 'id'> : never;
type RequestPayload = WorkerRequestPayload<RequestMessage>;

interface PendingRequest {
  resolve: (value: WorkerValue) => void;
  reject: (error: Error) => void;
}

const abortError = (): Error => Object.assign(new Error('The static data request was aborted.'), { name: 'AbortError' });

/** One dedicated worker owns every expensive filter, aggregate and analysis pass. */
export class StaticWorkerClient {
  private worker: Worker | null = null;
  private initialized = false;
  private sequence = 0;
  private pending = new Map<number, PendingRequest>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined') throw new Error('Web Workers are unavailable; the static national view cannot stay responsive.');
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<ResponseMessage>) => {
      const pending = this.pending.get(event.data.id);
      if (!pending) return;
      this.pending.delete(event.data.id);
      if (event.data.ok) pending.resolve(event.data.value as WorkerValue);
      else pending.reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || 'The static national worker failed.');
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.initialized = false;
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  private request<T extends WorkerValue>(message: RequestPayload, signal?: AbortSignal): Promise<T> {
    const worker = this.ensureWorker();
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        return true;
      };
      const onAbort = (): void => {
        this.pending.delete(id);
        if (finish()) reject(abortError());
      };
      if (signal?.aborted) return onAbort();
      this.pending.set(id, {
        resolve: (value) => { if (finish()) resolve(value as T); },
        reject: (error) => { if (finish()) reject(error); },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.postMessage({ id, ...message });
    });
  }

  initialize(overview: StaticOverview, signal?: AbortSignal): Promise<boolean> {
    return this.request<boolean>({ type: 'init', overview }, signal).then((value) => { this.initialized = true; return value; });
  }

  setSchools(schools: StaticSchoolRecord[], signal?: AbortSignal): Promise<boolean> {
    return this.request<boolean>({ type: 'schools', schools }, signal);
  }

  summary(records: StaticCollisionRecord[], filters: QueryFilters, bbox?: BBox, signal?: AbortSignal): Promise<SummaryMetrics> {
    return this.request<SummaryMetrics>({ type: 'summary', records, filters, bbox }, signal);
  }

  view(records: StaticCollisionRecord[], filters: QueryFilters, bbox?: BBox, zoom?: number, pointRecords?: StaticCollisionRecord[], refineRecords?: StaticCollisionRecord[], signal?: AbortSignal): Promise<ViewPayload> {
    return this.request<ViewPayload>({ type: 'view', records, pointRecords, refineRecords, filters, bbox, zoom }, signal);
  }

  analysis(records: StaticCollisionRecord[], schools: StaticSchoolRecord[], filters: QueryFilters, bbox: BBox, radiusMetres: 50 | 100 | 200 | 500, harmFilter: 'all' | 'ksi' | 'repeated-ksi' | 'slight-only', selectedSchoolId?: string, schoolDistanceMetres?: 500 | 1000, signal?: AbortSignal): Promise<AnalysisPayload> {
    return this.request<AnalysisPayload>({ type: 'analysis', records, schools, filters, bbox, radiusMetres, harmFilter, selectedSchoolId, schoolDistanceMetres }, signal);
  }

  schools(query: string, bbox?: BBox, offset?: number, limit?: number, signal?: AbortSignal): Promise<StaticSchoolRecord[]> {
    return this.request<StaticSchoolRecord[]>({ type: 'schools-query', query, bbox, offset, limit }, signal);
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.initialized = false;
    const error = new Error('The static national worker was disposed.');
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  /** False after a worker crash or dispose, so the runtime can re-send its overview. */
  get isInitialized(): boolean { return this.initialized; }
}
