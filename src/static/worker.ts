import type { BBox, QueryFilters, SummaryMetrics } from '../../service/contract';
import type { StaticCollisionRecord, StaticOverview, StaticSchoolRecord } from './contract';
import { buildAnalysis, buildView, filterSchools, selectCells, summarizeFacets, summarizeRecords, mergeSummaryMetrics } from './engine';

type RequestMessage =
  | { id: number; type: 'init'; overview: StaticOverview }
  | { id: number; type: 'schools'; schools: StaticSchoolRecord[] }
  | { id: number; type: 'summary'; records: StaticCollisionRecord[]; filters: QueryFilters; bbox?: BBox }
  | { id: number; type: 'view'; records: StaticCollisionRecord[]; pointRecords?: StaticCollisionRecord[]; refineRecords?: StaticCollisionRecord[]; filters: QueryFilters; bbox?: BBox; zoom?: number }
  | { id: number; type: 'analysis'; records: StaticCollisionRecord[]; schools: StaticSchoolRecord[]; filters: QueryFilters; bbox: BBox; radiusMetres: 50 | 100 | 200 | 500; harmFilter: 'all' | 'ksi' | 'repeated-ksi' | 'slight-only'; selectedSchoolId?: string; schoolDistanceMetres?: 500 | 1000 }
  | { id: number; type: 'schools-query'; query: string; bbox?: BBox; offset?: number; limit?: number };

type ResponseMessage = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };

let overview: StaticOverview | null = null;
let schools: StaticSchoolRecord[] = [];

const summary = (records: StaticCollisionRecord[], filters: QueryFilters, bbox?: BBox): SummaryMetrics => {
  if (!overview) throw new Error('Static national worker is not initialized.');
  const selection = selectCells(overview, bbox);
  const contained = summarizeFacets(selection.contained, filters);
  const boundary = summarizeRecords(records, filters, bbox);
  return mergeSummaryMetrics(contained, boundary);
};

const handle = (message: RequestMessage): unknown => {
  if (message.type === 'init') {
    overview = message.overview;
    return true;
  }
  if (message.type === 'schools') {
    schools = message.schools;
    return true;
  }
  if (message.type === 'summary') return summary(message.records, message.filters, message.bbox);
  if (message.type === 'view') {
    if (!overview) throw new Error('Static national worker is not initialized.');
    return buildView({ overview, records: message.records, pointRecords: message.pointRecords, refineRecords: message.refineRecords, filters: message.filters, bbox: message.bbox, zoom: message.zoom });
  }
  if (message.type === 'analysis') {
    return buildAnalysis({ records: message.records, schools: message.schools.length ? message.schools : schools, filters: message.filters, bbox: message.bbox, radiusMetres: message.radiusMetres, harmFilter: message.harmFilter, selectedSchoolId: message.selectedSchoolId, schoolDistanceMetres: message.schoolDistanceMetres });
  }
  return filterSchools(schools, message.query, message.bbox, message.offset, message.limit);
};

self.onmessage = (event: MessageEvent<RequestMessage>) => {
  const message = event.data;
  try {
    const response: ResponseMessage = { id: message.id, ok: true, value: handle(message) };
    self.postMessage(response);
  } catch (error) {
    const response: ResponseMessage = { id: message.id, ok: false, error: error instanceof Error ? error.message : 'Static worker request failed.' };
    self.postMessage(response);
  }
};

export type { RequestMessage, ResponseMessage };
