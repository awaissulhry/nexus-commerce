import type { RecordPanelsViewModel } from '../model'

/**
 * B-W2b-05 (PLT-171, design shell.panels tab:print): the record panels for paper — every panel at once (thread, tasks,
 * files, history), as read; nothing to write, upload, close, follow or undo on a sheet, so the abilities that draw those
 * controls are off and the passing states (a notice, a preview, an upload, a dialog) are left out.
 */
export function printPanelsModel(model: RecordPanelsViewModel): RecordPanelsViewModel {
  const { followers: _followers, preview: _preview, ...rest } = model
  return {
    ...rest,
    preview: null,
    can: { ...model.can, post: false, email: false, manage: false, upload: false, share: false },
    notice: null,
    uploads: [],
    sending: false,
    ...(model.tasks ? { tasks: { ...model.tasks, addHeld: null, dialog: null, undo: null, busy: false } } : {}),
  }
}
