/** `FileDropzone`'s words (B-W2b-04): the prompt, the default hint and the refusals. English by default; `hint` wins. */
export interface FileDropzoneLabels {
  /** The big line inside the zone. */
  prompt: string
  /** A file of a type the zone does not take: "Unsupported file — accepts .csv, .xlsx." */
  unsupported: (accepts: string) => string
  /** What `unsupported` names when the zone takes any type (only a size limit refused the file). */
  anyType: string
  /** A file over the size limit: "\"big.pdf\" is too large — max 5MB." */
  tooLarge: (name: string, max: string) => string
  /** The default hint with types and a limit: ".csv, .xlsx · up to 5MB". */
  hintWithSize: (accepts: string, max: string) => string
  /** The default hint with a limit only: "Up to 5MB". */
  hintSizeOnly: (max: string) => string
}

export const FILE_DROPZONE_LABELS: FileDropzoneLabels = {
  prompt: 'Drag & drop or click to upload',
  unsupported: (accepts) => `Unsupported file — accepts ${accepts}.`,
  anyType: 'any type',
  tooLarge: (name, max) => `"${name}" is too large — max ${max}.`,
  hintWithSize: (accepts, max) => `${accepts} · up to ${max}`,
  hintSizeOnly: (max) => `Up to ${max}`,
}
