'use client'

import { RemindMeDialog } from './RemindMeDialog'

/**
 * A design-review case of SCR-543: the Remind me pop-up (the docked thread's Head door and each message's own Remind me open it;
 * B-TH-280: the old record panels' "Reminders I set" beside Follow went — the Head says the next reminder, Home lists them all).
 */
export interface RemindMeCaseModel {
  readonly dialog: { readonly what: string; readonly aboutMessage: boolean; readonly now: number; readonly held: string | null; readonly problem: string | null }
}

export function RemindMeCase({ model }: { model: RemindMeCaseModel }) {
  return <RemindMeDialog {...model.dialog} onSet={() => Promise.resolve(true)} onClose={() => undefined} />
}
