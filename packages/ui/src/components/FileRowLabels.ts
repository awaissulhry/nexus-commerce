/**
 * `FileRow`'s words (B-W2b-09): its own two actions. English by default; a host passes the words it translates
 * (`labels={{ replace: 'Sostituisci file', remove: 'Rimuovi file' }}`). The app's own actions (`actions`) bring
 * their own words.
 */
export interface FileRowLabels {
  /** The ghost button that picks another file. */
  replace: string
  /** The × button's name. */
  remove: string
}

export const FILE_ROW_LABELS: FileRowLabels = {
  replace: 'Replace file',
  remove: 'Remove file',
}
