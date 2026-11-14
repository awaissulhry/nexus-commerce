import { stepUpRulesWiden } from '@nexus/factory-domain/auth/sessions/lengths'
import type { SecuritySettings, StepUpActionRow } from '../sessions/api'

/**
 * Admin › Security › Actions that ask for a fresh code (SCR-166 section `step-up`, B-W2b-413; design admin.security "Risky
 * actions (PLT-063)": change bank details · give admin · approve above a limit · delete · worker PIN reset …, "the permission
 * behind each"), pure: the draft (which actions are switched off, how many wrong codes lock it, for how long), what changed,
 * whether it widens (factory-domain `stepUpRulesWiden`: switching an action off, more wrong codes or a shorter lock asks a fresh
 * code), and the words of an action and of why one always asks. Words: `admin-security-depth` (`fresh.*`).
 */

export interface StepUpDraft {
  off: string[]
  maxFailures: number
  lockMinutes: number
}

export function stepUpOf(settings: SecuritySettings): StepUpDraft {
  return { off: settings.stepUp.actions.filter((action) => !action.on).map((action) => action.key), maxFailures: settings.stepUp.maxFailures, lockMinutes: settings.stepUp.lockMinutes }
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((key) => b.includes(key))

/** How many things differ from what is in force (each action switched, the failures, the lock). */
export function stepUpChanges(settings: SecuritySettings, draft: StepUpDraft): number {
  const now = stepUpOf(settings)
  const switched = settings.stepUp.actions.filter((action) => now.off.includes(action.key) !== draft.off.includes(action.key)).length
  return switched + Number(draft.maxFailures !== now.maxFailures) + Number(draft.lockMinutes !== now.lockMinutes)
}

export const stepUpDirty = (settings: SecuritySettings, draft: StepUpDraft): boolean => {
  const now = stepUpOf(settings)
  return !sameSet(now.off, draft.off) || draft.maxFailures !== now.maxFailures || draft.lockMinutes !== now.lockMinutes
}

/** Wider: saving asks for a fresh code (the API's own rule). */
export const stepUpWider = (settings: SecuritySettings, draft: StepUpDraft): boolean => {
  const now = stepUpOf(settings)
  return stepUpRulesWiden({ stepUpOff: now.off, stepUpMaxFailures: now.maxFailures, stepUpLockMinutes: now.lockMinutes }, { stepUpOff: draft.off, stepUpMaxFailures: draft.maxFailures, stepUpLockMinutes: draft.lockMinutes })
}

/** The draft with one action asking (on) or not; an action that cannot be switched off stays on. */
export function switched(draft: StepUpDraft, action: Pick<StepUpActionRow, 'key' | 'canSwitchOff'>, on: boolean): StepUpDraft {
  if (!action.canSwitchOff) return draft
  const off = draft.off.filter((key) => key !== action.key)
  return { ...draft, off: on ? off : [...off, action.key] }
}

/** The message key of an action's words (`fresh.action.bankDetails_change`). */
export const actionKey = (key: string) => `fresh.action.${key.replace(/[^A-Za-z0-9]+/g, '_')}`

/** Why an action always asks, a message key (`fresh.fixed.ACCESS`). */
export const fixedKey = (code: NonNullable<StepUpActionRow['fixed']>) => `fresh.fixed.${code}`
