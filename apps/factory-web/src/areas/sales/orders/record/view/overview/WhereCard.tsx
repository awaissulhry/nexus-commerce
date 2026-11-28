'use client'

import { useState } from 'react' // F-OO-106: the credit dialog's note (F-CO-K2: "Show {n} more" is the kit's Strips' own)
import { Menu } from '@nexus/ui/components' // F-OO-107: Menu (More ▾)
import { Button } from '@nexus/ui/primitives'
import { ChevronDown } from 'lucide-react' // F-OO-107: More ▾
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { useProductionWords } from '../../../../../../lib/production/words'
import { FreshnessLine } from '../../../../../../lib/production/view/FreshnessLine'
import { StageStrip } from '../../../../../../lib/production/view/StageStrip'
import type { Order } from '../../../api'
import type { Phrase } from '../../../model'
import { readOf, say, type WaitingState } from '../../overview/model' // F-OP-301 (walk #1–#3): the ONE waiting list's state
import { headlineOf, stageStripOf, stagesShown } from '../../overview/where'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { useSearchParams } from 'next/navigation'
import { tabHref } from '../../../../../_shared/record-frame/address'
import './where.css' // F-OO-103: the section 1 frame's own CSS
// ---- F-OO-105: the strips' doors — the band's yes door (DepthBand, imported as it is), the depth's words, the page's tab links ----
import { readOnlyOnPage } from '../../../model'
import { stripDoorsOf, whereStripsOf, type StripDoorsInput } from '../../overview/where'
// ---- end F-OO-105
import { whereMovesOf, type WhereMove, type WhereMoveId } from '../../overview/where' // F-OO-107: the order's own moves
// ---- F-OO-106: the credit strip's own doors, lines and dialogs (Check credit again, Ask for a yes…) — the page's dialog frame ----
import { Banner, Field } from '@nexus/ui/components'
import { Textarea } from '../../../../../../lib/i18n/ds-parts'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { CREDIT_ASK_NOTE_MAX } from '../../overview/where'
import { Frame } from '../Dialogs'
// ---- end F-OO-106
// ---- F-MS-102: the stage set by hand — its row (the DS Tag, the hand and lock marks) and its ONE door under the dots ----
import { Tag } from '@nexus/ui/primitives'
import { Hand, Lock } from 'lucide-react'
import { formatDateTime } from '../../../../../../lib/i18n/format'
import type { PlainStage } from '../../../../../../lib/production/model'
import { handDoorOf, handRowOf, type HandDoor, type HandRow } from '../../overview/where'
// ---- end F-MS-102
import { WhereHero } from './FlowParts' // owb-of5 step 2: the mockup, the next box, the departments strip
import { lifeOfOrder } from '../../band/model' // owb-of5: the order's life (L9)
import { useSayHand } from './StageByHandDialog' // F-MS-103: the door's words (F-SC-W2: the dialogs are the page's, OrderDialogs)
import { stagePicksOf } from '../../overview/where' // F-SC-W3: the steps of the stages open the stage dialog
import { CREDIT_NS, StripRow } from './StripRow' // F-PT-301: the ONE strip row (Production › Problems & holds draws it too)
// ---- F-CO-K1 (the shared overview kit): the card's frame and its headline are the kit's parts. F-CO-K2: the strips' list too (its cap,
// "Show {n} more", the reading and the failed rows). No stylesheet order decides a look any more (the dead align-items went). ----
import { Headline, OverviewCard, Strips } from '../../../../../../lib/record-overview/Overview'
// ---- end F-CO-K1

/**
 * F-OO-100 (order overview lane: one file per card) — "Where it is now".
 *
 * F-OO-103 (order overview §1.1, §1.6; review F8, F14): the section 1 frame. It keeps the title, "Live · as of 10:42", the headline
 * (the status and the stage, F-OO-101) with its quiet line, and the five stages with their link to Production's work orders and their
 * quiet line (F-OO-102) — F-SC-W3: for who may set the stage by hand, the steps are buttons into the stage dialog instead of the
 * link. Between the headline and the stages sits the strips slot (one strip per hold or wait, most blocking first,
 * F-OO-104 / F-OO-105: they read OverviewTab's ONE waiting list, `waiting.holds`); under the stages the moves slot (the order's own
 * moves, F-OO-107). What left, each living on in ONE other place: Who acts next (Requests & changes' groups), Ex-factory and how it
 * moved (Next dates' Promised row), Health and the customer's Urgent (the band's chip and tag), Bundles in work (Progress by line's
 * counts), the deposit note on Preparing (the deposit strip).
 * F-CO-K1: the frame is the shared overview kit's lead card (`OverviewCard lead`: the title, "Live · as of" at its right) and its
 * `Headline` (the sentence, its quiet line, the placeholder while it is read) — the same markup as before.
 */
export function WhereCard({ order, model, actions, waiting }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions; /** OverviewTab's ONE waiting list: the strips read its holds (F-OO-104). */ waiting: WaitingState }) {
  const t = useT('orders')
  const w = useProductionWords()
  const locale = useLocale()
  const search = useSearchParams()?.toString() ?? '' // F-OP-104: the stages' door keeps the dock's scope
  const state = model.production ?? null
  const read = readOf(state)
  const headline = read?.headline ?? null
  const loading = !state || state.status === 'loading'
  // F-OO-101: the status word, then the stage word ("In production · Quality check"); dated words say their days in the page's way.
  const words = headlineOf(order, headline)
  const dated = (phrase: Phrase): string => t(phrase.key, Object.fromEntries(Object.entries(phrase.params ?? {}).map(([key, value]) => [key, typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? formatDate(value, { locale }) : value])))
  const sentence = [words.status ? dated(words.status) : null, words.stage ? w.t(`parts.stage.${words.stage}`) : null].filter(Boolean).join(' · ')
  const quiet = words.note ? t(words.note.key, words.note.stage ? { stage: w.t(`parts.stage.${words.note.stage}`) } : undefined) : null
  const strip = stageStripOf(order, headline, read?.dates ?? null) // F-OO-102: the dots in the headline's own state
  // ---- F-MS-102: a stage set by hand — its row under the quiet line, the current dot's note, and the ONE door (absent `stageHand`:
  // not offered here; Read-only: none, the row still says it) ----
  const hand = handRowOf(order, headline, model.today)
  const handDoor = model.stageHand ? handDoorOf(order, headline, model.stageHand.can, readOnlyOnPage(model.can, { assignSupervisor: model.people?.mayAssign, qualityHold: model.workOrderActs?.can.qualityHold }), model.busy) : null
  const sayHand = useSayHand()
  // F-SC-W3 (stage control B): with the right and the door not held, each step but the one the customer reads opens the stage dialog on
  // it (the floor's own step while a hand stage stands: Clear…); the strip's ONE link is then not drawn. Otherwise the link stays.
  const picks = stagePicksOf(headline, handDoor)
  // pt-sc-fx1: the floor's own step has a name of its own (never the Clear… door's: two controls, one name), starting with its stage.
  const stepPicks = picks?.map((pick) => ({ stage: pick.stage, label: t(pick.kind === 'clear' ? 'where.manual.stepFloorAria' : 'where.manual.stepAria', { number: order.number, stage: w.t(`parts.stage.${pick.stage}`) }) })) ?? null
  const onPick = (stage: PlainStage) => {
    const pick = picks?.find((entry) => entry.stage === stage)
    if (pick) actions?.onDialog?.(pick.dialog)
  }
  // ---- end F-MS-102
  // F-OP-301 (walk #2): section 1 names no wait at all now (Who acts next lives in Requests & changes' groups, F-OO-103), so it can
  // never say a stale "Waiting on us · 5 d" beside a card that says nothing waits — and it never reads the headline's kept waiting list
  // (end check fix wave: named in words, so the source test that no such read exists reads only code).
  // F-OO-104: its strips name what stops the order (holds, the yes, the deposit) — the ONE list's HOLD rows, never a "waiting on".
  return (
    <OverviewCard lead title={t('overview.where')} aside={<FreshnessLine mode={model.liveState === 'live' ? 'live' : model.liveState === 'offline' ? 'offline' : 'connecting'} asOf={read?.asOf ?? null} />}>
      <Headline sentence={loading ? null : sentence} quiet={quiet} />
      {/* owb-of5 step 2 (design § 5i; prototype mockViewer + nextBox + deptStrip): the mockup (the whole A4 page, never cut) beside the next
          step in plain words and, in production, the departments with their baskets (S5's board read). */}
      {model.flow ? <WhereHero orderId={order.id} number={order.number} read={model.flow.picture.read} life={lifeOfOrder(order, model.flow.legs).life} departments={model.flow.departments} /> : null}
      {/* ---- F-OO-103: the strips slot — one strip per hold or wait, most blocking first, each with its real door (F-OO-104, F-OO-105) ---- */}
      {/* F-OO-106: the credit strip names what its check found in the Finance page's own words (sales-credit finding.*). */}
      <WithMessages namespaces={CREDIT_NS}>
        <WhereStrips order={order} model={model} actions={actions} waiting={waiting} retry={!stagesShown(words.state)} />
      </WithMessages>
      {stagesShown(words.state) ? (
        <div className="fw-so-where-stages">
          {/* F-OP-104: the stages are one real link to Production's work orders. F-OO-102: drawn in the headline's own state. F-SC-W3:
              with the right (the door not held) the steps are buttons into the stage dialog instead — Sales and Read-only keep the link. */}
          <StageStrip
            face="office"
            layout="auto"
            label={t('overview.where')}
            {...strip}
            note={hand ? t(hand.stripNote.key) : strip.note /* F-MS-102: the current dot says "Set by hand" (shown here, never set) */}
            stageHref={`${tabHref(`${model.prefix}/sales/orders/${order.id}`, 'production', search)}#work-orders`}
            stageLinkLabel={words.state === 'ALL_DONE' ? t('where.stagesDone') : hand && strip.stage ? t('where.manual.stagesLink', { stage: w.t(`parts.stage.${strip.stage}`) }) : t('doors.stages', { stage: strip.stage ? w.t(`parts.stage.${strip.stage}`) : w.t('parts.stage.unknown') })}
            picks={stepPicks}
            onPick={onPick}
            loading={loading}
            problem={state?.status === 'failed'}
            onRetry={() => actions?.onRetryProduction?.()}
          />
          {/* F-OO-102: derived, and it says so. F-MS-102 / F-SC-W3: or set by hand when the records are wrong or missing — the door on the
              same quiet line (a group of its own, outside the strip), then the hand stage's row while one stands; the moves row is untouched. */}
          {!loading && state?.status !== 'failed' ? (
            <>
              <div className="fw-so-where-setby">
                <p className="fw-so-hint">{w.t('parts.stage.office.setBy')}</p>
                {handDoor?.kind === 'set' ? (
                  <span className="fw-so-where-hand-door">
                    <Button size="sm" heldReason={sayHand(handDoor.held)} onClick={() => actions?.onDialog?.({ kind: 'stageByHand', mode: 'set' })}>
                      {t('where.manual.open')}
                    </Button>
                  </span>
                ) : null}
              </div>
              {hand ? <HandRowView order={order} row={hand} door={handDoor?.kind === 'standing' ? handDoor : null} actions={actions} /> : null}
            </>
          ) : null}
        </div>
      ) : null}
      {/* ---- F-OO-103: the moves slot — the order's own moves: Mark ready…, Hold the whole order…, More ▾ (F-OO-107, F-OO-108) ---- */}
      <Moves order={order} model={model} actions={actions} />
      {/* F-OO-106: the credit strip's dialogs, in the page's one slot (Overview's own: use-overview-acts). */}
      <CreditDialogs order={order} model={model} actions={actions} />
      {/* F-SC-W2: the stage set by hand's dialogs (Set / Change, Clear…) are mounted once for the page (OrderDialogs). */}
    </OverviewCard>
  )
}

// ---- F-MS-102 (set the stage by hand, 04 §2.2–2.5, §8): the hand stage's row — the card's shared row, ONE place ----------------------
// F-MS-103: its words (useSayHand) are the dialog's, shared from StageByHandDialog.tsx.
/**
 * The card's shared row (mark | words | doors) under the quiet line, with a left rule in the info tone (warning after 7 days): the DS
 * Tag "Set by hand", then the stage, the office person who set it, when and why; what the floor's counts say (or that no work order
 * records the order); "check it" after 7 days; the office's note (office only, the lock). Change… and Clear… at the right edge, held
 * with words; at a narrow card they wrap under the words. It names an office person only, never anyone of the floor.
 */
function HandRowView({ order, row, door, actions }: { order: Order; row: HandRow; door: Extract<HandDoor, { kind: 'standing' }> | null; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const w = useProductionWords()
  const locale = useLocale()
  const sayHand = useSayHand()
  const stage = (code: PlainStage) => w.t(`parts.stage.${code}`)
  const reason = row.reason ? t(row.reason.key) : null
  const lines = row.lines.map((line) => t(line.key, { ...(line.stage ? { stage: stage(line.stage) } : {}), ...(line.floor ? { floor: stage(line.floor) } : {}), ...(line.past ? { past: stage(line.past) } : {}) /* F-SC-W1: a set back */, ...(line.days !== undefined ? { age: w.t('parts.age.days', { count: line.days }) } : {}) }))
  return (
    <div className="fw-so-ov-row fw-so-hand" data-tone={row.tone}>
      <span className="fw-so-hand-mark">
        <Hand size={14} aria-hidden />
      </span>
      <span className="fw-so-hand-said">
        <span className="fw-so-hand-line">
          <Tag tone={row.tone}>{t('where.manual.tag')}</Tag>
          <span>
            {[stage(row.stage), row.by ? t('where.manual.by', { who: row.by }) : null].filter(Boolean).join(' · ')}
            {' · '}
            <time dateTime={row.at}>{formatDateTime(row.at, { locale })}</time>
            {reason ? ` · ${reason}` : null}
          </span>
        </span>
        {lines.map((line) => (
          <span key={line} className="fw-so-hint">
            {line}
          </span>
        ))}
        {row.note ? (
          <span className="fw-so-hint fw-so-hand-note">
            <Lock size={12} aria-hidden />
            <span>{`${w.t('parts.health.officeOnly')} — ${row.note}`}</span>
          </span>
        ) : null}
      </span>
      {door ? (
        <span className="fw-so-ov-doors">
          <Button size="sm" heldReason={sayHand(door.change)} aria-label={t('where.manual.changeAria', { number: order.number })} onClick={() => actions?.onDialog?.({ kind: 'stageByHand', mode: 'change' })}>
            {t('where.manual.change')}
          </Button>
          <Button size="sm" variant="quiet" heldReason={sayHand(door.clear)} aria-label={t('where.manual.clearAria', { number: order.number })} onClick={() => actions?.onDialog?.({ kind: 'stageClear' })}>
            {t('where.manual.clear')}
          </Button>
        </span>
      ) : null}
    </div>
  )
}
// ---- end F-MS-102

// ---- F-PT-301: the strips (StripRow, its doors, marks and tone) moved to ./StripRow — Overview and Production › Problems & holds
// draw the same rows ----
/**
 * The strips slot: at most four strips, the rest behind "Show {n} more"; while the production read comes, one quiet row; a failed
 * read says so here (Try again only when the stages, which carry their own, are not drawn) — the order read's strips stay.
 * F-CO-K2: drawn by the shared overview kit's `Strips` (the cap, "Show {n} more", the reading and the failed rows are its own); the
 * order hands it every strip row (StripRow) and its words.
 */
function WhereStrips({ order, model, actions, waiting, retry }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions; waiting: WaitingState; retry: boolean }) {
  const t = useT('orders')
  const read = readOf(model.production)
  const approval = model.depth?.approval?.value ?? null
  const { strips, holds } = whereStripsOf(order, read, approval, waiting)
  if (strips.length === 0 && holds === 'read') return null
  const input: StripDoorsInput = {
    prefix: model.prefix,
    order,
    can: model.can,
    // Read-only sees the strips' words and no door (the band's own rule, as every card).
    readOnly: readOnlyOnPage(model.can, { assignSupervisor: model.people?.mayAssign, qualityHold: model.workOrderActs?.can.qualityHold }),
    busy: model.busy,
    approval,
    depthCan: model.depth?.can ?? null,
    work: read?.work?.workOrders ?? [],
    acts: model.workOrderActs?.can ?? null,
    credit: model.credit ?? null, // F-OO-106
  }
  const now = Date.now()
  return (
    <Strips
      label={t('where.strips')}
      rows={strips.map((entry) => (
        <StripRow key={entry.key} strip={entry} doors={stripDoorsOf(entry, input)} order={order} model={model} actions={actions} now={now} />
      ))}
      reading={holds === 'reading'}
      failed={holds === 'failed' ? { words: t('where.strip.failed'), ...(retry ? { onRetry: () => actions?.onRetryProduction?.() } : {}) } : null}
    />
  )
}

// ---- F-OO-107 (order overview §1.5; review F8): the order's own moves — the band's dialogs, held with the band's own words ----------
/**
 * Mark ready… in view; Record a shipment made elsewhere…, Cancel order…, Close order… under More ▾ — each opening the SAME dialog as
 * the band (the page's one dialog slot; made elsewhere: its container's dialog, mounted once by the page). A move the reader may not run
 * is held with words (a held menu item says why). Read-only: no row.
 */
function Moves({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const readOnly = readOnlyOnPage(model.can, { assignSupervisor: model.people?.mayAssign, qualityHold: model.workOrderActs?.can.qualityHold })
  const locale = useLocale()
  // F-OO-108: Hold the whole order… reads the production read's work orders and the page's acts (its dialog is theirs).
  const read = readOf(model.production)
  const moves = whereMovesOf(order, { can: model.can, readOnly, elsewhere: model.elsewhere, work: read ? (read.work ?? null) : undefined, acts: model.workOrderActs?.can ?? null })
  if (!moves) return null
  // A held move says why: the band's words (a phrase), or the hold plan's own words (both languages, the domain's).
  const heldOf = (move: WhereMove): string | null => (move.held ? ('key' in move.held ? t(move.held.key, move.held.params) : say(move.held, locale)) : model.busy ? t('held.busy') : null)
  const run = (move: WhereMove): void => {
    const id: WhereMoveId = move.id
    if (id === 'elsewhere') return actions?.onRecordElsewhere?.()
    // F-OO-108: the ONE Hold dialog (the work-order acts'), on the plan's work orders with their versions.
    if (id === 'hold') return move.hold ? actions?.workOrderActs?.onHoldOrder?.({ number: order.number, plan: move.hold.plan, units: move.hold.units }) : undefined
    actions?.onDialog?.({ kind: id })
  }
  return (
    <>
      <div className="fw-so-where-moves" role="group" aria-label={t('where.moves')}>
        {moves.shown.map((move) => (
          <Button key={move.id} size="sm" heldReason={heldOf(move)} onClick={() => run(move)}>
            {t(move.label.key)}
          </Button>
        ))}
        {moves.more.length > 0 && (
          <Menu
            label={
              <>
                {t('where.more')} <ChevronDown size={14} aria-hidden />
              </>
            }
            triggerProps={{ className: 'nds-btn sm', 'aria-label': t('where.moreOf', { number: order.number }) }}
            items={moves.more.map((move) => {
              const held = heldOf(move)
              return { id: move.id, label: t(move.label.key), ...(move.id === 'cancel' ? { tone: 'danger' as const } : {}), disabled: !!held, ...(held ? { description: held } : { onSelect: () => run(move) }) }
            })}
          />
        )}
      </div>
      {/* F-OP-123: Record a shipment made elsewhere… — its dialog is the page's, mounted once (OrderRecordView, F-OO-111). */}
    </>
  )
}
// ---- end F-OO-107

// ---- F-OO-106 (order overview §1.4; review F8, F16): Check credit again and Ask for a yes… — the page's own dialog frame ------------
// F-PT-301: CREDIT_NS lives with the strip row now (./StripRow).

/**
 * The credit strip's two dialogs (the page's one slot, Overview's: `creditCheck`, `creditAsk`). Check credit again: what it does, then
 * Check again — no version: the check id is the lock (a "checked meanwhile" is said here). Ask for a yes…: a word for who decides
 * (optional), then Ask — "nobody to ask" is said here and holds Ask (the customer pays, or Finance raises the limit). Esc closes
 * (DS Modal), not while the act goes; what was typed stays after a refusal.
 */
function CreditDialogs({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const dialog = model.dialog
  if (dialog?.kind === 'creditCheck') return <CreditCheckDialog order={order} model={model} actions={actions} refused={dialog.refused ?? null} />
  if (dialog?.kind === 'creditAsk') return <CreditAskDialog key={dialog.checkId} order={order} model={model} actions={actions} checkId={dialog.checkId} refused={dialog.refused ?? null} />
  return null
}

function CreditCheckDialog({ order, model, actions, refused }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions; refused: Phrase | null }) {
  const t = useT('orders')
  return (
    <Frame
      title={t('where.credit.checkTitle', { customer: order.party?.legalName ?? order.number })}
      held={model.busy ? t('held.busy') : null}
      go={() => actions?.credit?.onCheck?.()}
      goLabel={model.busy ? t('common.working') : t('where.credit.checkGo')}
      onClose={() => !model.busy && actions?.onDialog?.(null)}
      problem={refused ? <Banner tone="danger" title={t(refused.key, refused.params)} /> : null}
      size="sm"
    >
      <p>{t('where.credit.checkBody')}</p>
    </Frame>
  )
}

function CreditAskDialog({ order, model, actions, checkId, refused }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions; checkId: string; refused: Phrase | null }) {
  const t = useT('orders')
  const [note, setNote] = useState(model.draft?.message ?? '')
  // Nobody to ask: asking again changes nothing — Ask is held with the same words.
  const held = model.busy ? t('held.busy') : refused?.key === 'where.credit.refused.nobody' ? t(refused.key) : null
  return (
    <Frame
      title={t('where.credit.askTitle', { number: order.number })}
      held={held}
      go={() => actions?.credit?.onAsk?.(checkId, note)}
      goLabel={model.busy ? t('common.working') : t('where.credit.askGo')}
      onClose={() => !model.busy && actions?.onDialog?.(null)}
      problem={refused ? <Banner tone="danger" title={t(refused.key, refused.params)} /> : null}
      size="sm"
    >
      <p className="fw-so-hint">{t('where.credit.askBody')}</p>
      <Field label={t('where.credit.askNote')} hint={t('where.credit.askHint', { count: CREDIT_ASK_NOTE_MAX })}>
        <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={CREDIT_ASK_NOTE_MAX} />
      </Field>
    </Frame>
  )
}
// ---- end F-OO-106
