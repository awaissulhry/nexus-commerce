import { formatTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import type { PortalBand } from '../../shell/frame'
import type { Job } from './api'
import { jobHref, sheetHref, STATE_TONE, type RecordTab } from './model'

/**
 * The frame's band of the Jobs pages (design portal.supplier.jobs h: AsOf, "Accept new jobs" primary while any wait, ⋯ Ask
 * a question; rec "Job": its link tabs): one builder per page, used by the live page and its design cases alike.
 */

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

export function listBandOf(input: {
  t: Translate
  locale: Locale
  asOf: string | null
  /** Jobs waiting for an answer. */
  toAccept: number
  /** The list shows the New jobs now: the action asks to accept them; else it opens that chip. */
  onNewChip: boolean
  acceptHeld: string | null
  rows: number
  onAccept?: () => void
  onNewJobs?: () => void
  onExport?: () => void
}): PortalBand {
  const { t, locale } = input
  return {
    title: t('list.title'),
    status: input.asOf ? { label: t('band.updated', { time: formatTime(input.asOf, { locale }) }), tone: 'neutral' } : null,
    actions:
      input.toAccept > 0
        ? [
            input.onNewChip
              ? { id: 'accept-new', label: t('band.acceptNew', { count: input.toAccept }), variant: 'primary', heldReason: input.acceptHeld, onClick: () => input.onAccept?.() }
              : { id: 'accept-new', label: t('band.acceptNew', { count: input.toAccept }), variant: 'primary', onClick: () => input.onNewJobs?.() },
          ]
        : [],
    more: [{ id: 'export', label: t('band.export'), disabled: input.rows === 0, description: input.rows === 0 ? t('held.noRows') : undefined, onSelect: () => input.onExport?.() }],
    keys: [
      { keys: ['/'], words: t('keys.search') },
      { keys: ['↵'], words: t('keys.open') },
      { keys: ['j', 'k'], words: t('keys.rows') },
    ],
  }
}

export function jobBandOf(input: {
  t: Translate
  job: Job
  tab: RecordTab
  prefix: string
  acceptHeld: string | null
  declineHeld: string | null
  onAccept?: () => void
  onDecline?: () => void
}): PortalBand {
  const { t, job } = input
  const tabHref = (tab: RecordTab) => jobHref(input.prefix, job.id, tab)
  const answering = job.nextStep === 'ACCEPT'
  const sent = job.kit.lines.filter((line) => line.status === 'SENT').length
  return {
    title: t('record.title', { number: job.number }),
    back: { href: `${input.prefix}/jobs`, label: t('list.title') },
    status: { label: t(`state.${job.state}`), tone: STATE_TONE[job.state] },
    actions: answering ? [{ id: 'accept', label: t('answer.accept'), variant: 'primary', heldReason: input.acceptHeld, onClick: () => input.onAccept?.() }] : [],
    more: [
      ...(answering ? [{ id: 'decline', label: t('answer.declineMore'), disabled: input.declineHeld !== null, description: input.declineHeld ?? undefined, onSelect: () => input.onDecline?.() }] : []),
      { id: 'sheet', label: t('band.sheet'), href: sheetHref(input.prefix, job.id), target: '_blank' as const },
    ],
    tabs: {
      label: t('tabs.label'),
      active: input.tab,
      items: [
        { id: 'kit', label: t('tabs.kit'), count: sent, href: tabHref('kit'), ...(job.nextStep === 'CONFIRM_KIT' ? { badge: t('tabs.toDo') } : {}) },
        { id: 'progress', label: t('tabs.progress'), href: tabHref('progress'), ...(job.nextStep === 'REPORT' ? { badge: t('tabs.toDo') } : {}) },
        { id: 'sendback', label: t('tabs.sendback'), count: job.returns.length, href: tabHref('sendback'), ...(job.nextStep === 'SEND_BACK' ? { badge: t('tabs.toDo') } : {}) },
        { id: 'documents', label: t('tabs.documents'), href: tabHref('documents') },
        { id: 'messages', label: t('tabs.messages'), href: `${tabHref('messages')}#messages` },
      ],
    },
    ask: { type: 'SubcontractOrder', id: job.id, label: job.number },
    keys: [{ keys: ['Esc'], words: t('keys.closeSheet') }],
  }
}
