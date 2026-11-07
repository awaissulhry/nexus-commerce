'use client'

import { Fragment, type ReactNode } from 'react'
import Link from 'next/link'
import { Archive, ArchiveRestore, Pencil, Plus, Printer, Trash2 } from 'lucide-react'
import { Banner, Card, EmptyState, Field } from '@nexus/ui/components'
import { Button, Input, Pill, SegmentedControl, Select, Spinner } from '@nexus/ui/primitives'
import { EditModeBar, Modal, ReviewChangesModal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import type { Catalogue, RoleSheet, SheetLaw } from '../api'
import { atField, changeRows, impactWords, ITEM_KINDS, LAW, localName, newSheetHeld, rowKey, roleSheetsHref, sheetChangedParts, sheetProblems, surveillanceWords, type CourseRow, type ItemKind, type ItemRow, type KitRow, type SheetDraft } from '../model'
import type { NewSheetState, RiskFrame, SheetActions, SheetState } from '../view-model'
import { Law, useSay, useWhen, useWords } from './parts'

/**
 * The role sheet (design rec tab roles › "Role sheet", a form card; QHS-236; Owner answer H2): the single source for the
 * training, the PPE kit and the visit plan of a role. Read: its risks with notes, the surveillance needs, the PPE with when
 * to wear it (from the PPE catalogue), the courses with their deadline (from the course catalogue), whether the role needs
 * health surveillance and every how many months (the occupational doctor's frequency, set on the health page), and the
 * people in the role (each a link to their record). Edit: the WHOLE sheet as one draft under the EditModeBar; ⌘S or "Review
 * what this changes" asks the API what applying it means for the people in the role (design pop:impact) before Apply.
 */
export function SheetCard({ frame, state, actions, chrome = 'card' }: { frame: RiskFrame; state: SheetState; actions?: SheetActions | undefined; chrome?: 'card' | 'bare' }) {
  const t = useWords()
  if (state.read.status === 'loading') {
    return (
      <Wrap chrome={chrome}>
        <p className="fw-rk-muted" role="status">
          <Spinner size={14} /> {t('common.reading')}
        </p>
      </Wrap>
    )
  }
  if (state.read.status === 'error') {
    return (
      <Wrap chrome={chrome}>
        <EmptyState
          title={t('sheet.failed')}
          description={t(state.read.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onSheetRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      </Wrap>
    )
  }
  const { roleSheet: sheet, law } = state.read.value
  return (
    <Wrap chrome={chrome}>
      {state.saved && <Banner tone="success" title={t(state.saved.key, state.saved.params)} />}
      {state.problem && !state.problem.field && <Banner tone="danger" title={t(state.problem.key)} />}
      {state.mode === 'edit' && state.draft ? <SheetEditor sheet={sheet} state={state} draft={state.draft} actions={actions} /> : <SheetFacts frame={frame} sheet={sheet} law={law} actions={actions} withActions={chrome === 'card'} />}
      {state.review && state.draft && <ImpactDialog sheet={sheet} state={state} actions={actions} />}
    </Wrap>
  )
}

function Wrap({ chrome, children }: { chrome: 'card' | 'bare'; children: ReactNode }) {
  return chrome === 'card' ? (
    <Card padded>
      <div className="fw-rk-stack">{children}</div>
    </Card>
  ) : (
    <div className="fw-rk-stack">{children}</div>
  )
}

/** The sheet's own actions (Edit, Print, Archive / Put back), each held with the reason while it cannot run. */
export function SheetButtons({ frame, sheet, actions }: { frame: RiskFrame; sheet: RoleSheet; actions?: SheetActions | undefined }) {
  const t = useWords()
  const manage = frame.can.sheets && sheet.canManage
  const archived = sheet.status === 'ARCHIVED'
  return (
    <span className="fw-rk-row">
      {archived ? (
        <Button size="sm" heldReason={manage ? null : t('held.sheets')} onClick={() => actions?.onSheetStatus?.('ACTIVE')}>
          <ArchiveRestore size={13} aria-hidden /> {t('sheet.restore')}
        </Button>
      ) : (
        <Button size="sm" heldReason={!manage ? t('held.sheets') : sheet.people > 0 ? t('sheetRefusal.PEOPLE_IN_ROLE') : null} onClick={() => actions?.onSheetStatus?.('ARCHIVED')}>
          <Archive size={13} aria-hidden /> {t('sheet.archive')}
        </Button>
      )}
      <Button size="sm" asChild>
        <a href={roleSheetsHref(frame.prefix, [sheet.id])} target="_blank" rel="noopener">
          <Printer size={13} aria-hidden /> {t('sheet.print')}
        </a>
      </Button>
      <Button size="sm" variant="primary" heldReason={!manage ? t('held.sheets') : archived ? t('sheetRefusal.ARCHIVED') : null} onClick={() => actions?.onSheetMode?.('edit')}>
        <Pencil size={13} aria-hidden /> {t('sheet.edit')}
      </Button>
    </span>
  )
}

function SheetFacts({ frame, sheet, law, actions, withActions }: { frame: RiskFrame; sheet: RoleSheet; law: SheetLaw; actions?: SheetActions | undefined; withActions: boolean }) {
  const t = useWords()
  const locale = useLocale()
  const when = useWhen()
  const risks = sheet.items.filter((item) => item.kind === 'RISK')
  const needs = sheet.items.filter((item) => item.kind === 'SURVEILLANCE')
  const surveillance = surveillanceWords(sheet.plan)
  return (
    <>
      <div className="fw-rk-head">
        <span className="fw-rk-head-title">
          <h3 className="fw-rk-h">{localName(sheet, locale)}</h3>
          <span className="fw-rk-muted">{`${sheet.code} · ${sheet.site.name}`}</span>
          {sheet.status === 'ARCHIVED' && <Pill tone="neutral">{t('sheet.archived')}</Pill>}
        </span>
        {withActions && <SheetButtons frame={frame} sheet={sheet} actions={actions} />}
      </div>
      {sheet.description && <p>{sheet.description}</p>}
      <p className="fw-rk-muted">{t('sheet.lastChanged', { date: when(sheet.updatedAt) })}</p>
      <div className="fw-rk-sheet-grid">
        <section className="fw-rk-stack" aria-labelledby={`fw-rk-risks-${sheet.id}`}>
          <h4 id={`fw-rk-risks-${sheet.id}`} className="fw-rk-h3">
            {t('sheet.risks')}
          </h4>
          {risks.length === 0 ? (
            <p className="fw-rk-muted">{t('sheet.noRisks')}</p>
          ) : (
            <ul className="fw-rk-list">
              {risks.map((item) => (
                <li key={item.id}>
                  {item.title}
                  {item.note ? <span className="fw-rk-muted">{` — ${item.note}`}</span> : null}
                </li>
              ))}
            </ul>
          )}
          <Law law={law.roleSheet || LAW.roleSheet} plain={t('law.roleSheet')} />
        </section>
        <section className="fw-rk-stack" aria-labelledby={`fw-rk-kit-${sheet.id}`}>
          <h4 id={`fw-rk-kit-${sheet.id}`} className="fw-rk-h3">
            {t('sheet.kit')}
          </h4>
          {sheet.kit.length === 0 ? (
            <p className="fw-rk-muted">{t('sheet.noKit')}</p>
          ) : (
            <ul className="fw-rk-list">
              {sheet.kit.map((line) => (
                <li key={line.id}>
                  <b>{t('sheet.kitLine', { quantity: line.quantity, item: localName(line.item, locale) })}</b>
                  {` — ${line.whenToWear}`}
                  {line.item.standard ? <span className="fw-rk-muted">{` · ${line.item.standard}`}</span> : null}
                  {line.item.status === 'ARCHIVED' ? <span className="fw-rk-warn">{` · ${t('sheet.itemArchived')}`}</span> : null}
                </li>
              ))}
            </ul>
          )}
          <Law law={law.kit || LAW.kit} plain={t('law.kit')} />
        </section>
        <section className="fw-rk-stack" aria-labelledby={`fw-rk-courses-${sheet.id}`}>
          <h4 id={`fw-rk-courses-${sheet.id}`} className="fw-rk-h3">
            {t('sheet.courses')}
          </h4>
          {sheet.requirements.length === 0 ? (
            <p className="fw-rk-muted">{t('sheet.noCourses')}</p>
          ) : (
            <ul className="fw-rk-list">
              {sheet.requirements.map((line) => (
                <li key={line.id}>
                  <b>{localName(line.course, locale)}</b>
                  {` — ${line.withinDays === null ? t('within.before') : t('within.days', { count: line.withinDays })}`}
                  <span className="fw-rk-muted">{` · ${t('sheet.hours', { hours: line.course.hours })}`}</span>
                </li>
              ))}
            </ul>
          )}
          <Law law={law.training || LAW.training} plain={t('law.training')} />
        </section>
        <section className="fw-rk-stack" aria-labelledby={`fw-rk-health-${sheet.id}`}>
          <h4 id={`fw-rk-health-${sheet.id}`} className="fw-rk-h3">
            {t('sheet.health')}
          </h4>
          <p>{t(surveillance.key, surveillance.params)}</p>
          {needs.length > 0 && (
            <ul className="fw-rk-list">
              {needs.map((item) => (
                <li key={item.id}>
                  {item.title}
                  {item.note ? <span className="fw-rk-muted">{` — ${item.note}`}</span> : null}
                </li>
              ))}
            </ul>
          )}
          {sheet.plan.needed && <p className="fw-rk-muted">{t(sheet.plan.endOfEmploymentVisit ? 'sheet.endVisit' : 'sheet.noEndVisit')}</p>}
          <p className="fw-rk-muted">{t('sheet.doctorSets')}</p>
          <Law law={law.surveillance || LAW.surveillance} plain={t('law.surveillance')} />
        </section>
      </div>
      <section className="fw-rk-stack" aria-labelledby={`fw-rk-people-${sheet.id}`}>
        <h4 id={`fw-rk-people-${sheet.id}`} className="fw-rk-h3">
          {t('sheet.people', { count: sheet.people })}
        </h4>
        {sheet.peopleInRole.length === 0 ? (
          <p className="fw-rk-muted">{t('sheet.nobody')}</p>
        ) : (
          <p className="fw-rk-people">
            {sheet.peopleInRole.map((person, index) => (
              <Fragment key={person.employeeId}>
                {index > 0 ? ', ' : ''}
                {frame.can.people ? <Link href={`${frame.prefix}/people/employees/${encodeURIComponent(person.employeeId)}`}>{person.name}</Link> : person.name}
              </Fragment>
            ))}
          </p>
        )}
      </section>
    </>
  )
}

function SheetEditor({ sheet, state, draft, actions }: { sheet: RoleSheet; state: SheetState; draft: SheetDraft; actions?: SheetActions | undefined }) {
  const t = useWords()
  const locale = useLocale()
  const catalogue: Catalogue | null = state.catalogue?.status === 'ready' ? state.catalogue.value : null
  const set = (change: Partial<SheetDraft>) => actions?.onSheetDraft?.({ ...draft, ...change })
  const problems = sheetProblems(draft)
  const parts = sheetChangedParts(sheet, draft)
  const at = (field: string) => {
    const local = problems.find((problem) => problem.field === field)?.key
    return local ? t(local) : undefined
  }
  const api = (...fields: string[]) => {
    const key = atField(state.problem, ...fields)
    return key ? t(key) : undefined
  }
  const held = state.busy ? 'held.saving' : problems[0]?.key ?? (parts.length === 0 ? 'held.nothingChanged' : null)
  const items = (kind: ItemKind) => draft.items.filter((item) => item.kind === kind)
  const setItem = (key: string, change: Partial<ItemRow>) => set({ items: draft.items.map((item) => (item.key === key ? { ...item, ...change } : item)) })
  const setKit = (key: string, change: Partial<KitRow>) => set({ kit: draft.kit.map((line) => (line.key === key ? { ...line, ...change } : line)) })
  const setCourse = (key: string, change: Partial<CourseRow>) => set({ requirements: draft.requirements.map((line) => (line.key === key ? { ...line, ...change } : line)) })
  const ppeOptions = [...(catalogue?.ppeItems ?? []).map((item) => ({ id: item.id, label: `${localName(item, locale)} (${item.code})` }))]
  for (const line of sheet.kit) if (!ppeOptions.some((option) => option.id === line.ppeItemId)) ppeOptions.push({ id: line.ppeItemId, label: `${localName(line.item, locale)} (${line.item.code}) · ${t('sheet.itemArchived')}` })
  const courseOptions = [...(catalogue?.courses ?? []).map((course) => ({ id: course.id, label: `${localName(course, locale)} · ${t('sheet.hours', { hours: course.hours })}` }))]
  for (const line of sheet.requirements) if (!courseOptions.some((option) => option.id === line.courseId)) courseOptions.push({ id: line.courseId, label: `${localName(line.course, locale)} · ${t('sheet.itemArchived')}` })

  return (
    <div className="fw-rk-stack">
      <div className="fw-rk-head">
        <span className="fw-rk-head-title">
          <h3 className="fw-rk-h">{t('sheet.editTitle', { role: localName(sheet, locale) })}</h3>
          <span className="fw-rk-muted">{`${sheet.code} · ${sheet.site.name}`}</span>
        </span>
      </div>
      {state.catalogue?.status === 'loading' && (
        <p className="fw-rk-muted" role="status">
          <Spinner size={14} /> {t('sheet.catalogueReading')}
        </p>
      )}
      {state.catalogue?.status === 'error' && <Banner tone="warning" title={t('sheet.catalogueFailed')}>{t(state.catalogue.problem)}</Banner>}
      <div className="fw-rk-form-row">
        <Field label={t('sheet.name')} required error={at('name') ?? api('name')}>
          <Input value={draft.name} maxLength={120} onChange={(event) => set({ name: event.target.value })} />
        </Field>
        <Field label={t('sheet.description')} error={api('description')}>
          <Textarea value={draft.description} rows={2} onChange={(event) => set({ description: event.target.value })} />
        </Field>
      </div>

      {ITEM_KINDS.map((kind) => (
        <fieldset key={kind} className="fw-rk-fieldset">
          <legend className="fw-rk-h3">{t(kind === 'RISK' ? 'sheet.risks' : 'sheet.needs')}</legend>
          {kind === 'SURVEILLANCE' && <p className="fw-rk-muted">{t('sheet.needsHint')}</p>}
          {items(kind).length === 0 && <p className="fw-rk-muted">{t(kind === 'RISK' ? 'sheet.noRisks' : 'sheet.noNeeds')}</p>}
          {items(kind).map((item, index) => (
            <div key={item.key} className="fw-rk-line">
              <Field label={t(kind === 'RISK' ? 'sheet.riskN' : 'sheet.needN', { n: index + 1 })} required error={at(`item:${item.key}`)}>
                <Input value={item.title} maxLength={200} onChange={(event) => setItem(item.key, { title: event.target.value })} />
              </Field>
              <Field label={t('sheet.note')}>
                <Input value={item.note} maxLength={1000} onChange={(event) => setItem(item.key, { note: event.target.value })} />
              </Field>
              <Button size="sm" variant="quiet" aria-label={t('sheet.removeLine', { what: item.title || t('sheet.lineEmpty') })} onClick={() => set({ items: draft.items.filter((row) => row.key !== item.key) })}>
                <Trash2 size={13} aria-hidden />
              </Button>
            </div>
          ))}
          <span>
            <Button size="sm" onClick={() => set({ items: [...draft.items, { key: rowKey('item'), kind, title: '', note: '' }] })}>
              <Plus size={13} aria-hidden /> {t(kind === 'RISK' ? 'sheet.addRisk' : 'sheet.addNeed')}
            </Button>
          </span>
        </fieldset>
      ))}

      <fieldset className="fw-rk-fieldset">
        <legend className="fw-rk-h3">{t('sheet.kit')}</legend>
        {draft.kit.length === 0 && <p className="fw-rk-muted">{t('sheet.noKit')}</p>}
        {draft.kit.map((line, index) => (
          <div key={line.key} className="fw-rk-line">
            <Field label={t('sheet.ppeN', { n: index + 1 })} required error={at(`kit:${line.key}`)}>
              <Select value={line.ppeItemId} onChange={(event) => setKit(line.key, { ppeItemId: event.target.value })} aria-label={t('sheet.ppeN', { n: index + 1 })}>
                <option value="">{t('sheet.choosePpe')}</option>
                {ppeOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('sheet.quantity')} required>
              <Input value={line.quantity} inputMode="numeric" className="fw-rk-narrow" onChange={(event) => setKit(line.key, { quantity: event.target.value })} />
            </Field>
            <Field label={t('sheet.whenToWear')} required hint={t('sheet.whenHint')}>
              <Input value={line.whenToWear} maxLength={200} onChange={(event) => setKit(line.key, { whenToWear: event.target.value })} />
            </Field>
            <Button size="sm" variant="quiet" aria-label={t('sheet.removeLine', { what: ppeOptions.find((option) => option.id === line.ppeItemId)?.label ?? t('sheet.lineEmpty') })} onClick={() => set({ kit: draft.kit.filter((row) => row.key !== line.key) })}>
              <Trash2 size={13} aria-hidden />
            </Button>
          </div>
        ))}
        <span>
          <Button size="sm" heldReason={catalogue ? null : t('sheet.catalogueReading')} onClick={() => set({ kit: [...draft.kit, { key: rowKey('kit'), ppeItemId: '', quantity: '1', whenToWear: '', note: '' }] })}>
            <Plus size={13} aria-hidden /> {t('sheet.addPpe')}
          </Button>
        </span>
      </fieldset>

      <fieldset className="fw-rk-fieldset">
        <legend className="fw-rk-h3">{t('sheet.courses')}</legend>
        {draft.requirements.length === 0 && <p className="fw-rk-muted">{t('sheet.noCourses')}</p>}
        {draft.requirements.map((line, index) => (
          <div key={line.key} className="fw-rk-line">
            <Field label={t('sheet.courseN', { n: index + 1 })} required error={at(`course:${line.key}`)}>
              <Select value={line.courseId} onChange={(event) => setCourse(line.key, { courseId: event.target.value })} aria-label={t('sheet.courseN', { n: index + 1 })}>
                <option value="">{t('sheet.chooseCourse')}</option>
                {courseOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('sheet.withinDays')} hint={t('sheet.withinHint')}>
              <Input value={line.withinDays} inputMode="numeric" className="fw-rk-narrow" onChange={(event) => setCourse(line.key, { withinDays: event.target.value })} />
            </Field>
            <Field label={t('sheet.note')}>
              <Input value={line.note} maxLength={1000} onChange={(event) => setCourse(line.key, { note: event.target.value })} />
            </Field>
            <Button size="sm" variant="quiet" aria-label={t('sheet.removeLine', { what: courseOptions.find((option) => option.id === line.courseId)?.label ?? t('sheet.lineEmpty') })} onClick={() => set({ requirements: draft.requirements.filter((row) => row.key !== line.key) })}>
              <Trash2 size={13} aria-hidden />
            </Button>
          </div>
        ))}
        <span>
          <Button size="sm" heldReason={catalogue ? null : t('sheet.catalogueReading')} onClick={() => set({ requirements: [...draft.requirements, { key: rowKey('course'), courseId: '', withinDays: '', note: '' }] })}>
            <Plus size={13} aria-hidden /> {t('sheet.addCourse')}
          </Button>
        </span>
      </fieldset>

      <fieldset className="fw-rk-fieldset">
        <legend className="fw-rk-h3">{t('sheet.health')}</legend>
        <SegmentedControl
          size="sm"
          ariaLabel={t('sheet.neededLabel')}
          value={draft.needed === null ? 'unset' : draft.needed ? 'yes' : 'no'}
          onChange={(value) => set({ needed: value === 'unset' ? null : value === 'yes' })}
          options={[
            ...(sheet.plan.needed === null ? [{ value: 'unset', label: t('surveillance.unsetShort') }] : []),
            { value: 'yes', label: t('surveillance.neededShort') },
            { value: 'no', label: t('surveillance.notNeededShort') },
          ]}
        />
        {at('needed') && <p className="fw-rk-warn">{at('needed')}</p>}
        <p className="fw-rk-muted">{t('sheet.doctorSets')}</p>
      </fieldset>

      <EditModeBar
        count={parts.length}
        message={parts.length === 0 ? t('sheet.noChanges') : t('sheet.changedParts', { count: parts.length })}
        onDiscard={() => actions?.onSheetDiscard?.()}
        onApply={() => actions?.onSheetReview?.()}
        applyLabel={t('sheet.review')}
        applyHeldReason={held ? t(held) : null}
        busy={state.busy}
        saveShortcut
      />
    </div>
  )
}

/**
 * "What this changes" (design pop:impact, the DS ReviewChangesModal): what applying the sheet means for the people in the
 * role, said line by line ("3 people now need Specific training (high risk) · 2 people get hearing protection in their kit
 * · 4 people get a yearly visit"), then the sheet's own changes. Apply sends the fingerprint of what was shown: a change
 * meanwhile is refused (IMPACT_CHANGED) and the review is read again.
 */
function ImpactDialog({ sheet, state, actions }: { sheet: RoleSheet; state: SheetState; actions?: SheetActions | undefined }) {
  const t = useWords()
  const locale = useLocale()
  const say = useSay()
  const review = state.review!
  const preview = review.read.status === 'ready' ? review.read.value : null
  const catalogue = state.catalogue?.status === 'ready' ? state.catalogue.value : null
  const people = preview
    ? preview.impact.map((line, index) => {
        const words = impactWords(line, preview.refs, locale)
        const within = words.within ? t('impact.within', { from: say(words.within.from), to: say(words.within.to) }) : null
        const named = line.names && line.names.length > 0 ? `${line.names.map((person) => person.name).join(', ')}${line.people > line.names.length ? ` +${line.people - line.names.length}` : ''}` : null
        return {
          id: `impact:${index}`,
          group: 'people',
          what: t(words.key, words.params),
          now: '—',
          next: within ?? (line.names === null ? t('impact.countOnly') : t('impact.people', { count: line.people })),
          note: named ?? undefined,
        }
      })
    : []
  const own = preview
    ? changeRows(preview.changes, sheet, preview.refs, catalogue, locale).map((row) => ({ id: row.id, group: 'sheet', what: t(row.what.key, row.what.params), now: say(row.now), next: say(row.next) }))
    : []
  const phase = review.applied ? { phase: 'done' as const, results: Object.fromEntries([...people, ...own].map((row) => [row.id, { ok: true, words: t('impact.applied'), verb: t('impact.appliedVerb') }])) } : review.applying ? { phase: 'saving' as const } : review.read.status === 'loading' ? { phase: 'reading' as const } : review.read.status === 'error' ? { phase: 'failed' as const, error: t(review.read.problem) } : { phase: 'ready' as const }
  return (
    <ReviewChangesModal
      open
      onClose={() => actions?.onSheetReviewClose?.()}
      title={t('impact.title')}
      summary={preview ? t(preview.impact.length === 0 ? 'impact.nobody' : 'impact.summary', { count: preview.people }) : t('impact.reading')}
      changes={[...people, ...own]}
      groups={[
        { id: 'people', label: t('impact.groupPeople') },
        { id: 'sheet', label: t('impact.groupSheet') },
      ]}
      state={phase}
      problems={review.problem ? [t(review.problem.key)] : []}
      saveLabel={t('impact.apply')}
      onSave={() => actions?.onSheetApply?.()}
      onRetry={() => actions?.onSheetReview?.()}
      onDone={() => actions?.onSheetReviewClose?.()}
      size="xl"
    />
  )
}

/** Add role ("Add the first role" — usually 6 to 10 in a small factory): its site, code and name; the sheet opens to fill. */
export function NewSheetDialog({ frame, state, sites, actions }: { frame: RiskFrame; state: NewSheetState; sites: readonly { id: string; name: string }[]; actions?: SheetActions | undefined }) {
  const t = useWords()
  const set = (change: Partial<NewSheetState>) => actions?.onNewSheetDraft?.({ ...state, ...change, problem: null })
  const held = !frame.can.sheets ? 'held.sheets' : !frame.companyId ? 'held.company' : newSheetHeld(state, state.busy)
  const api = (...fields: string[]) => {
    const key = atField(state.problem, ...fields)
    return key ? t(key) : undefined
  }
  const close = () => actions?.onNewSheetClose?.()
  return (
    <Modal
      open
      onClose={close}
      title={t('newSheet.title')}
      subtitle={t('newSheet.subtitle')}
      size="md"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onNewSheetSave?.()}>
            {state.busy ? <Spinner size={14} /> : null} {t('newSheet.add')}
          </Button>
        </>
      }
    >
      <div className="fw-rk-form">
        {state.problem && !state.problem.field && <Banner tone="danger" title={t(state.problem.key)} />}
        <Field label={t('newSheet.site')} required error={api('siteId')}>
          <Select value={state.siteId ?? ''} onChange={(event) => set({ siteId: event.target.value || null })} aria-label={t('newSheet.site')} disabled={sites.length <= 1 && !!state.siteId}>
            <option value="">{t('newSheet.chooseSite')}</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="fw-rk-form-row">
          <Field label={t('newSheet.code')} required hint={t('newSheet.codeHint')} error={api('code')}>
            <Input value={state.code} maxLength={20} onChange={(event) => set({ code: event.target.value.toUpperCase() })} />
          </Field>
          <Field label={t('newSheet.name')} required error={api('name')}>
            <Input value={state.name} maxLength={120} onChange={(event) => set({ name: event.target.value })} />
          </Field>
        </div>
        <Field label={t('newSheet.description')} error={api('description')}>
          <Textarea value={state.description} rows={2} onChange={(event) => set({ description: event.target.value })} />
        </Field>
        <p className="fw-rk-muted">{t('newSheet.next')}</p>
      </div>
    </Modal>
  )
}
