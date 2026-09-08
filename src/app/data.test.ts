import { describe, expect, it } from 'vitest';
import { queryString, type QueryOptions } from './data';
import { parseZoomParam, retryableSchoolOffset } from './uiState';

const filters: QueryOptions['filters'] = {
  years: [2025, 2021],
  authorities: ['E06000022'],
  country: 'England',
  severities: ['fatal', 'serious'],
  pedestrian: 'yes',
  cycle: 'all',
  motorcycle: 'unknown',
};

describe('national API query serialization', () => {
  it('serializes shareable filters and bounded map state', () => {
    const params = new URLSearchParams(queryString({ filters, bbox: { west: -3, south: 51, east: -2, north: 52 }, zoom: 11, radiusMetres: 100, harmFilter: 'ksi', schoolDistanceMetres: 500 }));
    expect(params.get('years')).toBe('2025,2021');
    expect(params.get('authorities')).toBe('E06000022');
    expect(params.get('country')).toBe('England');
    expect(params.get('bbox')).toBe('-3,51,-2,52');
    expect(params.get('zoom')).toBe('11');
    expect(params.get('harm')).toBe('ksi');
    expect(params.get('schoolDistance')).toBe('500');
    expect(params.get('cycle')).toBeNull();
  });

  it('omits defaults so an unfiltered national view has a stable short URL', () => {
    expect(queryString({ filters: { years: [], authorities: [], severities: [], pedestrian: 'all', cycle: 'all', motorcycle: 'all' } })).toBe('');
  });

  it('rounds MapLibre fractional zoom to the Worker integer contract', () => {
    const params = new URLSearchParams(queryString({ filters: { years: [], authorities: [], severities: [], pedestrian: 'all', cycle: 'all', motorcycle: 'all' }, zoom: 10.6 }));
    expect(params.get('zoom')).toBe('11');
  });

  it('keeps an absent share URL zoom at the app default', () => {
    expect(parseZoomParam(null)).toBeUndefined();
    expect(parseZoomParam('')).toBeUndefined();
    expect(parseZoomParam('0')).toBe(0);
    expect(parseZoomParam('5')).toBe(5);
  });

  it('retries a failed school page before advancing again', () => {
    expect(retryableSchoolOffset(400, 200)).toBe(200);
    expect(retryableSchoolOffset(200, 200)).toBe(200);
    expect(retryableSchoolOffset(400, null)).toBe(400);
  });
});
