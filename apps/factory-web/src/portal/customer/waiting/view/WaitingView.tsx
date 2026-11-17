'use client'

import { AlertCircle } from 'lucide-react'
import type { ApprovalDecision } from '@nexus/factory-domain/approvals-out/kinds'
import { Banner } from '@nexus/ui/components'
import { ActionList, type ActionGroup } from '@nexus/ui/patterns/ActionList/index'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatNumber } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ApproveDialog, type ApproveActions, type ApproveDialogModel } from '../../home/view/ApproveDialog'
import { doneWordsOf, NS, type WaitingGroupRows, type WaitingRow } from '../model'
import '../waiting.css'

/**
 * F-PR-14 — Home › Waiting for you (production plan §5; 06-tree B.3; 09-design (f)): the ONE place the customer answers — the
 * groups (Production approvals, Order, Quality, Made-to-measure, Payment), each row its request, who asked, the due (overdue
 * first; a live countdown today and soon) and ONE verb: Review opens the answer dialog (Approve · Approve with changes · Refuse,
 * a refusal says why; signed with the typed name; it goes to us after 10 seconds, Undo until then), View reads a request another
 * colleague answers ("Waiting for Anna", "Waiting for your buyer"), Pay opens To pay. A failed read is never drawn as empty.
 */

export interface WaitingViewModel {
  state: 'loading' | 'error' | 'ready'
  groups: readonly WaitingGroupRows[]
  /** Rows answered here just now: waiting to go (Undo), going, gone. */
  done: Readonly<Record<string, { phase: 'pending' | 'sending' | 'sent'; decision: ApprovalDecision }>>
  /** One line at the top (a key of `portal-waiting`). */
  notice: { tone: 'success' | 'info' | 'warning' | 'danger'; key: string; params?: Readonly<Record<string, string | number>> } | null
  /** The answer dialog (the Approve pop-up of Home, with the Undo window). */
  dialog: ApproveDialogModel | null
  /** The read's clock (the countdowns of a design case or a test). */
  now?: number
}

export interface WaitingViewActions {
  onOpen?: (row: WaitingRow) => void
  onUndo?: (id: string) => void
  onRetry?: () => void
  onDismissNotice?: () => void
  dialog?: ApproveActions
}

export function WaitingView({ model, actions }: { model: WaitingViewModel; actions?: WaitingViewActions }) {
  const t = useT(NS)
  const locale = useLocale()
  const ds = useDsWords()
  const money = (minor: number, currency: string) => formatNumber(minor / 100, locale, { style: 'currency', currency })
  const metaOf = (row: WaitingRow): string | undefined => {
    if (row.heldFor?.kind === 'person') return t('heldFor.person', { name: row.heldFor.name })
    if (row.heldFor?.kind === 'buyer') return t('heldFor.buyer')
    if (row.amount) return t('amount', { amount: money(row.amount.minor, row.amount.currency) })
    return row.askedBy ? t('askedBy', { name: row.askedBy }) : undefined
  }
  const groups: ActionGroup[] = model.groups.map((entry) => ({
    id: entry.group,
    label: t(`group.${entry.group}`),
    items: entry.rows.map((row) => {
      const done = model.done[row.id]
      return {
        id: row.id,
        title: t(row.title.key, { label: row.title.label }),
        meta: metaOf(row),
        due: row.due ? { at: row.due.at, state: row.due.state, text: formatDate(row.due.at, { locale }) } : null,
        verb:
          row.verb.act === 'link'
            ? { label: t(row.verb.key), kind: 'link' as const, href: row.verb.href }
            : { label: t(row.verb.key), kind: 'dialog' as const, onRun: () => actions?.onOpen?.(row) },
        done: done
          ? {
              words: t(doneWordsOf(done), { label: row.title.label }),
              ...(done.phase === 'pending' ? { onUndo: () => actions?.onUndo?.(row.id) } : {}),
              undoHeldReason: done.phase === 'sending' ? t('done.sending') : null,
            }
          : null,
      }
    }),
  }))
  return (
    <div className="fw-pwait">
      {model.notice ? (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('notice.hide')}
            </Button>
          }
        />
      ) : null}
      {model.state === 'loading' ? (
        <div className="fw-pwait-loading" role="status" aria-label={t('loading')}>
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} height={64} />
          ))}
        </div>
      ) : model.state === 'error' ? (
        <div className="fw-pstate" role="alert">
          <AlertCircle size={18} aria-hidden />
          <span>{t('failed')}</span>
          {actions?.onRetry ? <Button onClick={actions.onRetry}>{t('retry')}</Button> : null}
        </div>
      ) : (
        <section className="fw-pwait-groups" aria-label={t('page.title')}>
          <ActionList groups={groups} headingLevel={2} empty={t('empty')} labels={ds.actionList} countdownLabels={ds.countdown} now={model.now} />
        </section>
      )}
      {model.dialog ? <ApproveDialog model={model.dialog} actions={actions?.dialog} /> : null}
    </div>
  )
}
