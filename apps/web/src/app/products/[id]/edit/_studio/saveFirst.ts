import type { StudioSaveState } from './types'

/**
 * Step 4 (D3, 2026-10-01) — ONE "save your edits first" notice. Import said "Finish saving your edits in the sheet first.
 * Then apply." as a warning; Publish said "Save your changes first" (danger) or "Waiting for changes to save" (info).
 * Both dialogs now show the same title, tone and sentence for the same state, and only say what continues afterwards.
 */
export interface SaveFirstNotice { tone: 'info' | 'danger'; title: string; body: string }

/** `next` is what the dialog does once the edits are saved: "You can apply this file", "The review loads". */
export function saveFirstNotice(save: StudioSaveState, next: string): SaveFirstNotice | null {
  if (save.kind === 'saving') return { tone: 'info', title: 'Saving your edits', body: `${next} when they are saved.` }
  if (save.kind === 'error') return { tone: 'danger', title: 'Your edits are not saved', body: `${save.message} ${next} when they are saved.` }
  return null
}
