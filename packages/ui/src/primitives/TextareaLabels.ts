import { counterWords, overWords } from './textareaCounter'

/** `Textarea`'s words (B-W2b-04): the counter under a field with a `limit`. English by default; `counterLabel` wins. */
export interface TextareaLabels {
  /** The count: "312 / 500". */
  counter: (used: number, limit: number) => string
  /** Added over the limit: "38 characters too long". */
  tooLong: (over: number) => string
}

export const TEXTAREA_LABELS: TextareaLabels = {
  counter: (used, limit) => counterWords(used, limit),
  tooLong: (over) => overWords(over),
}
