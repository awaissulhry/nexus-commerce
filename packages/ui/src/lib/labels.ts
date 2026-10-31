/**
 * DS words in the person's language (B-W2b-04, 2026-10-31) — the one merge every part's `labels` prop goes through.
 *
 * A part that speaks keeps its English words as defaults (`<PART>_LABELS` in its `*Labels.ts`) and takes an optional
 * `labels` object of the words to replace: the host passes only what it translates. A key left out, or passed as
 * `undefined`, keeps the English word, so a part without `labels` renders exactly what it rendered before.
 */
export function mergeLabels<T extends object>(defaults: T, labels?: Partial<T> | null): T {
  if (!labels) return defaults
  const out = { ...defaults }
  for (const [key, value] of Object.entries(labels)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value
  }
  return out
}

/** A name from a labels map (`presets`, `names`) by its own key, else the part's English name. Own keys only. */
export function labelFor(map: Readonly<Record<string, string>> | undefined, key: string, fallback: string): string {
  return map && Object.prototype.hasOwnProperty.call(map, key) && map[key] !== undefined ? map[key] : fallback
}
