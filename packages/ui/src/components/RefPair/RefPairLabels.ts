/**
 * `RefPair`'s words (B-W2b-155). English by default; a host passes the words it translates. A word with a value in it is a
 * function. The two labels are defaults: a page names its references ("Your PO", "Our order") with `theirsLabel` /
 * `oursLabel`.
 */
export interface RefPairLabels {
  /** The partner's own reference, first: "Your ref.". */
  theirs: string
  /** Ours, second: "Our ref.". */
  ours: string
  /** The copy button's name: "Copy 4500-1234". */
  copy: (value: string) => string
  /** Said after a copy. */
  copied: string
  /** The browser refused the clipboard. */
  copyFailed: string
  /** The two together as one sentence (prints, a screen reader's row name): "Your ref. 4500-1234 · Our ref. SO-0042". */
  pair: (theirs: string, ours: string) => string
}

export const REF_PAIR_LABELS: RefPairLabels = {
  theirs: 'Your ref.',
  ours: 'Our ref.',
  copy: (value) => `Copy ${value}`,
  copied: 'Copied',
  copyFailed: 'Could not copy: select it and copy it by hand',
  pair: (theirs, ours) => `${theirs} · ${ours}`,
}
