/**
 * KeyValue root props (CX.2) — the one decision the `<dl>` makes, kept out of the .tsx so it is
 * testable in apps/web's node-only vitest.
 */
export type KeyValueColumns = 1 | 2 | 3

export interface KeyValueRootProps {
  className: string
  'data-columns': KeyValueColumns
  /** Set only when a phone keeps two columns (`phoneColumns: 2`); absent = one column below 760px, as before. */
  'data-phone-columns'?: 2
}

/**
 * How the terms are written: `upper` (default, the CX.2 small caps: "CHANGES 7 D") or `sentence` (as given, sentence
 * case: "Changes 7 d" — polish round 2, the Bid page's detail rail).
 */
export type KeyValueLabelCase = 'upper' | 'sentence'

export function keyValueRootProps(opts: { columns?: KeyValueColumns; dense?: boolean; className?: string; labelCase?: KeyValueLabelCase; phoneColumns?: 1 | 2 }): KeyValueRootProps {
  const root: KeyValueRootProps = {
    className: `nds-kv${opts.dense ? ' dense' : ''}${opts.labelCase === 'sentence' ? ' sentence' : ''}${opts.className ? ` ${opts.className}` : ''}`,
    'data-columns': opts.columns ?? 1,
  }
  // Two columns kept on a phone only where there are two or more to keep (a one-column list stays one).
  if (opts.phoneColumns === 2 && (opts.columns ?? 1) > 1) root['data-phone-columns'] = 2
  return root
}

/** A hint renders for any value React would print — `null`, `undefined` and `false` are "no hint". */
export function hasHint(hint: unknown): boolean {
  return hint !== null && hint !== undefined && hint !== false
}
