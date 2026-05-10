// MC.1.1 — formatters for the DAM hub. Storage units use IEC binary
// prefixes (KiB/MiB/GiB) so a 1 GiB plan is reported truthfully — the
// SI variant (1 GB = 10^9 bytes) drifts ~7% high at the GiB scale,
// which would be confusing once the operator hits storage quotas.

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB']

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B'
  let value = bytes
  let unitIdx = 0
  while (value >= 1024 && unitIdx < UNITS.length - 1) {
    value /= 1024
    unitIdx += 1
  }
  const decimals = unitIdx === 0 ? 0 : value < 10 ? 2 : value < 100 ? 1 : 0
  return `${value.toFixed(decimals)} ${UNITS[unitIdx]}`
}

export function formatCount(value: number): string {
  return value.toLocaleString()
}
