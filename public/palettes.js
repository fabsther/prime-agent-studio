// Shared color palettes for projects, roadmap plans and devices (PCs).
// Plain ESM with no browser or Node dependencies, importable by both
// server lib files and browser public files. Each palette has exactly six
// choices with "transparent" first, meaning default or reset.
export const ROADMAP_PLAN_COLORS = [
  'transparent',
  '#0d9488',
  '#db2777',
  '#4f46e5',
  '#65a30d',
  '#ea580c',
];
export const DEVICE_COLORS = [
  'transparent',
  '#0891b2',
  '#ca8a04',
  '#c026d3',
  '#64748b',
  '#92400e',
];
function normalizePaletteColor(value, palette) {
  if (value === undefined) return undefined;
  if (value === '' || value === 'transparent') return '';
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase();
  if (palette.slice(1).includes(normalized)) return normalized;
  return null;
}
// Trust boundary validators. Returns "" for default, vivid hex for a swatch,
// null for an invalid value, undefined when the key is absent.
export function normalizePlanColor(value) {
  return normalizePaletteColor(value, ROADMAP_PLAN_COLORS);
}
export function normalizeDeviceColor(value) {
  return normalizePaletteColor(value, DEVICE_COLORS);
}
