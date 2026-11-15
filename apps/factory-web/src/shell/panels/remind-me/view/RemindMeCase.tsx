'use client'

import { RemindMeDialog } from './RemindMeDialog'
import { RemindersISet, type RemindersISetModel } from './RemindersISet'

/** A design-review case of SCR-543: the record's Remind me part, and the Remind me pop-up open over it (or not). */
export interface RemindMeCaseModel {
  readonly set: RemindersISetModel
  readonly dialog: { readonly what: string; readonly aboutMessage: boolean; readonly now: number; readonly held: string | null; readonly problem: string | null } | null
}

export function RemindMeCase({ model }: { model: RemindMeCaseModel }) {
  return (
    <>
      <RemindersISet model={model.set} />
      {model.dialog && <RemindMeDialog {...model.dialog} onSet={() => Promise.resolve(true)} onClose={() => undefined} />}
    </>
  )
}
