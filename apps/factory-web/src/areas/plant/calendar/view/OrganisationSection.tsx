'use client'

import { useEffect, useMemo, useState } from 'react'
import { UserMinus, UserPlus, Users } from 'lucide-react'
import { Banner, EmptyState, Field } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Toggle } from '@nexus/ui/primitives'
import { ORGANISATION_LAW } from '@nexus/factory-domain/safety/organisation/rules'
import { DateField, Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import type { Translate } from '../../../../lib/i18n/messages'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { ScopeSiteChip } from '../../../../shell/scope/view/ScopeSiteChip'
import type { Appointment } from '../api'
import { appointmentSelectHeld, atField, endHeld, missingPlaces, trainingWords } from '../model'
import type { CalendarPageActions, CalendarPageModel, EndTermsState } from '../view-model'
import { PAGE_KEYS, problemText, RoleLaw, say, SectionFailed, SectionHead, SectionLoading, useDay, useWords } from './parts'

/** The holder's training in words, its day written in the page's language. */
export function trainingText(t: Translate, day: (value: string) => string, training: Appointment['training']): string {
  const words = trainingWords(training)
  return say(t, words.params?.date ? { ...words, params: { ...words.params, date: day(String(words.params.date)) } } : words)
}

/** How the appointee signed, in words. */
export const signedText = (t: Translate, day: (value: string) => string, row: Pick<Appointment, 'signature'>): string =>
  row.signature ? t(`signed.${row.signature.method}`, { date: day(row.signature.signedAt) }) : t('signed.not')

/** Where the term holds: the company, and the site or the whole company. */
export const placeText = (t: Translate, row: Pick<Appointment, 'company' | 'site'>): string => `${row.company.name} · ${row.site?.name ?? t('site.whole')}`

/**
 * The safety organisation (design sec org; QHS-224): who holds each role per company and site, in role order, as the list
 * frame (Role with its law, Person or contact, Company / Site, Shift, From, Until, Letter, Signed, Training valid);
 * above it the roles nobody holds, each with Appoint; End term N over the terms in force. A person's name only here, in
 * the organisation register (safety.view); never a figure, ranking or filter about a person.
 */
export function OrganisationSection({ model, actions, onHelp }: { model: CalendarPageModel; actions?: CalendarPageActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const ds = useDsWords()
  const day = useDay()
  const { address, scope } = model
  const answer = model.organisation.status === 'ready' ? model.organisation.value : null
  const canManage = model.can.manageOrganisation && (answer?.canManage ?? true)
  const appointHeld = canManage ? (model.companyId ? null : t('held.company')) : t('held.organisation')
  const [selected, setSelected] = useState<string[]>(() => [...(model.orgSelected ?? [])])
  const rows = answer?.appointments ?? null
  useEffect(() => {
    if (rows) setSelected((current) => current.filter((id) => rows.some((row) => row.id === id)))
  }, [rows])
  const picked = (rows ?? []).filter((row) => selected.includes(row.id))
  const missing = answer ? missingPlaces(answer.missing, answer.companies) : []

  const columns = useMemo<ColDef<Appointment>[]>(() => {
    const RoleCell = ({ data }: ICellRendererParams<Appointment>) =>
      data ? (
        <span className="fw-hs-cell">
          <span>{t(`role.${data.role}`)}</span>
          <RoleLaw role={data.role} say={t} />
        </span>
      ) : null
    const PersonCell = ({ data }: ICellRendererParams<Appointment>) => {
      if (!data) return null
      const outside = data.appointee.kind === 'OUTSIDE'
      return (
        <span className="fw-hs-cell">
          <span>{data.appointee.name}</span>
          {outside && <span className="fw-hs-muted">{[data.appointee.partyName ?? t('org.outside'), data.appointee.email, data.appointee.phone].filter(Boolean).join(' · ')}</span>}
        </span>
      )
    }
    const LetterCell = ({ data }: ICellRendererParams<Appointment>) => {
      if (!data) return null
      if (!data.letter) return <span className="fw-hs-muted">{t('org.noLetter')}</span>
      const letter = data.letter
      return (
        <Button size="sm" variant="link" wrap onClick={() => actions?.onOpenFile?.(letter.fileId)}>
          {letter.name}
        </Button>
      )
    }
    return [
      { colId: 'role', headerName: t('org.col.role'), minWidth: 210, flex: 1.4, valueGetter: (params) => (params.data ? t(`role.${params.data.role}`) : ''), cellRenderer: RoleCell },
      { colId: 'person', headerName: t('org.col.person'), minWidth: 210, flex: 1.6, valueGetter: (params) => params.data?.appointee.name ?? '', cellRenderer: PersonCell },
      { colId: 'place', headerName: t('org.col.place'), minWidth: 190, flex: 1.3, valueGetter: (params) => (params.data ? placeText(t, params.data) : '') },
      { colId: 'shift', headerName: t('org.col.shift'), minWidth: 110, flex: 0.8, valueGetter: (params) => (params.data ? (params.data.shift?.name ?? '—') : '') },
      { colId: 'from', headerName: t('org.col.from'), minWidth: 120, flex: 0.8, valueGetter: (params) => params.data?.fromDate ?? '', valueFormatter: (params) => (params.data ? day(params.data.fromDate) : '') },
      {
        colId: 'until',
        headerName: t('org.col.until'),
        minWidth: 130,
        flex: 0.9,
        valueGetter: (params) => params.data?.untilDate ?? '',
        valueFormatter: (params) => (params.data ? (params.data.untilDate ? `${day(params.data.untilDate)}${params.data.ended ? ` · ${t('org.ended')}` : ''}` : t('org.openEnded')) : ''),
      },
      { colId: 'letter', headerName: t('org.col.letter'), minWidth: 160, flex: 1, valueGetter: (params) => (params.data ? (params.data.letter?.name ?? t('org.noLetter')) : ''), cellRenderer: LetterCell },
      { colId: 'signed', headerName: t('org.col.signed'), minWidth: 160, flex: 1, valueGetter: (params) => (params.data ? signedText(t, day, params.data) : '') },
      { colId: 'training', headerName: t('org.col.training'), minWidth: 190, flex: 1.2, valueGetter: (params) => (params.data ? trainingText(t, day, params.data.training) : '') },
    ]
  }, [t, day, actions])

  const head = (
    <SectionHead id="fw-hs-org" title={t('org.title')} note={<LawRef law={answer?.law ?? ORGANISATION_LAW} plain={t('law.organisation')} labels={ds.lawRef} />}>
      <label className="fw-hs-row">
        <Toggle size="sm" checked={address.ended} aria-label={t('org.showEnded')} onChange={(ended) => actions?.onAddress?.({ ended })} />
        <span className="fw-hs-muted">{t('org.showEnded')}</span>
      </label>
      <Button size="sm" heldReason={appointHeld} onClick={() => actions?.onAddress?.({ appoint: 'new', role: null, at: null })}>
        <UserPlus size={14} aria-hidden /> {t('org.appoint')}
      </Button>
      <ScopeSiteChip model={scope} />
    </SectionHead>
  )

  if (model.organisation.status === 'error') {
    return (
      <>
        {head}
        <SectionFailed title={t('org.failed')} problem={model.organisation.problem} onRetry={actions?.onRetryOrganisation} />
      </>
    )
  }
  if (!answer) {
    return (
      <>
        {head}
        <SectionLoading rows={5} />
      </>
    )
  }

  return (
    <>
      {head}
      {missing.length > 0 && (
        <div className="fw-hs-missing" role="group" aria-label={t('org.missingLabel')}>
          <span className="fw-hs-missing-title">{t('org.missing', { count: missing.length })}</span>
          <ul className="fw-hs-chips">
            {missing.map((slot) => (
              <li key={slot.key} className="fw-hs-chip">
                <span>{t('org.missingSlot', { role: t(`role.${slot.role}`), place: slot.place })}</span>
                <Button size="sm" variant="quiet" heldReason={appointHeld} aria-label={t('org.appointSlot', { role: t(`role.${slot.role}`), place: slot.place })} onClick={() => actions?.onAddress?.({ appoint: 'new', role: slot.role, at: slot.siteId })}>
                  {t('org.appoint')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ListFrame<Appointment>
        label={t('org.label')}
        title={t('org.title')}
        listKey="plant.calendar.2"
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        count={t('org.count', { count: answer.appointments.length })}
        selection={
          canManage
            ? {
                selected,
                onChange: setSelected,
                actions: (
                  <Button size="sm" variant="primary" aria-label={t('bulk.end', { count: picked.length })} heldReason={picked.length === 0 ? t('held.noneInForce') : null} onClick={() => actions?.onEndTerms?.(picked.map((row) => row.id))}>
                    <UserMinus size={13} aria-hidden /> <SelectionLabel>{t('bulk.end', { count: picked.length })}</SelectionLabel>
                  </Button>
                ),
              }
            : undefined
        }
        isRowSelectable={canManage ? (row) => (appointmentSelectHeld(row, model.today) ? t(appointmentSelectHeld(row, model.today)!) : null) : undefined}
        keys={PAGE_KEYS(t)}
        onHelp={onHelp}
        onOpen={(row) => actions?.onAddress?.({ appoint: row.id })}
        state={
          answer.appointments.length === 0 ? (
            <EmptyState
              icon={<Users size={22} aria-hidden />}
              title={t('org.emptyTitle')}
              description={t('org.empty')}
              action={
                canManage ? (
                  <Button size="sm" variant="primary" onClick={() => actions?.onAddress?.({ appoint: 'new', role: 'RSPP', at: null })}>
                    {t('org.appointRspp')}
                  </Button>
                ) : undefined
              }
            />
          ) : undefined
        }
        cards={{ fields: { person: { role: 'title' }, role: { role: 'subtitle' } } }}
      />
    </>
  )
}

/** End term N: one last day and one reason for every term chosen (one call each). */
export function EndTermsDialog({ model, state, actions }: { model: CalendarPageModel; state: EndTermsState; actions?: CalendarPageActions | undefined }) {
  const t = useWords()
  const rows = (model.organisation.status === 'ready' ? model.organisation.value.appointments : []).filter((row) => state.ids.includes(row.id))
  const held = endHeld(state.draft, rows, state.busy)
  return (
    <Modal
      open
      onClose={() => actions?.onEndTerms?.(null)}
      title={t('end.bulkTitle', { count: rows.length })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onEndTerms?.(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => void actions?.onApplyEndTerms?.()}>
            {t('bulk.end', { count: rows.length })}
          </Button>
        </>
      }
    >
      <div className="fw-hs-form">
        <ul className="fw-hs-list">
          {rows.map((row) => (
            <li key={row.id}>{t('end.row', { role: t(`role.${row.role}`), person: row.appointee.name, place: placeText(t, row) })}</li>
          ))}
        </ul>
        <Field label={t('end.untilDate')} hint={t('end.untilHint')} error={atField(state.problem, 'untilDate') ? t(atField(state.problem, 'untilDate')!) : undefined}>
          <DateField value={state.draft.untilDate} onChange={(untilDate) => actions?.onEndTermsDraft?.({ ...state.draft, untilDate })} ariaLabel={t('end.untilDate')} />
        </Field>
        <Field label={t('end.reason')} error={atField(state.problem, 'endReason') ? t(atField(state.problem, 'endReason')!) : undefined}>
          <Textarea value={state.draft.reason} rows={3} onChange={(event) => actions?.onEndTermsDraft?.({ ...state.draft, reason: event.target.value })} />
        </Field>
        {state.problem && !state.problem.field && <Banner tone="danger" title={problemText(t, state.problem)} />}
      </div>
    </Modal>
  )
}
