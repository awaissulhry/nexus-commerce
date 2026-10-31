/** `JobProgress`'s words (B-W2b-04). English by default. */
export interface JobProgressLabels {
  /** The elapsed clock's accessible name: "1 min 3 s elapsed". */
  elapsed: (time: string) => string
}

export const JOB_PROGRESS_LABELS: JobProgressLabels = {
  elapsed: (time) => `${time} elapsed`,
}
