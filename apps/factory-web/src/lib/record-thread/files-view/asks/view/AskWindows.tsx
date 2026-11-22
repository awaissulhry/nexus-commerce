'use client'

import type { ReactNode } from 'react'
import { BellRing, Check, Lock, Mail, RotateCcw, Send, UserRoundCog } from 'lucide-react'
import { Field } from '@nexus/ui/components'
import { Button, Checkbox, RadioCard, Select } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../i18n/ds-parts'
import { formatDate } from '../../../../i18n/format'
import { INTL_LOCALE } from '../../../../i18n/locales'
import { useLocale, useT } from '../../../../i18n/provider'
import type { FileAsk, OrderFile, OrderFilesRead } from '../../model'
import {
  ASK_FILE_KINDS,
  ASK_WORDS,
  floorWho,
  reassignKindsOf,
  wheresOf,
  whoHeld,
  whoKindsOf,
  windowHeld,
  type AskChoices,
  type AskDraft,
  type AskList,
  type AsksState,
  type AskWhoKind,
  type AskWindow,
} from '../asks'
import { ASKS_NS } from './AsksBody'

/** The windows' doors the container answers (use-file-asks); Open in the Accept window is the ONE viewer's. */
export interface AskWindowsActions {
  readonly onAskWindow?: (next: AskWindow) => void
  readonly onAskSubmit?: () => void
  readonly onAskClose?: () => void
  readonly onAskRetryPicks?: () => void
  readonly onOrderOpen?: (fileId: string, mode: 'preview' | 'download', opener?: HTMLElement | null) => void
}

/**
 * F-OF-202 / F-OF-203 (order FILES tab W2; 10-design §6) — the ask's windows, centred DS Modals (a full-width sheet at 375), each with what
 * happens, what the customer is told and what never changes: Ask for a file (what · what it is · who uploads it · where it goes · due ·
 * prices · measurement sheet; no "who sees it": the file keeps its upload's audience), Accept (the files that came, Open, "Share with
 * <customer>" for files.manage; held while a sent file is being scanned), Ask again (why), Ask for an update, Reassign, Change, Cancel
 * the ask (why). A refusal is said in the server's words in the window. Draws the band's state; fetches nothing.
 */
export function AskWindows({ read, state, actions, customer, orderLabel }: { read: OrderFilesRead; state: AsksState; actions?: AskWindowsActions | undefined; customer: string | null; orderLabel: string }) {
  const window = state.window
  if (!window) return null
  const ask = window.kind === 'ask' ? null : (read.asks?.find((one) => one.id === window.askId) ?? null)
  if (window.kind !== 'ask' && !ask) return null
  if (window.kind === 'ask') return <AskForAFile window={window} state={state} actions={actions} customer={customer} orderLabel={orderLabel} />
  return <AskActWindow window={window} ask={ask!} read={read} state={state} actions={actions} customer={customer} />
}

/** The footer of every window: Cancel (or Keep) and the act, held with its words. */
function Foot({ held, busy, label, icon, cancel, onCancel, onGo, danger }: { held: string | null; busy: boolean; label: string; icon: ReactNode; cancel: string; onCancel: () => void; onGo: () => void; danger?: boolean }) {
  const t = useT(ASKS_NS)
  return (
    <>
      <Button onClick={onCancel}>{cancel}</Button>
      <Button variant={danger ? 'danger' : 'primary'} heldReason={busy ? t('ask.held.busy') : held} onClick={onGo}>
        {icon} {label}
      </Button>
    </>
  )
}

/** What happens · the customer · what never changes (every hand window says them). */
function Lines({ happens, customer, never }: { happens: string; customer: string; never: string }) {
  const t = useT(ASKS_NS)
  return (
    <div className="fw-ask-lines">
      <p>
        <b>{t('ask.happens')}.</b> {happens}
      </p>
      <p>
        <Mail size={13} aria-hidden /> {customer}
      </p>
      <p className="fw-ask-never">
        <Lock size={13} aria-hidden /> {never}
      </p>
    </div>
  )
}

function Problem({ problem }: { problem: AsksState['problem'] }) {
  const t = useT(ASKS_NS)
  if (!problem) return null
  return (
    <p className="fw-ask-problem" role="alert">
      {t(problem.key, problem.params)}
    </p>
  )
}

/** One picker: its list read, read, failed (Try again), or empty (said). */
function Picker<T extends { readonly id: string }>({ label, list, value, words, onPick, onRetry }: { label: string; list: AskList<T>; value: string | null; words: (item: T) => string; onPick: (id: string | null) => void; onRetry?: (() => void) | undefined }) {
  const t = useT(ASKS_NS)
  const v = useT('record-thread-files-view')
  if (list.state === 'reading') return <p className="fw-ask-mu">{t('ask.pickReading')}</p>
  if (list.state === 'failed')
    return (
      <p className="fw-ask-problem">
        {t('ask.pickFailed')}{' '}
        {onRetry && (
          <Button size="sm" variant="quiet" onClick={onRetry}>
            {v('problem.retry')}
          </Button>
        )}
      </p>
    )
  if (list.items.length === 0) return <p className="fw-ask-mu">{t('ask.pickNone')}</p>
  return (
    <Field label={label}>
      <Select value={value ?? ''} onChange={(event) => onPick(event.target.value || null)}>
        <option value="">{t('ask.pickOne')}</option>
        {list.items.map((item) => (
          <option key={item.id} value={item.id}>
            {words(item)}
          </option>
        ))}
      </Select>
    </Field>
  )
}

/** The list a "Who" picks from (a step and the customer pick nothing). */
const listOf = (who: AskWhoKind, choices: AskChoices): AskList<{ readonly id: string; readonly name: string }> | null =>
  who === 'PERSON' ? choices.people : who === 'OFFICE_ROLE' ? choices.officeRoles : who === 'FLOOR_ROLE' ? choices.floorRoles : who === 'FLOOR_TEAM' ? choices.teams : null

// ---- F-OF-202: Ask for a file ------------------------------------------------------------------------------------------------------
function AskForAFile({ window, state, actions, customer, orderLabel }: { window: Extract<AskWindow, { kind: 'ask' }>; state: AsksState; actions?: AskWindowsActions | undefined; customer: string | null; orderLabel: string }) {
  const t = useT(ASKS_NS)
  const v = useT('record-thread-files-view')
  const f = useT('record-thread-files')
  const p = useT('record-files')
  const locale = useLocale()
  const draft = window.draft
  const choices = state.choices
  const set = (change: Partial<AskDraft>) => actions?.onAskWindow?.({ kind: 'ask', draft: { ...draft, ...change } })
  const kinds = whoKindsOf(choices, state.can)
  const floor = floorWho(draft.who)
  const list = listOf(draft.who, choices)
  const wheres = wheresOf(draft.who, choices)
  const toCustomer = draft.who === 'CUSTOMER'
  const held = windowHeld(window, null)
  return (
    <Modal
      open
      onClose={() => actions?.onAskClose?.()}
      size="md"
      title={t('ask.title')}
      subtitle={[orderLabel, customer].filter(Boolean).join(' · ')}
      footer={<Foot held={held ? t(held) : null} busy={state.busy} label={t('ask.send')} icon={<Send size={14} aria-hidden />} cancel={v('upload.cancel')} onCancel={() => actions?.onAskClose?.()} onGo={() => actions?.onAskSubmit?.()} />}
    >
      <div className="fw-ask-form">
        <Problem problem={state.problem} />
        {!toCustomer && (
          <>
            <Field label={t('ask.what')} hint={t('ask.whatHint')}>
              <Textarea value={draft.words} rows={2} limit={ASK_WORDS.max} maxLength={ASK_WORDS.max} onChange={(event) => set({ words: event.target.value })} />
            </Field>
            <fieldset className="fw-ask-fieldset">
              <legend className="fw-ask-legend">{v('upload.kind')}</legend>
              <div className="fw-ask-cards is-three">
                {ASK_FILE_KINDS.map((kind) => (
                  <RadioCard key={kind} name="fw-ask-kind" value={kind} checked={draft.fileKind === kind} selected={draft.fileKind === kind} onChange={() => set({ fileKind: kind })} title={f(`kind.${kind}`)} variant="row" />
                ))}
              </div>
            </fieldset>
          </>
        )}
        <fieldset className="fw-ask-fieldset">
          <legend className="fw-ask-legend">{t('ask.who')}</legend>
          <div className="fw-ask-cards">
            {kinds.map((kind) => {
              const stop = whoHeld(kind, choices)
              return (
                <RadioCard key={kind} name="fw-ask-who" value={kind} checked={draft.who === kind} selected={draft.who === kind} disabled={!!stop} onChange={() => set({ who: kind })} title={t(`ask.whoKind.${kind}`)} description={stop ? t(stop) : t(`ask.whoHint.${kind}`)} />
              )
            })}
          </div>
        </fieldset>
        {list && <Picker label={t(`ask.pick.${draft.who}`)} list={list} value={draft.pick} words={(item) => item.name} onPick={(pick) => set({ pick })} onRetry={actions?.onAskRetryPicks} />}
        {/* S3 (B-OF-035): the choices read cut a list short — said, never hidden. */}
        {list && choices.truncated && <p className="fw-rtv-muted">{t('ask.truncated')}</p>}
        <p className="fw-ask-hint">{toCustomer ? t('ask.customerNote', { customer: customer ?? '' }) : floor ? t('ask.floorNote') : t('ask.officeNote')}</p>
        {!toCustomer && (
          <fieldset className="fw-ask-fieldset">
            <legend className="fw-ask-legend">{v('upload.where')}</legend>
            <div className="fw-ask-cards is-three">
              {wheres.map(({ where, held: stop }) => (
                <RadioCard key={where} name="fw-ask-where" value={where} checked={draft.where === where} selected={draft.where === where} disabled={!!stop} onChange={() => set({ where, lineId: where === 'SALES_ORDER_LINE' ? (draft.lineId ?? choices.lines[0]?.id ?? null) : null, workOrderId: where === 'WORK_ORDER' ? (draft.workOrderId ?? choices.workOrders[0]?.id ?? null) : null, stepId: null })} title={where === 'SALES_ORDER' ? v('upload.place.order') : t(`ask.whereKind.${where}`)} variant="row" />
              ))}
            </div>
            {draft.where === 'SALES_ORDER_LINE' && (
              <Field label={t('ask.pickLine')}>
                <Select value={draft.lineId ?? ''} onChange={(event) => set({ lineId: event.target.value || null })}>
                  {choices.lines.map((line) => (
                    <option key={line.id} value={line.id}>
                      {line.what ? v('upload.place.lineOf', { seq: line.seq, what: line.what }) : v('upload.place.line', { seq: line.seq })}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {draft.where === 'WORK_ORDER' && (
              <>
                <Field label={t('ask.pickWorkOrder')}>
                  <Select value={draft.workOrderId ?? ''} onChange={(event) => set({ workOrderId: event.target.value || null, stepId: null, ...(draft.who === 'FLOOR_TEAM' ? { pick: null } : {}) })}>
                    {choices.workOrders.map((order) => (
                      <option key={order.id} value={order.id}>
                        {order.number}
                      </option>
                    ))}
                  </Select>
                </Field>
                {choices.steps.state === 'ready' && choices.steps.items.length > 0 ? (
                  <Field label={t('ask.pickStep')}>
                    <Select value={draft.stepId ?? ''} onChange={(event) => set({ stepId: event.target.value || null })}>
                      {draft.who !== 'STEP' && <option value="">{t('ask.anyStep')}</option>}
                      {draft.who === 'STEP' && <option value="">{t('ask.pickOne')}</option>}
                      {choices.steps.items.map((step) => (
                        <option key={step.id} value={step.id}>
                          {t('ask.stepWords', { seq: step.seq, name: step.name })}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : choices.steps.state === 'reading' ? (
                  <p className="fw-ask-mu">{t('ask.pickReading')}</p>
                ) : null}
              </>
            )}
            <p className="fw-ask-hint">{floor ? t('ask.floorWhere') : t('ask.lineWhere')}</p>
          </fieldset>
        )}
        <Field label={t('ask.due')}>
          <DateField value={draft.dueOn} onChange={(dueOn: string) => set({ dueOn })} locale={INTL_LOCALE[locale]} min={state.today} ariaLabel={t('ask.due')} />
        </Field>
        {!toCustomer && (
          <>
            {/* F-OF-202: both held for a floor "who", with words (the floor never gets prices; a measurement sheet never goes there). */}
            <Checkbox
              label={
                <span>
                  {p('priced.tick')} <span className="fw-ask-mu">· {floor ? t('ask.pricedFloor') : t('ask.pricedHint')}</span>
                </span>
              }
              checked={draft.priced}
              disabled={floor}
              onChange={(event) => set({ priced: event.target.checked })}
            />
            <Checkbox
              label={
                <span>
                  {v('upload.sheet')} <span className="fw-ask-mu">· {floor ? t('ask.sheetFloor') : t('ask.sheetHint')}</span>
                </span>
              }
              checked={draft.bodyData}
              disabled={floor}
              onChange={(event) => set({ bodyData: event.target.checked })}
            />
          </>
        )}
        <Lines happens={toCustomer ? t('ask.customerNote', { customer: customer ?? '' }) : floor ? t('ask.happensFloor') : t('ask.happensOffice')} customer={t('ask.customerTold')} never={t('ask.never')} />
      </div>
    </Modal>
  )
}

// ---- F-OF-203: the ask's own windows ------------------------------------------------------------------------------------------------
function AskActWindow({ window, ask, read, state, actions, customer }: { window: Exclude<AskWindow, { kind: 'ask' }>; ask: FileAsk; read: OrderFilesRead; state: AsksState; actions?: AskWindowsActions | undefined; customer: string | null }) {
  const t = useT(ASKS_NS)
  const v = useT('record-thread-files-view')
  const locale = useLocale()
  const date = (day: string) => formatDate(day, { locale })
  const held = windowHeld(window, ask)
  const close = () => actions?.onAskClose?.()
  const go = () => actions?.onAskSubmit?.()
  const set = (next: AskWindow) => actions?.onAskWindow?.(next)
  const floor = ask.who.kind === 'FLOOR_TEAM' || ask.who.kind === 'FLOOR_ROLE' || ask.who.kind === 'STEP'
  const what = ask.words ?? t('row.priced')
  const common = { held: held ? t(held) : null, busy: state.busy, cancel: v('upload.cancel'), onCancel: close, onGo: go }
  let title = ''
  let body: ReactNode = null
  let foot: ReactNode = null
  switch (window.kind) {
    case 'accept': {
      const files = read.groups.flatMap((group) => group.files)
      const sent: (OrderFile | null)[] = (ask.answered?.fileIds ?? []).map((id) => files.find((file) => file.id === id) ?? null)
      title = t('accept.title')
      body = (
        <>
          <p>
            <b>{what}</b>
          </p>
          {ask.answered && <p className="fw-ask-mu">{t('accept.sent', { who: ask.answered.by.kind === 'OFFICE' ? ask.answered.by.name : t('accept.theFloor'), count: ask.answered.fileIds.length, date: date(ask.answered.at) })}</p>}
          <ul className="fw-ask-files">
            {sent.map((file, index) => (
              <li key={file?.id ?? `n${index}`}>
                {file ? (
                  <Button size="sm" variant="link" onClick={(event) => actions?.onOrderOpen?.(file.id, 'preview', event.currentTarget)}>
                    {t('accept.open', { name: file.name })}
                  </Button>
                ) : (
                  <span className="fw-ask-mu">{t('accept.notListed')}</span>
                )}
              </li>
            ))}
          </ul>
          {(ask.answered?.held ?? 0) > 0 && <p className="fw-ask-problem">{t('held.checking')}</p>}
          {/* F-OF-203: "Share with <customer>" — only for files.manage (the Owner, D5); the file's own visibility command after Accept. */}
          {state.can.share && customer && (
            <Checkbox
              label={
                <span>
                  {t('accept.share', { customer })} <span className="fw-ask-mu">· {t('accept.shareHint')}</span>
                </span>
              }
              checked={window.share}
              onChange={(event) => set({ ...window, share: event.target.checked })}
            />
          )}
          <p className="fw-ask-hint">{t('accept.version')}</p>
        </>
      )
      foot = <Foot {...common} label={t('accept.go')} icon={<Check size={14} aria-hidden />} />
      break
    }
    case 'again':
      title = t('again.title', { who: ask.who.label })
      body = (
        <>
          <p>
            <b>{what}</b>
          </p>
          <Field label={t('again.why')} hint={t('again.whyHint')}>
            <Textarea value={window.reason} rows={3} limit={ASK_WORDS.max} maxLength={ASK_WORDS.max} onChange={(event) => set({ ...window, reason: event.target.value })} />
          </Field>
          <p className="fw-ask-hint">{t('again.what')}</p>
        </>
      )
      foot = <Foot {...common} label={t('again.go')} icon={<RotateCcw size={14} aria-hidden />} />
      break
    case 'chase':
      title = t('chase.title', { who: ask.who.label })
      body = (
        <>
          <p>
            <b>{what}</b> · {t('row.due', { date: date(ask.dueOn) })}
          </p>
          <p className="fw-ask-hint">{floor ? t('chase.floor') : t('chase.office')}</p>
        </>
      )
      foot = <Foot {...common} label={t('chase.go')} icon={<BellRing size={14} aria-hidden />} />
      break
    case 'reassign': {
      const kinds = reassignKindsOf(ask, state.choices)
      const list = listOf(window.who, state.choices)
      title = t('reassign.title')
      body = (
        <>
          <p>
            <b>{what}</b> · {ask.who.label}
          </p>
          <fieldset className="fw-ask-fieldset">
            <legend className="fw-ask-legend">{t('reassign.who')}</legend>
            <div className="fw-ask-cards">
              {kinds.map((kind) => (
                <RadioCard key={kind} name="fw-ask-reassign" value={kind} checked={window.who === kind} selected={window.who === kind} onChange={() => set({ ...window, who: kind, pick: null })} title={t(`ask.whoKind.${kind}`)} description={t(`ask.whoHint.${kind}`)} />
              ))}
            </div>
          </fieldset>
          {list && <Picker label={t(`ask.pick.${window.who}`)} list={list} value={window.pick} words={(item) => item.name} onPick={(pick) => set({ ...window, pick })} onRetry={actions?.onAskRetryPicks} />}
          {floor && <p className="fw-ask-hint">{t('reassign.floorStays')}</p>}
          <Field label={t('reassign.why')}>
            <Textarea value={window.reason} rows={2} limit={ASK_WORDS.max} maxLength={ASK_WORDS.max} onChange={(event) => set({ ...window, reason: event.target.value })} />
          </Field>
        </>
      )
      foot = <Foot {...common} label={t('reassign.go')} icon={<UserRoundCog size={14} aria-hidden />} />
      break
    }
    case 'change':
      title = t('change.title')
      body = (
        <>
          <Field label={t('ask.what')} hint={t('ask.whatHint')}>
            <Textarea value={window.words} rows={2} limit={ASK_WORDS.max} maxLength={ASK_WORDS.max} onChange={(event) => set({ ...window, words: event.target.value })} />
          </Field>
          <Field label={t('ask.due')}>
            <DateField value={window.dueOn} onChange={(dueOn: string) => set({ ...window, dueOn })} locale={INTL_LOCALE[locale]} min={state.today} ariaLabel={t('ask.due')} />
          </Field>
        </>
      )
      foot = <Foot {...common} label={t('change.go')} icon={<Check size={14} aria-hidden />} />
      break
    case 'cancel':
      title = t('cancel.title')
      body = (
        <>
          <p>
            <b>{what}</b> · {ask.who.label}
          </p>
          <Field label={t('again.why')} hint={t('again.whyHint')}>
            <Textarea value={window.reason} rows={3} limit={ASK_WORDS.max} maxLength={ASK_WORDS.max} onChange={(event) => set({ ...window, reason: event.target.value })} />
          </Field>
          <p className="fw-ask-hint">{t('cancel.what')}</p>
        </>
      )
      foot = <Foot {...common} cancel={t('cancel.keep')} label={t('cancel.go')} icon={null} danger />
      break
  }
  return (
    <Modal open onClose={close} size="md" title={title} footer={foot}>
      <div className="fw-ask-form">
        <Problem problem={state.problem} />
        {body}
        <div className="fw-ask-lines">
          <p>
            <Mail size={13} aria-hidden /> {t('win.customer')}
          </p>
          <p className="fw-ask-never">
            <Lock size={13} aria-hidden /> {t('win.never')}
          </p>
        </div>
      </div>
    </Modal>
  )
}
