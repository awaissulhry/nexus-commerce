'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Check, Plus, X } from 'lucide-react'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, Select, Tag } from '@nexus/ui/primitives'
import { CAPA_LIMITS, CAPA_PRIORITIES, STAGES } from '@nexus/factory-domain/quality/capa/rules'
import { DateField, EditModeBar, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import type { CapaPriority, CapaRecord, CapaStatus } from '../../api'
import { editHeld, problemChangesOf, problemDraftOf, problemDraftProblems, removeSourceHeld, sourceStateKey, sourceTypeKey, type ProblemDraft } from '../../model'
import { personWords, useCapaWords } from '../../parts'
import type { CapaRecordActions, CapaRecordModel } from '../view-model'

/**
 * Problem (design rec CAPA › problem, capa-d123 "Team, problem and containment"): ONE form with an explicit save (the DS
 * EditModeBar, ⌘S) while the CAPA is open and the person follows CAPAs up — the head (title, owner, due day, priority, the
 * customer an 8D is written for), D1 the team (each person with their role) and D2 the problem statement (what, where,
 * when, how many); read-only text otherwise, said in a banner. Beside it: the stages in order (done, now, Move here — either
 * way; Closed opens the close), the sources (links; Remove with the version), D3 the containment pulled live from the NCRs (read-only, links) and
 * the cause codes the NCRs name.
 */
export function ProblemTab({ model, record, actions }: { model: CapaRecordModel; record: CapaRecord; actions?: CapaRecordActions }) {
  const { t, say } = useCapaWords()
  const locale = useLocale()
  const capa = record.capa
  const held = editHeld(capa, model.can)
  const editable = held === null
  const draft: ProblemDraft = model.draft ?? problemDraftOf(capa)
  const changes = editable ? problemChangesOf(capa, draft) : {}
  const count = Object.keys(changes).length
  const problems = problemDraftProblems(draft)
  const first = Object.values(problems)[0] ?? null
  const set = (patch: Partial<ProblemDraft>) => actions?.onDraft?.(patch)
  const people = model.people ?? []
  const [customerQuery, setCustomerQuery] = useState('')
  const [adding, setAdding] = useState('')
  const offline = model.live === 'offline'
  const lanes: CapaStatus[] = [...STAGES[capa.type], 'CLOSED']
  const current = capa.status === 'CANCELLED' ? 0 : lanes.indexOf(capa.status)
  const ownerOptions = people.some((person) => person.id === draft.ownerId) ? people : [{ id: draft.ownerId, name: personWords(record.people, draft.ownerId, model.me, t), manages: true, remindable: false, me: false }, ...people]
  const nameOf = (id: string) => personWords([...record.people, ...people], id, model.me, t)

  return (
    <div className="fw-capa-two">
      <div className="fw-capa-stack">
        {!editable && <Banner tone="info" title={say(held) ?? ''} />}
        <Card padded>
          <section className="fw-capa-stack" aria-labelledby="capa-head">
            <h2 id="capa-head" className="fw-capa-h2">
              {t('problem.head')}
            </h2>
            {editable ? (
              <div className="fw-capa-form">
                <Field label={t('new.fieldTitle')} required className="is-wide" error={problems.title ? say(problems.title) : undefined}>
                  <Input value={draft.title} maxLength={CAPA_LIMITS.title} onChange={(event) => set({ title: event.target.value })} />
                </Field>
                <Field label={t('new.owner')} hint={model.people === null ? t('problem.peopleReading') : undefined}>
                  <Select value={draft.ownerId} onChange={(event) => set({ ownerId: event.target.value })}>
                    {ownerOptions.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.id === model.me ? t('common.me', { name: person.name }) : person.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('new.due')} error={problems.dueOn ? say(problems.dueOn) : undefined}>
                  <DateField value={draft.dueOn} onChange={(value) => set({ dueOn: value })} />
                </Field>
                <Field label={t('new.priority')}>
                  <Select value={draft.priority} onChange={(event) => set({ priority: event.target.value as CapaPriority })}>
                    {CAPA_PRIORITIES.map((priority) => (
                      <option key={priority} value={priority}>
                        {t(`priority.${priority}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('new.customer')} hint={model.can.partiesView ? t(capa.type === 'EIGHT_D' ? 'new.customerHint8D' : 'new.customerHint') : t('held.noParties')}>
                  {model.can.partiesView ? (
                    <span className="fw-capa-row">
                      <Input
                        size="sm"
                        type="search"
                        aria-label={t('new.findCustomer')}
                        placeholder={t('new.findCustomer')}
                        value={customerQuery}
                        onChange={(event) => setCustomerQuery(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            actions?.onFindCustomers?.(customerQuery)
                          }
                        }}
                        onFocus={() => model.customers.items === null && !model.customers.problem && actions?.onFindCustomers?.('')}
                      />
                      <Select
                        size="sm"
                        aria-label={t('new.customer')}
                        value={draft.customerId}
                        onChange={(event) => {
                          const choice = model.customers.items?.find((entry) => entry.id === event.target.value)
                          set({ customerId: event.target.value, customerLabel: choice ? `${choice.code} · ${choice.name}` : '' })
                        }}
                      >
                        <option value="">{t('new.customerNone')}</option>
                        {draft.customerId && !model.customers.items?.some((entry) => entry.id === draft.customerId) && <option value={draft.customerId}>{draft.customerLabel}</option>}
                        {(model.customers.items ?? []).map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {`${entry.code} · ${entry.name}`}
                          </option>
                        ))}
                      </Select>
                    </span>
                  ) : (
                    <span>{capa.customer ? `${capa.customer.code} · ${capa.customer.name}` : '—'}</span>
                  )}
                </Field>
              </div>
            ) : (
              <KeyValue
                items={[
                  { label: t('new.fieldTitle'), value: capa.title },
                  { label: t('new.owner'), value: nameOf(capa.ownerId) },
                  { label: t('new.due'), value: formatDate(capa.dueOn, { locale }) },
                  { label: t('new.priority'), value: t(`priority.${capa.priority}`) },
                  { label: t('new.customer'), value: capa.customer ? `${capa.customer.code} · ${capa.customer.name}` : '—' },
                ]}
              />
            )}
          </section>
        </Card>

        <Card padded>
          <section className="fw-capa-stack" aria-labelledby="capa-d1">
            <h2 id="capa-d1" className="fw-capa-h2">
              {t('problem.team')}
            </h2>
            <p className="fw-capa-hint">{t('problem.teamHint')}</p>
            {draft.team.length === 0 && <p className="fw-capa-hint">{t('problem.teamNone')}</p>}
            {draft.team.length > 0 && (
              <ul className="fw-capa-team">
                {draft.team.map((member, index) => (
                  <li key={member.userId}>
                    <span className="fw-capa-name">{nameOf(member.userId)}</span>
                    {editable ? (
                      <>
                        <Input
                          size="sm"
                          aria-label={t('problem.teamRole', { name: nameOf(member.userId) })}
                          placeholder={t('problem.teamRolePlaceholder')}
                          value={member.role}
                          maxLength={CAPA_LIMITS.teamRole}
                          onChange={(event) => set({ team: draft.team.map((entry, at) => (at === index ? { ...entry, role: event.target.value } : entry)) })}
                        />
                        <Button size="xs" variant="quiet" aria-label={t('problem.teamRemove', { name: nameOf(member.userId) })} onClick={() => set({ team: draft.team.filter((_, at) => at !== index) })}>
                          <X size={13} aria-hidden />
                        </Button>
                        {problems[`team/${index}/role`] && <span className="fw-capa-bad">{say(problems[`team/${index}/role`])}</span>}
                      </>
                    ) : (
                      <span className="fw-capa-hint">{member.role}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {editable && (
              <span className="fw-capa-row">
                <Select size="sm" aria-label={t('problem.teamAdd')} value={adding} onChange={(event) => setAdding(event.target.value)}>
                  <option value="">{t('problem.teamPick')}</option>
                  {people
                    .filter((person) => !draft.team.some((member) => member.userId === person.id))
                    .map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.me ? t('common.me', { name: person.name }) : person.name}
                      </option>
                    ))}
                </Select>
                <Button
                  size="sm"
                  heldReason={!adding ? t('problem.teamPickFirst') : draft.team.length >= CAPA_LIMITS.team ? t('problem.teamFull', { count: CAPA_LIMITS.team }) : null}
                  onClick={() => {
                    set({ team: [...draft.team, { userId: adding, role: '' }] })
                    setAdding('')
                  }}
                >
                  <Plus size={13} aria-hidden /> {t('problem.teamAddButton')}
                </Button>
              </span>
            )}
          </section>
        </Card>

        <Card padded>
          <section className="fw-capa-stack" aria-labelledby="capa-d2">
            <h2 id="capa-d2" className="fw-capa-h2">
              {t('problem.statement')}
            </h2>
            {editable ? (
              <div className="fw-capa-form">
                {(['what', 'where', 'when', 'howMany'] as const).map((field) => (
                  <Field key={field} label={t(`problem.${field}`)} hint={t(`problem.${field}Hint`)} error={problems[field] ? say(problems[field]) : undefined}>
                    <Textarea value={draft[field]} rows={3} maxLength={CAPA_LIMITS.problem} onChange={(event) => set({ [field]: event.target.value } as Partial<ProblemDraft>)} />
                  </Field>
                ))}
              </div>
            ) : (
              <KeyValue items={(['what', 'where', 'when', 'howMany'] as const).map((field) => ({ label: t(`problem.${field}`), value: capa.problem[field] ?? '—' }))} />
            )}
          </section>
        </Card>
        {editable && count > 0 && (
          <EditModeBar
            count={count}
            busy={model.saving}
            onDiscard={() => actions?.onDiscard?.()}
            onApply={() => actions?.onSave?.()}
            applyHeldReason={offline ? t('held.offline') : first ? say(first) : null}
            saveShortcut
          />
        )}
      </div>

      <div className="fw-capa-stack">
        <Card padded>
          <section className="fw-capa-stack" aria-labelledby="capa-stage">
            <h2 id="capa-stage" className="fw-capa-h2">
              {t('problem.stage')}
            </h2>
            <ol className="fw-capa-stages" aria-label={t('problem.stage')}>
              {lanes.map((stage, index) => {
                const state = capa.status === 'CANCELLED' ? 'todo' : index < current ? 'done' : index === current ? 'current' : 'todo'
                const held = !editable ? (say(editHeld(capa, model.can)) ?? '') : offline ? t('held.offline') : null
                return (
                  <li key={stage} className={`fw-capa-stage is-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
                    <span className="fw-capa-stage-mark" aria-hidden>
                      {state === 'done' ? <Check size={13} /> : index + 1}
                    </span>
                    <span className="fw-capa-stage-name">{t(`stage.${stage}`)}</span>
                    {state === 'current' ? (
                      <Tag tone="info">{t('problem.stageNow')}</Tag>
                    ) : (
                      <Button size="xs" variant="quiet" heldReason={held} aria-label={stage === 'CLOSED' ? t('problem.stageClose') : say({ key: 'problem.stageMoveTo', params: { stage } }) ?? ''} onClick={() => (stage === 'CLOSED' ? actions?.onClose?.() : actions?.onMove?.(stage))}>
                        {stage === 'CLOSED' ? t('band.close') : t('problem.stageMove')}
                      </Button>
                    )}
                  </li>
                )
              })}
            </ol>
            <p className="fw-capa-hint">{editable ? t('problem.stageHint') : (say(held) ?? '')}</p>
          </section>
        </Card>

        <Card padded>
          <section className="fw-capa-stack" aria-labelledby="capa-sources">
            <h2 id="capa-sources" className="fw-capa-h2">
              {t('problem.sources', { count: record.sources.length })}
            </h2>
            {record.sources.length === 0 ? (
              <p className="fw-capa-hint">{t('problem.sourcesNone')}</p>
            ) : (
              <ul className="fw-capa-list">
                {record.sources.map((source) => {
                  const removeHeld = say(removeSourceHeld(source, capa, model.can)) ?? (offline ? t('held.offline') : null)
                  return (
                    <li key={source.id}>
                      <span className="fw-capa-row">
                        <span className="fw-capa-hint">{t(sourceTypeKey(source.recordType))}</span>
                        {source.record ? (
                          <Link className="fw-q-link fw-q-code" href={`${model.prefix}${recordAddress({ type: source.recordType, id: source.recordId, label: source.record.number, companyId: capa.companyId }, OFFICE_PAGES)}`}>
                            {source.record.number}
                          </Link>
                        ) : (
                          <span className="fw-capa-hint">{t('row.hiddenSource')}</span>
                        )}
                        {source.record && <Tag tone="neutral">{t(sourceStateKey(source.record.state))}</Tag>}
                        <Button size="xs" variant="quiet" heldReason={removeHeld} aria-label={t('problem.removeSource', { number: source.record?.number ?? '' })} onClick={() => actions?.onDialog?.({ kind: 'removeSource', sourceId: source.id, busy: false, notice: null })}>
                          <X size={13} aria-hidden />
                        </Button>
                      </span>
                      {source.record?.title && <span className="fw-capa-hint">{source.record.title}</span>}
                    </li>
                  )
                })}
              </ul>
            )}
            <p className="fw-capa-hint">{t('problem.sourcesHint')}</p>
          </section>
        </Card>

        <Card padded>
          <section className="fw-capa-stack" aria-labelledby="capa-d3">
            <h2 id="capa-d3" className="fw-capa-h2">
              {t('problem.containment')}
            </h2>
            {record.containment.length === 0 ? (
              <p className="fw-capa-hint">{t('problem.containmentNone')}</p>
            ) : (
              record.containment.map((ncr) => (
                <div key={ncr.ncrId} className="fw-capa-stack">
                  <span className="fw-capa-row">
                    <Link className="fw-q-link fw-q-code" href={`${model.prefix}${recordAddress({ type: 'Nonconformance', id: ncr.ncrId, label: ncr.number, companyId: capa.companyId }, OFFICE_PAGES)}`}>
                      {ncr.number}
                    </Link>
                    <Tag tone="neutral">{t(sourceStateKey(ncr.stage))}</Tag>
                    {ncr.activeHolds > 0 && <Tag tone="warning">{t('problem.holds', { count: ncr.activeHolds })}</Tag>}
                  </span>
                  {ncr.actions.length === 0 ? (
                    <p className="fw-capa-hint">{t('problem.containmentNoActions')}</p>
                  ) : (
                    <ul className="fw-capa-list">
                      {ncr.actions.map((entry) => (
                        <li key={entry.seq}>
                          <span>{`${entry.seq}. ${entry.description ?? t('problem.containmentAction')}`}</span>
                          <span className="fw-capa-hint">{entry.status === 'DONE' && entry.doneAt ? t('problem.containmentDone', { date: formatDateTime(entry.doneAt, { locale }) }) : t(`containmentStatus.${entry.status === 'DONE' || entry.status === 'CANCELLED' ? entry.status : 'OPEN'}`)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))
            )}
          </section>
        </Card>

        <Card padded>
          <section className="fw-capa-stack" aria-labelledby="capa-d4">
            <h2 id="capa-d4" className="fw-capa-h2">
              {t('problem.causes')}
            </h2>
            {record.causes.length === 0 ? (
              <p className="fw-capa-hint">{t('problem.causesNone')}</p>
            ) : (
              <ul className="fw-capa-list">
                {record.causes.map((cause) => (
                  <li key={cause.id}>
                    <span className="fw-q-code">{cause.code}</span> {locale === 'it' ? cause.labelIt : cause.labelEn}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </Card>
      </div>
    </div>
  )
}
