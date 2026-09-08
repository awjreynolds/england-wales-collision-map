import type { Severity } from './model';

export const AUTHORITIES = [
  'Bristol',
  'Bath and North East Somerset',
  'South Gloucestershire',
  'North Somerset',
] as const;

export const AUTHORITY_LABELS: Record<string, string> = {
  Bristol: 'Bristol',
  'Bath and North East Somerset': 'Bath & North East Somerset',
  'South Gloucestershire': 'South Gloucestershire',
  'North Somerset': 'North Somerset',
};

export const SEVERITY_STYLES: Record<Severity, { label: string; colour: string; softColour: string }> = {
  fatal: { label: 'Fatal collision', colour: '#b42318', softColour: '#fee4e2' },
  serious: { label: 'Serious collision', colour: '#d97706', softColour: '#ffedd5' },
  slight: { label: 'Slight collision', colour: '#0f766e', softColour: '#ccfbf1' },
  unknown: { label: 'Severity not recorded', colour: '#64748b', softColour: '#e2e8f0' },
};

export const OBSERVATORY_CONFIG = {
  title: 'West of England Road Collision Observatory',
  subtitle:
    'Reported road injury collisions across Bristol, Bath & North East Somerset, South Gloucestershire and North Somerset',
  map: {
    centre: [-2.65, 51.47] as [number, number],
    zoom: 9,
    minZoom: 7,
    maxZoom: 18,
  },
  grouping: {
    defaultRadiusMetres: 100,
    minCollisions: 3,
    minYears: 2,
    maxRadiusMetres: 500,
  },
  mapAttribution: '© OpenStreetMap contributors',
} as const;

export const SEVERITY_ORDER: Severity[] = ['fatal', 'serious', 'slight', 'unknown'];
