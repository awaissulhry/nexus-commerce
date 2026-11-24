'use client'

import Link from 'next/link'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Spinner } from '@nexus/ui/primitives'
import { ShieldAlert } from 'lucide-react' // F-SC-W4: the gate row's mark (Problems & holds)
import { Textarea } from '../../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../../lib/i18n/format'
import type { Locale } from '../../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { dayInstant } from '../../../model'
import { Frame } from '../../view/Dialogs'
import type { OrderGate, OrderRePromise } from '../api'
import '../links.css'
import { declineHeld, decideHeld, gateHref, type LinksActions, type LinksModel } from '../model'
import { gateAnchorsOf, gatesOf } from '../model' // F-SC-W4 (+ W7: each row's anchor its gate's own id)
import { Strip } from '../../../../../_shared/record-overview/Overview' // F-CO-K2: a gate row is the shared overview kit's strip

/**
 * B-TH-256 — what points at the order, drawn (O-SAL-ORD-REC.notice-F04, -F06, .body-F07; picture 29):
 * - `LinksSaid`, `GateNotices`, `RePromiseNotices`: the record's notices from it — each compliance gate refusal that still blocks a work order or a shipment ("Work
 *   order release blocked: WO-… · <the gate's own sentence> · Open in Compliance", the link only with the compliance view right),
 *   each re-promise planning sends ("Planning proposes new dates for line 2 · AX-100": the sizes from → to, who proposed it, the
 *   planner's note, Accept / Decline, the "Tell the customer" tick — held with why for a person who may not decide, the planner who
 *   proposed it included), and the last write's result. They go INSIDE the order's RecordNotices (one notice, the rest behind "N more").
 * - F-OS-104 (order SHIPMENTS tab): the order's complaints and returns are the tab's section 3 now (shipments/view/AfterSalesSection.tsx,
 *   one list by what the reader may see); the card that listed them here went.
 * - `DeclineDialog`: "Decline the new dates?" with the reason the planner reads.
 * - F-SC-W4 `GateRows`: the same refusals as rows of Production › Problems & holds ("What stops it") — the SAME title, style code,
 *   sentence and door; the page notice stays on top of every tab while it blocks (OrderRecordView draws GateNotices for every tab).
 */

const day = (value: string | null, locale: Locale): string => (value ? formatDate(dayInstant(value), { locale }) : '—')

/** The last write's result (Accepted, Declined, or why not): the most recent thing the person did, first among the notices. */
export function LinksSaid({ model, actions }: { model: LinksModel | null | undefined; actions?: LinksActions }) {
  const t = useT('orders')
  if (!model || model.state !== 'ready' || !model.said) return null
  return (
    <Banner
      tone={model.said.tone}
      title={t(model.said.key)}
      action={
        actions?.onDismiss ? (
          <Button size="sm" variant="quiet" onClick={actions.onDismiss}>
            {t('common.dismiss')}
          </Button>
        ) : undefined
      }
    />
  )
}

/** Each compliance gate refusal still blocking one of the order's work orders or shipments (one notice each). */
export function GateNotices({ model, prefix }: { model: LinksModel | null | undefined; prefix: string }) {
  if (!model || model.state !== 'ready') return null
  return (
    <>
      {model.links.gates.map((gate) => (
        <GateNotice key={`${gate.gate}:${gate.subject.id}:${gate.at}`} gate={gate} prefix={prefix} />
      ))}
    </>
  )
}

/** Each re-promise planning sends to sales (one notice each), with Accept / Decline and the "Tell the customer" tick. */
export function RePromiseNotices({ model, actions }: { model: LinksModel | null | undefined; actions?: LinksActions }) {
  if (!model || model.state !== 'ready') return null
  return (
    <>
      {model.links.rePromises.map((proposal) => (
        <RePromiseNotice key={proposal.id} proposal={proposal} model={model} actions={actions} />
      ))}
    </>
  )
}

function GateNotice({ gate, prefix }: { gate: OrderGate; prefix: string }) {
  const href = gateHref(prefix, gate)
  const title = useGateTitle()
  return (
    <Banner tone="danger" title={title(gate)} action={href ? <GateDoor href={href} /> : undefined}>
      <GateSaid gate={gate} href={href} />
    </Banner>
  )
}

// ---- F-SC-W4 (stage control B; plan-stage-control "the red notice"): the notice's parts, shared with Problems & holds' rows ----
/** "Label printing blocked: SEED-WO-0001" (a subject not named: "a work order of this order"). */
function useGateTitle(): (gate: OrderGate) => string {
  const t = useT('orders')
  return (gate) => t('links.gate.title', { place: t(`links.gate.place.${gate.gate}`), subject: gate.subject.number ?? t(`links.gate.subject.${gate.subject.type}`) })
}

/** The style code, the gate's own sentence (same words as Compliance › Gate refusals: who can fix it and how), the words-only hint. */
function GateSaid({ gate, href }: { gate: OrderGate; href: string | null }) {
  const t = useT('orders')
  return (
    <span className="fw-so-links-gate">
      {gate.styleCode && <span className="fw-so-links-style">{gate.styleCode}</span>}
      <span>{gate.reason}</span>
      {!href && <span className="fw-so-hint">{t('links.gate.wordsOnly')}</span>}
    </span>
  )
}

/** Open in Compliance (only with the compliance view right: the API sends the event's id then). */
function GateDoor({ href }: { href: string }) {
  const t = useT('orders')
  return (
    <Button size="sm" variant="quiet" asChild>
      <Link href={href}>{t('links.gate.open')}</Link>
    </Button>
  )
}

/**
 * Production › Problems & holds: each refusal still blocking the order, one row of "What stops it" in the strips' own row shape (mark |
 * words | door, the danger tone) — the notice's title, style code, sentence and door, its anchor `about-GateEvent-…`. Items of the
 * section's strips list (<li>): the section counts them in its answer line. F-CO-K2: each row is the shared overview kit's `Strip`
 * (the same row as the order's strips), its words the notice's own parts.
 */
export function GateRows({ model, prefix }: { model: LinksModel | null | undefined; prefix: string }) {
  const title = useGateTitle()
  const gates = gatesOf(model)
  const anchors = gateAnchorsOf(gates) // F-SC-W7: one anchor per row, never shared (two gates on one work order included)
  return (
    <>
      {gates.map((gate, index) => {
        const href = gateHref(prefix, gate)
        return (
          <Strip key={anchors[index]} tone="danger" mark={<ShieldAlert size={14} aria-hidden />} anchor={anchors[index]} doors={href ? <GateDoor href={href} /> : undefined}>
            <span>{title(gate)}</span>
            <GateSaid gate={gate} href={href} />
          </Strip>
        )
      })}
    </>
  )
}
// ---- end F-SC-W4

function RePromiseNotice({ proposal, model, actions }: { proposal: OrderRePromise; model: Extract<LinksModel, { state: 'ready' }>; actions?: LinksActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const busy = model.busy === proposal.id
  const heldKey = decideHeld(proposal, model.busy !== null)
  const held = heldKey ? t(heldKey) : null
  const told = model.tell[proposal.id] === true
  return (
    <Banner
      tone="warning"
      title={t(proposal.line.styleCode ? 'links.rePromise.titleStyle' : 'links.rePromise.title', { line: proposal.line.seq, style: proposal.line.styleCode ?? '' })}
      action={
        <span className="fw-so-links-actions">
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onAccept?.(proposal.id)}>
            {busy ? <Spinner size={12} /> : null} {t('links.rePromise.accept')}
          </Button>
          <Button size="sm" heldReason={held} onClick={() => actions?.onDeclineStart?.(proposal.id)}>
            {t('links.rePromise.decline')}
          </Button>
        </span>
      }
    >
      <span className="fw-so-links-body">
        <ul className="fw-so-list fw-so-links-sizes" aria-label={t('links.rePromise.sizesLabel')}>
          {proposal.sizes.map((size, index) => (
            <li key={`${size.size ?? 'all'}-${index}`}>{t('links.rePromise.size', { size: size.size ?? t('links.rePromise.allSizes'), from: day(size.from, locale), to: day(size.to, locale) })}</li>
          ))}
        </ul>
        <span className="fw-so-hint">
          {proposal.proposedBy ? t('links.rePromise.by', { name: proposal.proposedBy.name, date: formatDate(proposal.proposedAt, { locale }) }) : t('links.rePromise.byUnknown', { date: formatDate(proposal.proposedAt, { locale }) })}
        </span>
        {proposal.reason && <span className="fw-so-hint">{t('links.rePromise.note', { note: proposal.reason })}</span>}
        {proposal.may.tell ? (
          <Checkbox label={t('links.rePromise.tell')} checked={told} disabled={!!held} onChange={(event) => actions?.onTell?.(proposal.id, event.target.checked)} />
        ) : (
          proposal.may.accept && <span className="fw-so-hint">{t('links.rePromise.noTell')}</span>
        )}
      </span>
    </Banner>
  )
}

/** "Decline the new dates?" — the reason is required (the planner reads it); a refusal is said here, what was typed stays. */
export function DeclineDialog({ model, actions }: { model: LinksModel | null | undefined; actions?: LinksActions }) {
  const t = useT('orders')
  if (!model || model.state !== 'ready' || !model.decline) return null
  const decline = model.decline
  const proposal = model.links.rePromises.find((entry) => entry.id === decline.proposalId)
  if (!proposal) return null
  const heldKey = declineHeld(decline, model.busy !== null)
  return (
    <Frame
      title={t('links.decline.title', { line: proposal.line.seq })}
      held={heldKey ? t(heldKey) : null}
      go={() => actions?.onDecline?.()}
      goLabel={t('links.decline.go')}
      onClose={() => actions?.onDeclineCancel?.()}
      tone="danger"
      problem={decline.problem ? <Banner tone="danger" title={t(decline.problem)} /> : null}
    >
      <p className="fw-so-hint">{t('links.decline.body')}</p>
      <Field label={t('links.decline.reason')}>
        <Textarea value={decline.reason} onChange={(event) => actions?.onDeclineReason?.(event.target.value)} rows={3} maxLength={1000} />
      </Field>
    </Frame>
  )
}
