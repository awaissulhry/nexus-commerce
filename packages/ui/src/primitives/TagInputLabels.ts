/** `TagInput`'s words (B-W2b-F41). English by default; `placeholder` still wins over `add`. */
export interface TagInputLabels {
  /** The field's empty text (when no `placeholder` is passed): "Add value…". */
  add: string
  /** A chip's remove button: "Remove M". */
  remove: (tag: string) => string
}

export const TAG_INPUT_LABELS: TagInputLabels = {
  add: 'Add value…',
  remove: (tag) => `Remove ${tag}`,
}
