/**
 * `LawRef`'s words (B-W2b-28). English by default; a host passes the words it translates. The law's name and its plain
 * words are the app's (they come with each rule).
 */
export interface LawRefLabels {
  /** The chip's name for a screen reader: "D.Lgs. 81/2008 art. 37 — what it says". */
  about: (law: string) => string
  /** The link to the official text. */
  official: string
  /** Said after a link that opens a new tab. */
  newTab: string
}

export const LAW_REF_LABELS: LawRefLabels = {
  about: (law) => `${law} — what it says`,
  official: 'Official text',
  newTab: 'opens in a new tab',
}
