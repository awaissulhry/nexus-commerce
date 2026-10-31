'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { X } from 'lucide-react'
import { Banner, Field, Listbox, Modal } from '@nexus/ui/components'
import { Button, Checkbox, Input, Kbd, RadioCard, Select, Tag, Textarea } from '@nexus/ui/primitives'
import { REVERSAL_REASONS } from '@nexus/factory-domain/quality/release/rules'
import { RETURN_CAUSES, RETURN_GRADES } from '@nexus/factory-domain/sales/returns/rules'
import { useT } from '../../../../lib/i18n/provider'
import { recordAddress } from '../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { dash, Facts } from '../../_shared/parts'
import type { QualityCan, Read } from '../../_shared/model'
import type { Inspectors, PartyPick, ReleaseDetail, ReleaseRule, ReturnPick, ReturnRecord, WorkOrderCells, WorkOrderPick } from '../api'
import {
  finishedOf,
  impactLines,
  inspectorHeld,
  kindHeld,
  NEW_KINDS,
  returnProblems,
  isSerialRelease,
  newProblems,
  partyName,
  reverseProblems,
  reversibleSerials,
  ruleChanged,
  ruleLoosens,
  ruleProblems,
  workOrderWords,
  type NewDraft,
  type ReturnDraft,
  type ReverseDraft,
  type RuleDraft,
} from '../model'

/** ⌘↵ submits a dialog's form (when its primary is not held). */
function useSubmitKey(open: boolean, onSubmit: () => void) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        onSubmit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onSubmit])
}

/** The problems of a dialog in words (one banner, every problem listed). */
function Problems({ keys, lines, title }: { keys: readonly string[]; lines?: readonly string[]; title?: string }) {
  const t = useT('quality')
  if (keys.length === 0 && (!lines || lines.length === 0)) return null
  return (
    <Banner tone="warning" title={title ?? t('common.fixFirst')}>
      <ul className="fw-q-lines">
        {keys.map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
        {lines?.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </Banner>
  )
}

// ---- New inspection ----------------------------------------------------------------------------------------------------------

export function NewInspectionModal({
  open,
  draft,
  workOrders,
  cells,
  busy,
  problem,
  lines,
  can,
  prefix,
  people,
  returns,
  returnRecord,
  returnDraft,
  onDraft,
  onPick,
  onCreate,
  onPickReturn,
  onReturnDraft,
  onGradeReturn,
  onClose,
}: {
  open: boolean
  draft: NewDraft
  workOrders: Read<readonly WorkOrderPick[]>
  cells: Read<WorkOrderCells> | null
  busy?: boolean
  problem?: string | null
  lines?: readonly string[]
  can: QualityCan
  prefix: string
  /** W2a: the inspectors of the picked work order's site (Inspector, optional). */
  people: Read<Inspectors> | null
  /** W2a: the Return kind — returns waiting, the picked one, its grades. */
  returns: Read<readonly ReturnPick[]> | null
  returnRecord: Read<ReturnRecord> | null
  returnDraft: ReturnDraft
  onDraft: (draft: NewDraft) => void
  onPick: (workOrderId: string) => void
  onCreate: () => void
  onPickReturn: (returnId: string) => void
  onReturnDraft: (draft: ReturnDraft) => void
  onGradeReturn: () => void
  onClose: () => void
}) {
  const t = useT('quality')
  const [tried, setTried] = useState(false)
  useEffect(() => {
    if (open) setTried(false)
  }, [open])
  const finished = finishedOf(cells?.value ?? null)
  const kindReason = kindHeld(draft.kind, can)
  const pickedPerson = people?.value?.inspectors.find((person) => `${person.kind}:${person.id}` === draft.assignee) ?? null
  const personHeld = pickedPerson ? inspectorHeld(pickedPerson) : null
  const problems = draft.kind === 'FINAL' ? newProblems(draft, finished) : draft.kind === 'RETURN' ? returnProblems(returnDraft, returnRecord?.value ?? null) : []
  const held = busy
    ? t('common.working')
    : kindReason
      ? t(kindReason)
      : draft.kind === 'LOT'
        ? t('new.kind.lotElsewhere')
        : personHeld
          ? t(personHeld.key, personHeld.params)
          : problems.length > 0
            ? t(problems[0]!)
            : null
  const submit = () => {
    setTried(true)
    if (held) return
    if (draft.kind === 'RETURN') onGradeReturn()
    else onCreate()
  }
  useSubmitKey(open, submit)
  const set = (change: Partial<NewDraft>) => onDraft({ ...draft, ...change })
  const options = (workOrders.value ?? []).map((wo) => ({ value: wo.id, label: workOrderWords(wo), note: t(`woStatus.${wo.status}`, { site: wo.siteCode }) }))
  const field = (key: 'lotSize' | 'sampleSize' | 'inspectionLevel' | 'aqlMajor' | 'aqlMinor' | 'acceptMajor' | 'acceptMinor', label: string, hint?: string, inputMode: 'numeric' | 'decimal' | 'text' = 'numeric') => (
    <Field label={label} hint={hint} required>
      <Input size="sm" inputMode={inputMode} value={draft[key] ?? ''} onChange={(event) => set({ [key]: event.target.value } as Partial<NewDraft>)} />
    </Field>
  )
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('new.title')}
      subtitle={t('new.subtitle')}
      size="lg"
      footer={
        <>
          <span className="fw-q-hint">
            <Kbd>⌘</Kbd>
            <Kbd>↵</Kbd> {t('new.keyHint')}
          </span>
          <span className="grow" />
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={submit} heldReason={held}>
            {draft.kind === 'RETURN' ? t('new.return.record') : t('new.create')}
          </Button>
        </>
      }
    >
      <div className="fw-q-form">
        <fieldset className="fw-q-choices fw-q-kinds">
          <legend>
            <strong>{t('new.kind.label')}</strong>
          </legend>
          {NEW_KINDS.map((kind) => {
            const reason = kindHeld(kind, can)
            return (
              <RadioCard
                key={kind}
                name="new-kind"
                checked={draft.kind === kind}
                selected={draft.kind === kind}
                disabled={kind === 'INLINE'}
                onChange={() => set({ kind })}
                title={t(`new.kind.${kind}`)}
                description={reason && kind !== 'FINAL' ? t(reason) : t(`new.kind.${kind}Hint`)}
              />
            )
          })}
        </fieldset>

        {draft.kind === 'LOT' && (
          <Banner tone="info" title={t('new.kind.lotElsewhere')}>
            <Link className="fw-q-link" href={`${prefix}/compliance/tests?view=waiting`}>
              {t('new.kind.lotOpen')}
            </Link>
          </Banner>
        )}

        {draft.kind === 'RETURN' && (
          <ReturnPanel returns={returns} record={returnRecord} draft={returnDraft} prefix={prefix} onPick={onPickReturn} onDraft={onReturnDraft} />
        )}

        {draft.kind === 'FINAL' && (
          <>
            {workOrders.problem && <Banner tone="danger" title={t('new.workOrdersFailed')}>{t(workOrders.problem)}</Banner>}
            <Field label={t('new.workOrder')} hint={t('new.workOrderHint')} required>
              <Listbox
                size="sm"
                options={options}
                value={draft.workOrderId ?? undefined}
                onChange={onPick}
                placeholder={workOrders.value === null && !workOrders.problem ? t('common.loading') : t('new.workOrderPick')}
                searchable
                searchPlaceholder={t('new.workOrderSearch')}
                ariaLabel={t('new.workOrder')}
              />
            </Field>
            {workOrders.value?.length === 0 && <p className="fw-q-hint">{t('new.noWorkOrder')}</p>}
            {draft.workOrderId && cells && (
              <div className="fw-q-hint" role="status">
                {cells.problem
                  ? t(cells.problem)
                  : cells.value === null
                    ? t('common.loading')
                    : finished === null
                      ? t('new.finishedUnknown', { style: `${cells.value.style.code} ${cells.value.style.name}` })
                      : t('new.finished', { count: finished, pieces: cells.value.pieces, style: `${cells.value.style.code} ${cells.value.style.name}` })}
              </div>
            )}
            <div className="fw-q-form-three">
              {field('lotSize', t('new.lotSize'), t('new.lotSizeHint'))}
              {field('sampleSize', t('new.sampleSize'), t('new.sampleSizeHint'))}
              {field('inspectionLevel', t('new.level'), t('new.levelHint'), 'text')}
            </div>
            <div className="fw-q-form-two">
              {field('aqlMajor', t('new.aqlMajor'), t('new.aqlHint'), 'decimal')}
              {field('acceptMajor', t('new.acceptMajor'), t('new.acceptHint'))}
              {field('aqlMinor', t('new.aqlMinor'), t('new.aqlHint'), 'decimal')}
              {field('acceptMinor', t('new.acceptMinor'), t('new.acceptHint'))}
            </div>
            <p className="fw-q-hint">{t('new.tablesLater')}</p>
            <Field label={t('new.inspector')} hint={t('new.inspectorHint')}>
              {!draft.workOrderId ? (
                <p className="fw-q-hint">{t('new.inspectorAfterPick')}</p>
              ) : people?.problem ? (
                <p className="fw-q-hint">{t(people.problem)}</p>
              ) : !people?.value ? (
                <p className="fw-q-hint">{t('common.loading')}</p>
              ) : (
                <Select size="sm" aria-label={t('new.inspector')} value={draft.assignee} onChange={(event) => set({ assignee: event.target.value })}>
                  <option value="">{t('new.inspectorMe')}</option>
                  {people.value.inspectors
                    .filter((person) => !person.me)
                    .map((person) => (
                      <option key={`${person.kind}:${person.id}`} value={`${person.kind}:${person.id}`} disabled={person.made.length > 0}>
                        {person.kind === 'WORKER' ? t('assign.benchNamed', { name: person.name }) : person.name}
                        {person.made.length > 0 ? ` — ${t('assign.made', { orders: person.made.join(', ') })}` : ''}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
            <Field label={t('new.note')}>
              <Textarea value={draft.note} onChange={(event) => set({ note: event.target.value })} rows={2} />
            </Field>
            <p className="fw-q-hint">{t('new.numberWords')}</p>
          </>
        )}
        {tried && <Problems keys={problems} />}
        {problem && <Problems keys={[problem]} lines={lines} title={t('new.refusedTitle')} />}
      </div>
    </Modal>
  )
}

/** New inspection › Return (design qi-new "Return (W2a)"): a return received and waiting for its inspection, graded per line. */
function ReturnPanel({ returns, record, draft, prefix, onPick, onDraft }: { returns: Read<readonly ReturnPick[]> | null; record: Read<ReturnRecord> | null; draft: ReturnDraft; prefix: string; onPick: (returnId: string) => void; onDraft: (draft: ReturnDraft) => void }) {
  const t = useT('quality')
  const options = (returns?.value ?? []).map((entry) => ({ value: entry.id, label: `${entry.number} · ${entry.party?.legalName ?? ''}`, note: t('new.return.received', { received: entry.receivedUnits, units: entry.units, site: entry.site?.code ?? '' }) }))
  const lines = record?.value?.lines.filter((line) => line.receivedQuantity > 0) ?? []
  const setLine = (lineId: string, change: Partial<{ grade: string; cause: string; note: string }>) =>
    onDraft({ ...draft, lines: { ...draft.lines, [lineId]: { ...(draft.lines[lineId] ?? { grade: '', cause: '', note: '' }), ...change } } })
  return (
    <>
      {returns?.problem ? (
        <Banner tone="danger" title={t('new.return.failed')}>
          {t(returns.problem)}
        </Banner>
      ) : (
        <Field label={t('new.return.pick')} hint={t('new.return.pickHint')} required>
          <Listbox size="sm" options={options} value={draft.returnId ?? undefined} onChange={onPick} placeholder={returns?.value ? t('new.return.pickPlaceholder') : t('common.loading')} searchable ariaLabel={t('new.return.pick')} />
        </Field>
      )}
      {returns?.value?.length === 0 && <p className="fw-q-hint">{t('new.return.none')}</p>}
      {record?.problem && <p className="fw-q-hint">{t(record.problem)}</p>}
      {draft.returnId && record?.value === null && !record?.problem && <p className="fw-q-hint">{t('common.loading')}</p>}
      {lines.length > 0 && (
        <ul className="fw-q-return-lines">
          {lines.map((line) => {
            const value = draft.lines[line.id] ?? { grade: '', cause: '', note: '' }
            return (
              <li key={line.id} className="fw-q-return-line">
                <span className="fw-q-cell">
                  <strong>{line.description}</strong>
                  <span className="fw-q-hint">
                    {t('new.return.line', { received: line.receivedQuantity, quantity: line.quantity })}
                    {line.serial ? ` · ${line.serial}` : line.batchNumber ? ` · ${line.batchNumber}` : ''}
                  </span>
                  {line.safety && <Tag tone="warning">{t('new.return.safety')}</Tag>}
                </span>
                <div className="fw-q-form-three">
                  <Field label={t('new.return.grade')} required>
                    <Select size="sm" value={value.grade} onChange={(event) => setLine(line.id, { grade: event.target.value })}>
                      <option value="">{t('new.return.gradePick')}</option>
                      {RETURN_GRADES.map((grade) => (
                        <option key={grade} value={grade}>
                          {t(`new.return.grades.${grade}`)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t('new.return.cause')}>
                    <Select size="sm" value={value.cause} onChange={(event) => setLine(line.id, { cause: event.target.value })}>
                      <option value="">{t('new.return.causeNone')}</option>
                      {RETURN_CAUSES.map((cause) => (
                        <option key={cause} value={cause}>
                          {t(`new.return.causes.${cause}`)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t('new.return.note')}>
                    <Input size="sm" value={value.note} onChange={(event) => setLine(line.id, { note: event.target.value })} />
                  </Field>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {record?.value && lines.length === 0 && <p className="fw-q-hint">{t('new.return.problem.nothingReceived')}</p>}
      {record?.value && (
        <p className="fw-q-hint">
          {t('new.return.after')}{' '}
          <Link className="fw-q-link" href={`${prefix}${recordAddress({ type: 'ReturnAuthorisation', id: record.value.id, label: record.value.number }, OFFICE_PAGES)}`}>
            {t('new.return.openReturn', { number: record.value.number })}
          </Link>
        </p>
      )}
    </>
  )
}

// ---- Quality rules: the release rule (Owner answer Q1) --------------------------------------------------------------------------

export function RulesModal({
  open,
  rule,
  draft,
  canManage,
  canFindCustomers,
  search,
  busy,
  problem,
  companyName,
  onDraft,
  onSearch,
  onSave,
  onClose,
}: {
  open: boolean
  rule: Read<ReleaseRule>
  draft: RuleDraft | null
  canManage: boolean
  canFindCustomers: boolean
  search: Read<readonly PartyPick[]> | null
  busy?: boolean
  problem?: string | null
  companyName: string
  onDraft: (draft: RuleDraft) => void
  onSearch: (q: string) => void
  onSave: () => void
  onClose: () => void
}) {
  const t = useT('quality')
  const [query, setQuery] = useState('')
  const value = rule.value
  const problems = value && draft ? ruleProblems(value, draft) : []
  const loosens = value && draft ? ruleLoosens(value, draft) : false
  const changed = value && draft ? ruleChanged(value, draft) : false
  const held = !canManage ? t('held.noSettings') : busy ? t('common.working') : problems.length > 0 ? t(problems[0]!) : null
  useSubmitKey(open && canManage, () => {
    if (!held) onSave()
  })
  const listed = new Set(draft?.customers.map((customer) => customer.id) ?? [])
  const choices = (search?.value ?? []).filter((party) => !listed.has(party.id))
  const inForceKey = value ? `rules.rule.${value.inForce.rule}` : null
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('rules.title')}
      subtitle={t('rules.subtitle', { company: companyName })}
      size="lg"
      footer={
        <>
          <span className="grow" />
          <Button onClick={onClose}>{canManage ? t('common.cancel') : t('common.close')}</Button>
          {canManage && (
            <Button variant="primary" onClick={onSave} heldReason={held}>
              {loosens ? t('rules.saveLoosen') : t('rules.save')}
            </Button>
          )}
        </>
      }
    >
      <div className="fw-q-form">
        {rule.problem && <Banner tone="danger" title={t('rules.failed')}>{t(rule.problem)}</Banner>}
        {value && inForceKey && (
          <Banner tone="info" title={t('rules.inForce', { rule: t(inForceKey) })}>
            {t(`rules.source.${value.inForce.source}`)}
          </Banner>
        )}
        {!canManage && <p className="fw-q-hint">{t('held.noSettings')}</p>}
        {value && draft && (
          <>
            <fieldset className="fw-q-choices" disabled={!canManage}>
              <legend className="fw-q-section-title">
                <strong>{t('rules.fourEyes')}</strong>
              </legend>
              <RadioCard
                name="four-eyes"
                checked={draft.rule === null}
                selected={draft.rule === null}
                onChange={() => onDraft({ ...draft, rule: null })}
                title={t('rules.follow')}
                description={t('rules.followHint')}
              />
              <RadioCard
                name="four-eyes"
                checked={draft.rule === 'WHEN_REQUIRED'}
                selected={draft.rule === 'WHEN_REQUIRED'}
                onChange={() => onDraft({ ...draft, rule: 'WHEN_REQUIRED' })}
                title={t('rules.rule.WHEN_REQUIRED')}
                description={t('rules.whenRequiredHint')}
              />
              <RadioCard
                name="four-eyes"
                checked={draft.rule === 'ALWAYS'}
                selected={draft.rule === 'ALWAYS'}
                onChange={() => onDraft({ ...draft, rule: 'ALWAYS' })}
                title={t('rules.rule.ALWAYS')}
                description={t('rules.alwaysHint')}
              />
            </fieldset>
            <div className="fw-q-section">
              <div className="fw-q-section-title">
                <strong>{t('rules.customers')}</strong>
                <p className="fw-q-hint">{t('rules.customersHint')}</p>
              </div>
              {draft.customers.length === 0 ? (
                <p className="fw-q-hint">{t('rules.noCustomers')}</p>
              ) : (
                <ul className="fw-q-chips" aria-label={t('rules.customers')}>
                  {draft.customers.map((customer) => (
                    <li key={customer.id} className="fw-q-cell-row">
                      <span>
                        {customer.name} <span className="fw-q-code">{customer.code}</span>
                        {customer.listedOn === 'TENANT' && <span className="fw-q-hint"> · {t('rules.everyCompany')}</span>}
                      </span>
                      {canManage && customer.listedOn === 'COMPANY' && (
                        <Button size="xs" variant="quiet" aria-label={t('rules.remove', { name: customer.name })} onClick={() => onDraft({ ...draft, customers: draft.customers.filter((entry) => entry.id !== customer.id) })}>
                          <X size={12} aria-hidden />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {canManage &&
                (canFindCustomers ? (
                  <div className="fw-q-form-two">
                    <Field label={t('rules.find')}>
                      <Input
                        size="sm"
                        type="search"
                        value={query}
                        placeholder={t('rules.findPlaceholder')}
                        onChange={(event) => {
                          setQuery(event.target.value)
                          onSearch(event.target.value)
                        }}
                      />
                    </Field>
                    <div className="fw-q-choices" aria-live="polite">
                      {search?.problem && <p className="fw-q-hint">{t(search.problem)}</p>}
                      {search && search.value === null && !search.problem && <p className="fw-q-hint">{t('common.loading')}</p>}
                      {search?.value && choices.length === 0 && <p className="fw-q-hint">{t('rules.noMatch')}</p>}
                      {choices.slice(0, 6).map((party) => (
                        <Button
                          key={party.id}
                          size="sm"
                          onClick={() => onDraft({ ...draft, customers: [...draft.customers, { id: party.id, code: party.code, name: partyName(party), listedOn: 'COMPANY' }] })}
                        >
                          {t('rules.add', { name: partyName(party) })}
                        </Button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="fw-q-hint">{t('held.noParties')}</p>
                ))}
            </div>
            <div className="fw-q-section">
              <div className="fw-q-section-title">
                <strong>{t('rules.reversalTitle')}</strong>
                <p className="fw-q-hint">{t('rules.reversalFixed')}</p>
              </div>
            </div>
            {canManage && changed && loosens && (
              <Field label={t('rules.reason')} hint={t('rules.reasonHint')} required>
                <Textarea value={draft.reason} onChange={(event) => onDraft({ ...draft, reason: event.target.value })} rows={2} />
              </Field>
            )}
            {canManage && changed && !loosens && <p className="fw-q-hint">{t('rules.tightens')}</p>}
          </>
        )}
        {problem && <Banner tone="danger" title={t(problem)} />}
      </div>
    </Modal>
  )
}

// ---- Reverse a release (impact first) ---------------------------------------------------------------------------------------------

export function ReverseModal({
  open,
  detail,
  draft,
  busy,
  problem,
  lines,
  onDraft,
  onReverse,
  onClose,
}: {
  open: boolean
  detail: ReleaseDetail | null
  draft: ReverseDraft
  busy?: boolean
  problem?: string | null
  lines?: readonly string[]
  onDraft: (draft: ReverseDraft) => void
  onReverse: () => void
  onClose: () => void
}) {
  const t = useT('quality')
  const [tried, setTried] = useState(false)
  useEffect(() => {
    if (open) setTried(false)
  }, [open])
  const problems = detail ? reverseProblems(draft, detail) : []
  const held = busy ? t('common.working') : problems.length > 0 ? t(problems[0]!) : null
  const submit = () => {
    setTried(true)
    if (!held) onReverse()
  }
  useSubmitKey(open, submit)
  const serial = detail ? isSerialRelease(detail.release) : false
  const quantity = serial ? draft.serialIds.length : Number(draft.quantity) || 0
  const reasons = useMemo(() => REVERSAL_REASONS.map((code) => ({ value: code, label: t(`reason.${code}`) })), [t])
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('reverse.title')}
      subtitle={detail ? t('reverse.subtitle', { release: detail.release.releaseNumber ?? detail.release.number }) : undefined}
      size="lg"
      footer={
        <>
          <span className="grow" />
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="danger" onClick={submit} heldReason={held}>
            {t('reverse.confirm', { count: quantity })}
          </Button>
        </>
      }
    >
      {detail && (
        <div className="fw-q-form">
          <Banner tone="warning" title={t('reverse.impactTitle')}>
            <ul className="fw-q-lines">
              {impactLines(detail.reverseImpact).map((line) => (
                <li key={line.key}>{t(line.key, line.params)}</li>
              ))}
            </ul>
          </Banner>
          <p className="fw-q-hint">{t('reverse.onePerson')}</p>
          {serial ? (
            <>
              <fieldset className="fw-q-choices">
                <legend>
                  <strong>{t('reverse.serials')}</strong>
                </legend>
                {reversibleSerials(detail.release).length === 0 && <p className="fw-q-hint">{t('reverse.noSerials')}</p>}
                {reversibleSerials(detail.release).map((serialRow) => (
                  <Checkbox
                    key={serialRow.id}
                    checked={draft.serialIds.includes(serialRow.id)}
                    onChange={(event) =>
                      onDraft({ ...draft, serialIds: event.target.checked ? [...draft.serialIds, serialRow.id] : draft.serialIds.filter((id) => id !== serialRow.id) })
                    }
                    label={<span className="fw-q-code">{serialRow.serial}</span>}
                  />
                ))}
              </fieldset>
              <fieldset className="fw-q-choices">
                <legend>
                  <strong>{t('reverse.serialsTo')}</strong>
                </legend>
                <RadioCard name="serials-to" checked={draft.serialsTo === 'MADE'} selected={draft.serialsTo === 'MADE'} onChange={() => onDraft({ ...draft, serialsTo: 'MADE' })} title={t('reverse.toMade')} description={t('reverse.toMadeHint')} />
                <RadioCard name="serials-to" checked={draft.serialsTo === 'VOID'} selected={draft.serialsTo === 'VOID'} onChange={() => onDraft({ ...draft, serialsTo: 'VOID' })} title={t('reverse.toVoid')} description={t('reverse.toVoidHint')} />
              </fieldset>
            </>
          ) : (
            <Field label={t('reverse.quantity')} hint={t('reverse.quantityHint', { count: detail.reverseImpact.reversible })} required>
              <Input size="sm" inputMode="numeric" value={draft.quantity} onChange={(event) => onDraft({ ...draft, quantity: event.target.value })} />
            </Field>
          )}
          <Field label={t('reverse.reasonCode')} required>
            <Listbox size="sm" options={reasons} value={draft.reasonCode ?? undefined} onChange={(code) => onDraft({ ...draft, reasonCode: code as ReverseDraft['reasonCode'] })} placeholder={t('reverse.reasonPick')} ariaLabel={t('reverse.reasonCode')} />
          </Field>
          <Field label={t('reverse.reason')} hint={t('reverse.reasonHint')} required>
            <Textarea value={draft.reason} onChange={(event) => onDraft({ ...draft, reason: event.target.value })} rows={3} />
          </Field>
          <p className="fw-q-hint">{t('reverse.stays')}</p>
          {tried && <Problems keys={problems} />}
          {problem && <Problems keys={[problem]} lines={lines} title={t('reverse.refused')} />}
        </div>
      )}
    </Modal>
  )
}

// ---- keys -------------------------------------------------------------------------------------------------------------------

export function ShortcutsModal({ open, keys, onClose }: { open: boolean; keys: ReadonlyArray<{ keys: readonly string[]; does: string }>; onClose?: () => void }) {
  const t = useT('quality')
  return (
    <Modal open={open} onClose={() => onClose?.()} title={t('keys.title')} size="sm" footer={<Button onClick={() => onClose?.()}>{t('common.close')}</Button>}>
      <dl className="fw-q-keymap">
        {keys.map((entry) => (
          <Fragment key={entry.does}>
            <dt>
              {entry.keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </dt>
            <dd>{entry.does}</dd>
          </Fragment>
        ))}
      </dl>
    </Modal>
  )
}

/** A few facts of a release (number, work order, garments): the head of its DetailModal and of the reversal. */
export function ReleaseFacts({ detail }: { detail: ReleaseDetail }) {
  const t = useT('quality')
  const release = detail.release
  return (
    <Facts
      items={[
        { label: t('releaseDetail.garments'), value: release.quantity },
        { label: t('releaseDetail.takenBack'), value: release.reversed },
        { label: t('releaseDetail.onHold'), value: release.onHold },
        { label: t('releaseDetail.workOrder'), value: <span className="fw-q-code">{release.number}</span> },
        { label: t('releaseDetail.signature'), value: <span className="fw-q-code">{dash(release.signatureSha256.slice(0, 16))}…</span> },
      ]}
    />
  )
}
