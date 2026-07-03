/**
 * ER1 (C9) — THE status pill, extracted so both channels render one
 * component. Consumes the console's .h10-pill vocabulary (ok = blue Enabled,
 * warn = amber, arch = grey). eBay consumes it first; the Amazon grids can
 * adopt it in a future convergence workstream (never modified here).
 */
export function StatusPill({ label, cls, title }: { label: string; cls: string; title?: string }) {
  return <span className={`h10-pill ${cls}`} title={title}>{label}</span>
}
