/**
 * KeyValue root props (CX.2) — the one decision the `<dl>` makes, kept out of the .tsx so it is
 * testable in apps/web's node-only vitest.
 */
export type KeyValueColumns = 1 | 2 | 3

export interface KeyValueRootProps {
  className: string
  'data-columns': KeyValueColumns
}

/**
 * How the terms are written: `upper` (default, the CX.2 small caps: "CHANGES 7 D") or `sentence` (as given, sentence
 * case: "Changes 7 d" — polish round 2, the Bid page's detail rail).
 */
export type KeyValueLabelCase = 'upper' | 'sentence'

export function keyValueRootProps(opts: { columns?: KeyValueColumns; dense?: boolean; className?: string; labelCase?: KeyValueLabelCase }): KeyValueRootProps {
  return {
    className: `nds-kv${opts.dense ? ' dense' : ''}${opts.labelCase === 'sentence' ? ' sentence' : ''}${opts.className ? ` ${opts.className}` : ''}`,
    'data-columns': opts.columns ?? 1,
  }
}

/** A hint renders for any value React would print — `null`, `undefined` and `false` are "no hint". */
export function hasHint(hint: unknown): boolean {
  return hint !== null && hint !== undefined && hint !== false
}
