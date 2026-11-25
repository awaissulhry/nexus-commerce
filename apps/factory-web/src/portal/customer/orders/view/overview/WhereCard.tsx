'use client'

import type { ReactNode } from 'react'
import { Banknote, CircleAlert, FileSignature, History, Hourglass, MessageSquareWarning, PauseCircle, ShieldAlert } from 'lucide-react'
import { DetailPopover, Disclosure } from '@nexus/ui/components'
import { MilestoneTracker } from '@nexus/ui/components/MilestoneTracker/index'
import { Button } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { Headline, OverviewCard, Strip, StripSaid, Strips, useOverviewWords } from '../../../../../lib/record-overview/Overview'
import { FreshnessLine } from '../../../../../lib/production/view/FreshnessLine'
import type { ApprovalPage } from '../../api'
import type { WhereModel, WhereStrip } from '../../overview/model'
import { useOrderWords } from '../../words'
import { RevisionReview } from '../Dialogs'
import type { OrderRecordActions } from '../OrderRecordView'

/**
 * pp-w2 (w2.2; 10-design § 5.1) — "Where your order is", the Overview's lead card on the SHARED kit (lib/record-overview): the
 * headline (status, and the stage while in production), the strips — what waits for the customer and what holds the order, most
 * blocking first, ONE door each (Review and confirm · See what waits for you › · Pay the deposit · Ask a question) — then the six
 * order steps (the DS MilestoneTracker, the stage on "In production") and the promise, said ONCE here, with "Date moved ×n" and its
 * history in a popover (it opens itself: the band's item went). Its words come built (overview/model.ts whereOf).
 */
export function WhereCard({ model, page, actions }: { model: WhereModel; page: ApprovalPage | null; actions?: OrderRecordActions }): ReactNode {
  const ds = useDsWords()
  const steps = model.stageNote ? model.steps.map((step) => (step.id === 'IN_PRODUCTION' ? { ...step, note: model.stageNote } : step)) : model.steps
  const showStrips = model.strips.length > 0 || model.reading || model.failed !== null
  return (
    <OverviewCard lead title={model.title} aside={model.fresh ? <FreshnessLine mode={model.fresh.offline ? 'offline' : 'polling'} asOf={model.fresh.asOf} everySeconds={model.fresh.everySeconds ?? undefined} /> : undefined}>
      <Headline sentence={model.headline} quiet={model.quiet} />
      {showStrips ? (
        <Strips
          label={model.stripsLabel}
          rows={model.strips.map((strip) => (
            <StripRow key={strip.id} strip={strip} page={page} actions={actions} />
          ))}
          reading={model.reading}
          failed={model.failed ? { words: model.failed, onRetry: actions?.onRetryProduction } : null}
        />
      ) : null}
      <div className="fw-pord-tracker">
        <MilestoneTracker steps={steps} label={model.trackerLabel} labels={ds.milestoneTracker} />
        {model.promise || model.noPromise || model.moves ? <PromiseBox model={model} /> : null}
      </div>
    </OverviewCard>
  )
}

const MARK: Readonly<Record<WhereStrip['id'], ReactNode>> = {
  reconfirm: <FileSignature size={14} aria-hidden />,
  waiting: <Hourglass size={14} aria-hidden />,
  deposit: <Banknote size={14} aria-hidden />,
  hold: <PauseCircle size={14} aria-hidden />,
  problem: <MessageSquareWarning size={14} aria-hidden />,
}

/** One strip: its mark, its words (a revised version also "What changed", line by line), its ONE door. */
function StripRow({ strip, page, actions }: { strip: WhereStrip; page: ApprovalPage | null; actions?: OrderRecordActions }): ReactNode {
  const words = useOrderWords()
  const kit = useOverviewWords()
  const { t } = words
  const door = strip.door
  const mark = strip.id === 'hold' && strip.tone === 'danger' ? <ShieldAlert size={14} aria-hidden /> : strip.door?.kind === 'retryRevision' ? <CircleAlert size={14} aria-hidden /> : MARK[strip.id]
  return (
    <Strip
      tone={strip.tone}
      mark={mark}
      doors={
        !door ? undefined : door.kind === 'reconfirm' ? (
          <Button size="sm" variant="primary" heldReason={door.held} onClick={() => actions?.onReconfirm?.()}>
            {t('reconfirm.review')}
          </Button>
        ) : door.kind === 'waiting' ? (
          <Button asChild size="sm" variant="quiet">
            <a href={door.href}>{kit.door(t('production.waitingLink'))}</a>
          </Button>
        ) : door.kind === 'pay' ? (
          <Button size="sm" variant="primary" heldReason={door.held} onClick={() => actions?.onPay?.(door.depositId)}>
            {t('band.pay')}
          </Button>
        ) : door.kind === 'ask' ? (
          <Button size="sm" onClick={() => actions?.onAsk?.()}>
            {t('production.ask')}
          </Button>
        ) : (
          <Button size="sm" onClick={() => actions?.onRetryRevision?.()}>
            {kit.retry}
          </Button>
        )
      }
    >
      <StripSaid title={strip.title} lines={strip.lines} />
      {strip.changes !== undefined && page ? (
        <Disclosure summary={t('reconfirm.whatChanged', { count: strip.changes })}>
          <RevisionReview page={page} words={words} />
        </Disclosure>
      ) : null}
    </Strip>
  )
}

/** The promise, ONCE (L6): its day big, the first one when it moved, "Date moved ×n" with its history (never who moved it). */
function PromiseBox({ model }: { model: WhereModel }): ReactNode {
  const moves = model.moves
  return (
    <div className="fw-pord-promise">
      {model.promise ? (
        <>
          <span className="fw-pord-promise-label">{model.promise.label}</span>
          <p className="fw-pord-promise-date">{model.promise.date}</p>
          {model.promise.first ? <span className="fw-pord-sub">{model.promise.first}</span> : null}
        </>
      ) : model.noPromise ? (
        <p className="fw-pord-hint">{model.noPromise}</p>
      ) : null}
      {moves ? (
        <DetailPopover
          trigger={
            <span className="fw-pord-moved-mark">
              <History size={14} aria-hidden /> {moves.words}
            </span>
          }
          triggerLabel={moves.open}
          triggerClassName="fw-pord-moved-trigger"
          label={moves.title}
          hoverDelay={0}
        >
          <div className="fw-pord-history">
            <strong>{moves.title}</strong>
            <ol className="fw-pord-history-list">
              {moves.history.map((move, index) => (
                <li key={index}>
                  <span>{move.words}</span>
                  {move.reason ? <span className="fw-pord-sub">{move.reason}</span> : null}
                </li>
              ))}
            </ol>
          </div>
        </DetailPopover>
      ) : null}
    </div>
  )
}
