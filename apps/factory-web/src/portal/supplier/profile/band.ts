import type { PortalBand } from '../../shell/frame'

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

/**
 * The frame's band of the supplier's Profile (design portal.supplier.profile h: SaveStatus, the "Changes waiting for our
 * check" pill when any, "Invite a colleague" — the supplier admin's primary, held for anyone else with who can —, ⋯ the
 * frame's "Ask a question"): one builder for the live page and its design cases.
 */
export function profileBandOf(input: { t: Translate; sending: boolean; unsaved: boolean; waiting: boolean; saved: boolean; inviteHeld: string | null; onInvite?: () => void }): PortalBand {
  const { t } = input
  return {
    title: t('profile.title'),
    status: input.sending
      ? { label: t('status.sending'), tone: 'info' }
      : input.unsaved
        ? { label: t('status.unsaved'), tone: 'warning' }
        : input.waiting
          ? { label: t('status.waiting'), tone: 'warning' }
          : input.saved
            ? { label: t('status.saved'), tone: 'success' }
            : null,
    actions: [{ id: 'invite', label: t('profile.users.invite'), variant: 'primary', heldReason: input.inviteHeld, ...(input.onInvite ? { onClick: input.onInvite } : {}) }],
    keys: [
      { keys: ['⌘', 'S'], words: t('keys.send') },
      { keys: ['Esc'], words: t('keys.cancel') },
    ],
  }
}
