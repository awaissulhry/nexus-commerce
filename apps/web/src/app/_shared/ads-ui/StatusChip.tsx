/** Shared campaign/entity status pill with a state dot. Replaces the
 *  STATUS_CHIP maps copied across advertising clients. */

const TONE: Record<string, { chip: string; dot: string }> = {
  ENABLED: { chip: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300', dot: 'bg-emerald-500' },
  ACTIVE: { chip: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300', dot: 'bg-emerald-500' },
  PAUSED: { chip: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300', dot: 'bg-amber-500' },
  ARCHIVED: { chip: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400', dot: 'bg-slate-400' },
  DRAFT: { chip: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300', dot: 'bg-slate-400' },
}

export function StatusChip({ status, dot = true }: { status: string; dot?: boolean }) {
  const t = TONE[status?.toUpperCase()] ?? TONE.DRAFT
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs ${t.chip}`}>
      {dot && <span className={`w-1.5 h-1.5 rounded-full ${t.dot}`} />}
      {status}
    </span>
  )
}
