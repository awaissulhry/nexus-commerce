'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { BadgeCheck, MoreHorizontal, Plus } from 'lucide-react'
import { Banner, Card, EmptyState, Field, Menu, SummaryTable } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Checkbox, Input, Pill, Select, Skeleton } from '@nexus/ui/primitives'
import { DateField, Modal } from '../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayInstant, decimal, type Phrase } from '../../../_shared/model'
import { DialogFrame } from '../../../_shared/parts'
import { DEPTH, DEPTH_NAMESPACES, type DepthProblem } from '../../../invoices/test-mode/depth'
import type { CompanyTax, TaxCode, TaxCodes } from '../api'
import { CODE_ROWS, codeProblems, codesShown, codeVerbs, FORM_FIELDS, NATURA_CHOICES, RULE_CHOICES, rowSelectable, STATE_TONE, SWITCHES, switchHeld, switchOn, type AnySwitch, type CodeDraft, type CodeForm, type CodeRows, type TaxDialog, type TaxSetUpAbilities } from '../model'
import '../../../_shared/finance.css'

export interface TaxSetUpModel {
  can: TaxSetUpAbilities
  today: string
  company: { value: CompanyTax | null; problem: string | null }
  codes: { value: TaxCodes | null; problem: string | null }
  rows: CodeRows
  dialog: TaxDialog | null
  draft: CodeDraft
  /** "Your accountant confirmed this": switching a duty on, confirming a code. */
  ticked: boolean
  busy: boolean
  problem: DepthProblem | null
  notice: { tone: 'success' | 'warning' | 'danger'; words: Phrase } | null
  /** Design cases: the starting selection. */
  selected?: string[]
}

export interface TaxSetUpActions {
  onRows?: (rows: CodeRows) => void
  onRetry?: () => void
  onDialog?: (dialog: TaxDialog | null) => void
  onDraft?: (patch: Partial<CodeDraft>) => void
  onTick?: (ticked: boolean) => void
  onSave?: () => void
  onVerb?: () => void
  onSwitch?: () => void
  onDismissNotice?: () => void
}

/**
 * Finance settings › Tax set-up (design finance.settings sec:company "Per company (W2b tax configuration: rates, reason
 * codes, effective dates)"; FIN-107; GATE-ACCOUNTANT): the company's four switches the accountant decides — the tax codes,
 * stamp duty charged to the customer, declarations of intent, and self-invoices with debit notes and the VAT time limit —
 * each saying what it does, or what waits for the accountant while it is off (switching asks the accountant's word and a
 * fresh code); the tax codes as data on the shared list frame (rate or Natura with its law, the account key, the rule, the
 * days in force, the accountant's confirmation; New code, Edit while planned, Change the label, End, New version from a
 * later day — a code in force is never edited —, Archive, Delete while planned, Confirm N / Archive N); the rules the codes
 * follow, the catalogue's word beside the company's.
 */
export function TaxSetUpCard({ model, actions }: { model: TaxSetUpModel; actions?: TaxSetUpActions }) {
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <TaxCard model={model} actions={actions} />
    </WithMessages>
  )
}

function TaxCard({ model, actions }: { model: TaxSetUpModel; actions?: TaxSetUpActions }) {
  const t = useT('finance')
  const w = useT(DEPTH)
  const lists = useT('lists')
  const locale = useLocale()
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [help, setHelp] = useState(false)
  const all = model.codes.value?.codes ?? null
  const items = all ? codesShown(all, model.rows) : null
  const rowsKey = items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : '—')
  const company = model.company.value

  const columns = useMemo<ColDef<TaxCode>[]>(() => {
    const CodeCell = ({ data }: ICellRendererParams<TaxCode>) =>
      data ? (
        <span className="fw-fin-cell">
          <b className="fw-fin-code">{data.code}</b>
          <span className="fw-fin-cell-sub fw-fin-ellipsis">{data.label}</span>
        </span>
      ) : null
    const TreatmentCell = ({ data }: ICellRendererParams<TaxCode>) =>
      data ? (
        <span className="fw-fin-cell">
          <span>{data.natura ? w('tax.natura', { natura: data.natura }) : w('tax.rate', { rate: decimal(data.ratePct, locale, 2) })}</span>
          <span className="fw-fin-cell-sub fw-fin-ellipsis">{data.legalRef ?? (data.accountCodeKey ? w('tax.account', { key: data.accountCodeKey }) : '—')}</span>
        </span>
      ) : null
    const PeriodCell = ({ data }: ICellRendererParams<TaxCode>) =>
      data ? (
        <span className="fw-fin-cell">
          <span>{data.validTo ? w('tax.period', { from: day(data.validFrom), to: day(data.validTo) }) : w('tax.periodOpen', { from: day(data.validFrom) })}</span>
          <span className="fw-fin-cell-sub">{data.ruleId ?? w('tax.noRule')}</span>
        </span>
      ) : null
    const StateCell = ({ data }: ICellRendererParams<TaxCode>) =>
      data ? (
        <span className="fw-fin-cell">
          <Pill tone={STATE_TONE[data.state]}>{w(`tax.state.${data.state}`)}</Pill>
          <span className="fw-fin-cell-sub">{data.verification === 'UNVERIFIED' ? w('tax.unverified') : data.confirmedAt ? w('tax.verified', { date: formatDate(data.confirmedAt, { locale }) }) : w('tax.verifiedBuiltIn')}</span>
        </span>
      ) : null
    const MoreCell = ({ data }: ICellRendererParams<TaxCode>) => {
      if (!data) return null
      const now = latest.current
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': w('tax.rowMenu', { code: data.code }) }}
          items={codeVerbs(data, now.model.can).map((verb) => ({
            id: verb.id,
            label: w(`tax.verb.${verb.id}`),
            ...(verb.id === 'archive' || verb.id === 'delete' ? { tone: 'danger' as const } : {}),
            disabled: !!verb.held,
            description: verb.held ? w(verb.held.key) : undefined,
            onSelect: () =>
              now.actions?.onDialog?.(verb.id === 'archive' || verb.id === 'delete' || verb.id === 'confirm' ? { kind: 'verb', verb: verb.id, codes: [data] } : { kind: 'form', mode: verb.id, code: data }),
          }))}
        />
      )
    }
    return [
      { colId: 'code', headerName: w('tax.col.code'), minWidth: 190, flex: 1.3, cellRenderer: CodeCell },
      { colId: 'treatment', headerName: w('tax.col.treatment'), minWidth: 200, flex: 1.4, cellRenderer: TreatmentCell },
      { colId: 'period', headerName: w('tax.col.period'), minWidth: 190, flex: 1.1, cellRenderer: PeriodCell },
      { colId: 'state', headerName: w('tax.col.state'), minWidth: 170, flex: 1, cellRenderer: StateCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, w, locale])

  const picked = (items ?? []).filter((row) => selected.includes(row.id))
  const toConfirm = picked.filter((row) => row.can.confirm)
  const toArchive = picked.filter((row) => row.can.archive)
  const newHeld = model.can.manage ? (model.busy ? w('held.busy') : null) : w('held.noTaxManage')
  const ownKeys: ListKey[] = [{ keys: ['n'], does: w('tax.keyNew') }]

  // n: New code — never while typing or inside a dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || help || model.dialog) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      if (event.key === 'n' && !newHeld) {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'form', mode: 'new', code: null })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const state = model.codes.problem ? (
    <EmptyState title={w('tax.failed')} description={t(model.codes.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : items && items.length === 0 ? (
    <EmptyState title={w('tax.empty.title')} description={w('tax.empty.body')} action={<Button size="sm" heldReason={newHeld} onClick={() => actions?.onDialog?.({ kind: 'form', mode: 'new', code: null })}>{w('tax.new')}</Button>} />
  ) : undefined

  return (
    <Card padded className="fw-fin-card">
      <div className="fw-fin-card-head">
        <h2 className="fw-fin-h2">{w('tax.title')}</h2>
        <Button size="sm" heldReason={newHeld} onClick={() => actions?.onDialog?.({ kind: 'form', mode: 'new', code: null })} aria-keyshortcuts="n">
          <Plus size={14} aria-hidden /> {w('tax.new')}
        </Button>
      </div>
      <p className="fw-fin-hint">{w('tax.explain')}</p>
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={w(model.notice.words.key, model.notice.words.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      <h3 className="fw-fin-h3">{w('tax.switches')}</h3>
      {model.company.problem ? (
        <p className="fw-fin-hint">{w('tax.switchesFailed', { why: t(model.company.problem) })}</p>
      ) : !company ? (
        <div className="fw-fin-stack-tight" aria-busy="true">
          <Skeleton height={16} />
          <Skeleton height={16} />
        </div>
      ) : (
        <ul className="fw-fin-steps" aria-label={w('tax.switches')}>
          {SWITCHES.map((name) => {
            const on = switchOn(company, name)
            const held = switchHeld(model.can, model.busy)
            return (
              <li key={name} className="fw-fin-check">
                <Pill tone={on ? 'success' : 'warning'}>{w(on ? 'tax.switch.on' : 'tax.switch.off')}</Pill>
                <span className="fw-fin-step-body">
                  <b>{w(`tax.switch.${name}.title`)}</b>
                  <span className="fw-fin-step-time">{w(`tax.switch.${name}.${on ? 'on' : 'off'}`)}</span>
                </span>
                <Button size="sm" heldReason={held ? w(held.key) : null} onClick={() => actions?.onDialog?.({ kind: 'switch', name, on: !on })}>
                  {w(on ? 'tax.switchOff' : 'tax.switchOnVerb')}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      <h3 className="fw-fin-h3">{w('tax.codes')}</h3>
      <ListFrame<TaxCode>
        label={w('tax.codes')}
        rows={state ? [] : items}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? w('tax.count', { count: items.length }) : '—'}
        tools={
          <Select size="sm" aria-label={w('tax.rowsLabel')} value={model.rows} onChange={(event) => actions?.onRows?.(event.target.value as CodeRows)}>
            {CODE_ROWS.map((view) => (
              <option key={view} value={view}>
                {w(`tax.rows.${view}`)}
              </option>
            ))}
          </Select>
        }
        listKey="finance.settings.tax-codes"
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <>
              {toConfirm.length > 0 && (
                <Button size="sm" variant="primary" heldReason={!model.can.switch ? w('held.noTaxSwitch') : model.busy ? w('held.busy') : null} aria-label={w('tax.bulkConfirm', { count: toConfirm.length })} onClick={() => actions?.onDialog?.({ kind: 'verb', verb: 'confirm', codes: toConfirm })}>
                  <BadgeCheck size={13} aria-hidden /> <SelectionLabel>{w('tax.bulkConfirm', { count: toConfirm.length })}</SelectionLabel>
                </Button>
              )}
              {toArchive.length > 0 && (
                <Button size="sm" heldReason={!model.can.manage ? w('held.noTaxManage') : model.busy ? w('held.busy') : null} aria-label={w('tax.bulkArchive', { count: toArchive.length })} onClick={() => actions?.onDialog?.({ kind: 'verb', verb: 'archive', codes: toArchive })}>
                  <SelectionLabel>{w('tax.bulkArchive', { count: toArchive.length })}</SelectionLabel>
                </Button>
              )}
            </>
          ),
        }}
        isRowSelectable={(row) => {
          const held = rowSelectable(row, model.can)
          return held ? w(held.key) : null
        }}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        onOpen={(row) => {
          const first = codeVerbs(row, model.can).find((verb) => verb.id === 'edit' || verb.id === 'relabel')
          if (first && !first.held) actions?.onDialog?.({ kind: 'form', mode: first.id as 'edit' | 'relabel', code: row })
        }}
        state={state}
      />
      {model.codes.value && model.codes.value.rules.length > 0 && (
        <>
          <h3 className="fw-fin-h3">{w('tax.rules')}</h3>
          <SummaryTable
            label={w('tax.rules')}
            columns={[w('tax.rule.col.rule'), w('tax.rule.col.catalogue'), w('tax.rule.col.company'), w('tax.rule.col.codes')]}
            rows={model.codes.value.rules.map((rule) => ({
              id: rule.id,
              cells: [
                <span key="r" className="fw-fin-cell">
                  <b>{rule.id}</b>
                  <span className="fw-fin-cell-sub">{rule.law}</span>
                </span>,
                <Pill key="c" tone={rule.catalogueStatus === 'VERIFIED' ? 'success' : 'warning'}>{w(`tax.rule.${rule.catalogueStatus}`)}</Pill>,
                <Pill key="s" tone={rule.status === 'VERIFIED' ? 'success' : 'warning'}>{w(`tax.rule.${rule.status}`)}</Pill>,
                String(rule.taxCodeIds.length),
              ],
            }))}
            stackOnPhone
          />
        </>
      )}
      {model.dialog?.kind === 'form' && <CodeFormDialog model={model} mode={model.dialog.mode} code={model.dialog.code} actions={actions} />}
      {model.dialog?.kind === 'verb' && <VerbDialog model={model} verb={model.dialog.verb} codes={model.dialog.codes} actions={actions} />}
      {model.dialog?.kind === 'switch' && company && <SwitchDialog model={model} company={company} name={model.dialog.name} on={model.dialog.on} actions={actions} />}
      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('list.keysTitle')} size="sm">
          <ul className="fw-fin-list">
            {listKeys(ownKeys, true).map((entry) => (
              <li key={entry.does}>
                <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </Card>
  )
}

/** A code's form: new, edit while planned, change the label, end it, or its next version from a later day. */
function CodeFormDialog({ model, mode, code, actions }: { model: TaxSetUpModel; mode: CodeForm; code: TaxCode | null; actions?: TaxSetUpActions }) {
  const t = useT('finance')
  const w = useT(DEPTH)
  const locale = useLocale()
  const draft = model.draft
  const fields = new Set(FORM_FIELDS[mode])
  const problems = codeProblems(mode, draft, code, model.today)
  const first = Object.values(problems)[0]
  const held = model.busy ? w('held.busy') : !model.can.manage ? w('held.noTaxManage') : first ? w('tax.held.fix') : null
  const zero = Number(draft.ratePct.replace(',', '.')) === 0
  const error = (field: keyof CodeDraft) => (problems[field] ? w(problems[field]!) : undefined)
  const title = code ? w(`tax.form.${mode}`, { code: code.code }) : w('tax.form.new')
  const dates = locale === 'it' ? 'it-IT' : 'en-GB'
  return (
    <DialogFrame title={title} held={held} go={() => actions?.onSave?.()} goLabel={model.busy ? t('common.working') : w(`tax.form.go.${mode}`)} onClose={() => actions?.onDialog?.(null)} problem={model.problem ? { key: model.problem.key, ...(model.problem.params ? { params: model.problem.params } : {}) } : null} size="lg">
      <p className="fw-fin-hint">{w(`tax.form.explain.${mode}`)}</p>
      {fields.has('code') && (
        <div className="fw-fin-two">
          <Field label={w('tax.field.code')} hint={w('tax.field.codeHint')} error={draft.code ? error('code') : undefined}>
            <Input value={draft.code} maxLength={20} onChange={(event) => actions?.onDraft?.({ code: event.target.value.toUpperCase() })} autoComplete="off" />
          </Field>
          <Field label={w('tax.field.country')} error={error('country')}>
            <Input value={draft.country} maxLength={2} onChange={(event) => actions?.onDraft?.({ country: event.target.value.toUpperCase() })} autoComplete="off" />
          </Field>
        </div>
      )}
      {fields.has('label') && (
        <Field label={w('tax.field.label')} hint={w('tax.field.labelHint')} error={draft.label ? error('label') : undefined}>
          <Input value={draft.label} maxLength={200} onChange={(event) => actions?.onDraft?.({ label: event.target.value })} autoComplete="off" />
        </Field>
      )}
      {fields.has('ratePct') && (
        <div className="fw-fin-two">
          <Field label={w('tax.field.rate')} hint={w('tax.field.rateHint')} error={error('ratePct')}>
            <Input inputMode="decimal" value={draft.ratePct} onChange={(event) => actions?.onDraft?.({ ratePct: event.target.value, ...(Number(event.target.value.replace(',', '.')) === 0 ? {} : { natura: '', legalRef: '' }) })} autoComplete="off" />
          </Field>
          <Field label={w('tax.field.natura')} hint={w(zero ? 'tax.field.naturaHint' : 'tax.field.naturaRate')} error={error('natura')}>
            <Select value={draft.natura} disabled={!zero} onChange={(event) => actions?.onDraft?.({ natura: event.target.value })}>
              <option value="">{w('tax.field.noNatura')}</option>
              {NATURA_CHOICES.map((natura) => (
                <option key={natura} value={natura}>
                  {natura}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
      {fields.has('legalRef') && zero && (
        <Field label={w('tax.field.legalRef')} hint={w('tax.field.legalRefHint')} error={error('legalRef')}>
          <Input value={draft.legalRef} maxLength={100} onChange={(event) => actions?.onDraft?.({ legalRef: event.target.value })} autoComplete="off" />
        </Field>
      )}
      {fields.has('accountCodeKey') && (
        <div className="fw-fin-two">
          <Field label={w('tax.field.account')} hint={w('tax.field.accountHint')} error={error('accountCodeKey')}>
            <Input value={draft.accountCodeKey} maxLength={60} onChange={(event) => actions?.onDraft?.({ accountCodeKey: event.target.value })} autoComplete="off" />
          </Field>
          <Field label={w('tax.field.rule')} error={error('ruleId')}>
            <Select value={draft.ruleId} onChange={(event) => actions?.onDraft?.({ ruleId: event.target.value })}>
              <option value="">{w('tax.noRule')}</option>
              {RULE_CHOICES.map((rule) => (
                <option key={rule} value={rule}>
                  {rule}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
      {(fields.has('validFrom') || fields.has('validTo')) && (
        <div className="fw-fin-two">
          {fields.has('validFrom') && (
            <Field label={w(mode === 'version' ? 'tax.field.versionFrom' : 'tax.field.validFrom')} error={error('validFrom')}>
              <DateField value={draft.validFrom} locale={dates} onChange={(value) => actions?.onDraft?.({ validFrom: value ?? '' })} />
            </Field>
          )}
          {fields.has('validTo') && (
            <Field label={w('tax.field.validTo')} hint={w(mode === 'end' ? 'tax.field.endHint' : 'tax.field.validToHint')} error={error('validTo')}>
              <DateField value={draft.validTo} locale={dates} clearable={mode !== 'end'} onChange={(value) => actions?.onDraft?.({ validTo: value ?? '' })} />
            </Field>
          )}
        </div>
      )}
      {mode !== 'relabel' && mode !== 'end' && <p className="fw-fin-hint">{w('tax.form.unverified')}</p>}
    </DialogFrame>
  )
}

/** Archive, delete or confirm (the accountant's word, with a fresh code) one code or several. */
function VerbDialog({ model, verb, codes, actions }: { model: TaxSetUpModel; verb: 'archive' | 'delete' | 'confirm'; codes: TaxCode[]; actions?: TaxSetUpActions }) {
  const t = useT('finance')
  const w = useT(DEPTH)
  const held = model.busy ? w('held.busy') : verb === 'confirm' && !model.ticked ? w('tax.held.tick') : null
  return (
    <DialogFrame
      title={w(`tax.verbTitle.${verb}`, { count: codes.length })}
      held={held}
      go={() => actions?.onVerb?.()}
      goLabel={model.busy ? t('common.working') : w(`tax.verbGo.${verb}`, { count: codes.length })}
      onClose={() => actions?.onDialog?.(null)}
      problem={model.problem ? { key: model.problem.key, ...(model.problem.params ? { params: model.problem.params } : {}) } : null}
      tone={verb === 'confirm' ? 'primary' : 'danger'}
    >
      <p className="fw-fin-hint">{w(`tax.verbExplain.${verb}`)}</p>
      <ul className="fw-fin-list">
        {codes.map((code) => (
          <li key={code.id}>
            <b className="fw-fin-code">{code.code}</b> · {code.label}
          </li>
        ))}
      </ul>
      {verb === 'confirm' && <Checkbox checked={model.ticked} onChange={(event) => actions?.onTick?.(event.target.checked)} label={w('tax.tickConfirm')} />}
    </DialogFrame>
  )
}

/** Switch a duty on (the accountant's word) or off; both ask a fresh code. */
function SwitchDialog({ model, company, name, on, actions }: { model: TaxSetUpModel; company: CompanyTax; name: AnySwitch; on: boolean; actions?: TaxSetUpActions }) {
  const t = useT('finance')
  const w = useT(DEPTH)
  const held = model.busy ? w('held.busy') : on && !model.ticked ? w('tax.held.tick') : null
  return (
    <DialogFrame
      title={w(on ? 'tax.switchTitleOn' : 'tax.switchTitleOff', { name: w(`tax.switch.${name}.title`) })}
      held={held}
      go={() => actions?.onSwitch?.()}
      goLabel={model.busy ? t('common.working') : w(on ? 'tax.switchOnVerb' : 'tax.switchOff')}
      onClose={() => actions?.onDialog?.(null)}
      problem={model.problem ? { key: model.problem.key, ...(model.problem.params ? { params: model.problem.params } : {}) } : null}
    >
      <p className="fw-fin-hint">{w(`tax.switch.${name}.${on ? 'on' : 'off'}`)}</p>
      {on ? <Checkbox checked={model.ticked} onChange={(event) => actions?.onTick?.(event.target.checked)} label={w('tax.tickSwitch', { company: company.legalName })} /> : <p className="fw-fin-hint">{w('tax.switchOffNote')}</p>}
      <p className="fw-fin-hint">{w('tax.stepUpNote')}</p>
    </DialogFrame>
  )
}
