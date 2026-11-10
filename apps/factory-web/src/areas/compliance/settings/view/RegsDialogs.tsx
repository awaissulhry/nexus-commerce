'use client'

import Link from 'next/link'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Input, Pill, RadioCard, Select } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { assessHeld, CHANGE_KINDS, CHANGE_TONE, changeHeld, ENTRY_TONE, entryHeld, IMPACTS, moveHeld, REGULATION_KINDS, REGULATION_STATUSES, TRANSITION_TONE, valueOf, type EntryDraft } from '../model'
import type { RegsState, RulesMarketsActions, RulesMarketsModel } from '../view-model'
import { NoticeBanner, SectionFailed, SectionLoading, WriteProblem, useDay, useWords } from './parts'

const dayLocale = (locale: string) => (locale === 'it' ? 'it-IT' : 'en-GB')

/** New entry in the register: code and edition (one row per edition), title, kind, the Official Journal citation, link, status. */
export function NewEntryDialog({ state, actions }: { state: RegsState; actions?: RulesMarketsActions | undefined }) {
  const t = useWords()
  const locale = useLocale()
  const add = state.add!
  const draft = add.draft
  const set = (next: Partial<EntryDraft>) => actions?.regs?.onAddDraft?.({ ...draft, ...next })
  const held = add.writing.busy ? 'held.busy' : entryHeld(draft)
  const close = () => actions?.onAddress?.({ add: false })
  return (
    <Modal
      open
      onClose={close}
      title={t('regs.addTitle')}
      size="lg"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.regs?.onAddSave?.()}>
            {t('regs.addSave')}
          </Button>
        </>
      }
    >
      <div className="fw-rm-form-grid">
        <Field label={t('field.code')} hint={t('regs.codeHint')} required>
          <Input size="sm" value={draft.code} maxLength={100} placeholder="EN 17092-4" onChange={(event) => set({ code: event.target.value })} />
        </Field>
        <Field label={t('field.edition')} hint={t('regs.editionHint')}>
          <Input size="sm" value={draft.edition} maxLength={40} placeholder="2020" onChange={(event) => set({ edition: event.target.value })} />
        </Field>
        <div className="fw-rm-span">
          <Field label={t('field.title')} required>
            <Input size="sm" value={draft.title} maxLength={300} onChange={(event) => set({ title: event.target.value })} />
          </Field>
        </div>
        <Field label={t('field.kind')} required>
          <Select size="sm" value={draft.kind ?? ''} onChange={(event) => set({ kind: (event.target.value || null) as EntryDraft['kind'] })}>
            <option value="">{t('common.choose')}</option>
            {REGULATION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`regKind.${kind}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('field.status')}>
          <Select size="sm" value={draft.status} onChange={(event) => set({ status: event.target.value as EntryDraft['status'] })}>
            {REGULATION_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`regStatus.${status}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('field.ojReference')} hint={t('regs.ojHint')}>
          <Input size="sm" value={draft.ojReference} maxLength={200} onChange={(event) => set({ ojReference: event.target.value })} />
        </Field>
        <Field label={t('field.ojDate')}>
          <DateField value={draft.ojDate ?? ''} locale={dayLocale(locale)} clearable onChange={(value) => set({ ojDate: value || null })} />
        </Field>
        <div className="fw-rm-span">
          <Field label={t('field.link')} hint={t('regs.linkHint')}>
            <Input size="sm" value={draft.link} maxLength={2000} placeholder="https://" onChange={(event) => set({ link: event.target.value })} />
          </Field>
        </div>
        <div className="fw-rm-span">
          <WriteProblem writing={add.writing} />
        </div>
      </div>
    </Modal>
  )
}

/**
 * An entry's window: what it is, the registered certificates that cite it (number, status, valid to, styles covered), what it
 * supersedes, its changes; Mark superseded or withdrawn (raises the change naming the certificates, with the words of what
 * changed and the transition's end), Record a change, Delete a row typed by mistake (held while anything names it).
 */
export function EntryWindow({ model, state, actions }: { model: RulesMarketsModel; state: RegsState; actions?: RulesMarketsActions | undefined }) {
  const t = useWords()
  const day = useDay()
  const locale = useLocale()
  const entry = state.entry!
  const record = valueOf(entry.read)
  const others = (valueOf(state.entries)?.entries ?? []).filter((row) => row.id !== entry.id)
  const close = () => actions?.onAddress?.({ open: null })
  const canManage = model.can.rulesManage && (valueOf(state.entries)?.mayManage ?? true)
  const manageHeld = canManage ? (model.live === 'offline' ? t('held.offline') : null) : t('held.rulesManage')
  const busy = entry.writing.busy

  const body = () => {
    if (entry.read.status === 'loading') return <SectionLoading rows={4} />
    if (entry.read.status === 'error') return <SectionFailed title={t('regs.entryFailed')} problem={entry.read.problem} onRetry={actions?.regs?.onRetryOpen} />
    const { entry: row, certificates, supersedes, changes } = entry.read.value
    const deleteHeld = manageHeld ?? (row.usedBy > 0 || changes.length > 0 || supersedes.length > 0 ? t('held.entryNamed') : null)
    return (
      <div className="fw-rm-form">
        {entry.saved && <NoticeBanner tone={entry.saved.tone} title={t(entry.saved.key, entry.saved.params)} />}
        <div className="fw-rm-facts">
          <Pill tone={ENTRY_TONE[row.status]} dot>
            {t(`regStatus.${row.status}`)}
          </Pill>
          <span>{t(`regKind.${row.kind}`)}</span>
          <span className="fw-rm-muted">{row.ojReference ? `${row.ojReference}${row.ojDate ? ` · ${day(row.ojDate)}` : ''}` : t('regs.notCited')}</span>
          {row.supersededBy && <span className="fw-rm-muted">{t('regs.supersededBy', { label: row.supersededBy.label })}</span>}
        </div>
        <p>{row.titleI18n[locale] ?? row.title}</p>
        <h3 className="fw-rm-h3">{t('regs.citing', { count: certificates.length })}</h3>
        {certificates.length === 0 ? (
          <p className="fw-rm-muted">{t('regs.noCertificates')}</p>
        ) : (
          <SummaryTable
            label={t('regs.citing', { count: certificates.length })}
            columns={[t('regs.col.certificate'), t('regs.col.certStatus'), t('regs.col.validTo'), t('regs.col.styles')]}
            rows={certificates.map((certificate) => ({
              id: certificate.id,
              cells: [
                <Link key="n" className="fw-rm-link" href={`${model.prefix}/compliance/certificates/${encodeURIComponent(certificate.id)}`}>
                  {certificate.number}
                </Link>,
                certificate.status,
                day(certificate.validTo),
                t('watch.styles', { count: certificate.styles }),
              ],
            }))}
            stackOnPhone
          />
        )}
        {supersedes.length > 0 && <p className="fw-rm-muted">{t('regs.supersedes', { list: supersedes.map((item) => item.label).join(', ') })}</p>}
        <h3 className="fw-rm-h3">{t('regs.changes', { count: changes.length })}</h3>
        {changes.length === 0 ? (
          <p className="fw-rm-muted">{t('regs.noChangesYet')}</p>
        ) : (
          <ul className="fw-rm-lines">
            {changes.map((change) => (
              <li key={change.id}>
                <Button size="sm" variant="quiet" onClick={() => actions?.onAddress?.({ open: null, change: change.id })}>
                  {t(`changeKind.${change.kind}`)} · {t(`changeStatus.${change.status}`)}
                </Button>{' '}
                <span className="fw-rm-muted">{change.whatChanged}</span>
              </li>
            ))}
          </ul>
        )}
        {entry.mode === 'move' && (
          <div className="fw-rm-panel">
            <h3 className="fw-rm-h3">{t('regs.moveTitle')}</h3>
            <fieldset className="fw-rm-choices">
              <legend className="fw-rm-question">{t('field.status')}</legend>
              {REGULATION_STATUSES.map((status) => (
                <RadioCard key={status} variant="row" name="rm-move" checked={entry.move.status === status} selected={entry.move.status === status} onChange={() => actions?.regs?.onMove?.({ ...entry.move, status, supersededById: status === 'SUPERSEDED' ? entry.move.supersededById : null })} title={t(`regStatus.${status}`)} />
              ))}
            </fieldset>
            {entry.move.status === 'SUPERSEDED' && (
              <Field label={t('field.supersededById')}>
                <Select size="sm" value={entry.move.supersededById ?? ''} onChange={(event) => actions?.regs?.onMove?.({ ...entry.move, supersededById: event.target.value || null })}>
                  <option value="">{t('regs.noSuccessor')}</option>
                  {others.map((other) => (
                    <option key={other.id} value={other.id}>
                      {other.label}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {entry.move.status !== 'IN_FORCE' && (
              <>
                <Field label={t('field.whatChanged')} hint={t('regs.raisesChange', { count: row.usedBy })} required>
                  <Textarea value={entry.move.reason} rows={3} maxLength={4000} onChange={(event) => actions?.regs?.onMove?.({ ...entry.move, reason: event.target.value })} />
                </Field>
                <Field label={t('field.transitionEndsOn')}>
                  <DateField value={entry.move.transitionEndsOn ?? ''} locale={dayLocale(locale)} clearable onChange={(value) => actions?.regs?.onMove?.({ ...entry.move, transitionEndsOn: value || null })} />
                </Field>
              </>
            )}
            <span className="fw-rm-row">
              <Button onClick={() => actions?.regs?.onEntryMode?.('view')}>{t('common.cancel')}</Button>
              <Button variant="primary" heldReason={busy ? t('held.busy') : moveHeld(entry.move, row.status) ? t(moveHeld(entry.move, row.status)!) : null} onClick={() => actions?.regs?.onMoveSave?.()}>
                {t('regs.moveSave')}
              </Button>
            </span>
          </div>
        )}
        {entry.mode === 'change' && (
          <div className="fw-rm-panel">
            <h3 className="fw-rm-h3">{t('regs.changeTitle')}</h3>
            <div className="fw-rm-form-grid">
              <Field label={t('field.kind')}>
                <Select size="sm" value={entry.change.kind} onChange={(event) => actions?.regs?.onChangeDraft?.({ ...entry.change, kind: event.target.value as typeof entry.change.kind })}>
                  {CHANGE_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {t(`changeKind.${kind}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('field.newStandardId')}>
                <Select size="sm" value={entry.change.newStandardId ?? ''} onChange={(event) => actions?.regs?.onChangeDraft?.({ ...entry.change, newStandardId: event.target.value || null })}>
                  <option value="">{t('regs.noSuccessor')}</option>
                  {others.map((other) => (
                    <option key={other.id} value={other.id}>
                      {other.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="fw-rm-span">
                <Field label={t('field.whatChanged')} required>
                  <Textarea value={entry.change.whatChanged} rows={3} maxLength={4000} onChange={(event) => actions?.regs?.onChangeDraft?.({ ...entry.change, whatChanged: event.target.value })} />
                </Field>
              </div>
              <Field label={t('field.sourceReference')} hint={t('regs.sourceHint')}>
                <Input size="sm" value={entry.change.sourceReference} maxLength={300} onChange={(event) => actions?.regs?.onChangeDraft?.({ ...entry.change, sourceReference: event.target.value })} />
              </Field>
              <Field label={t('field.transitionEndsOn')}>
                <DateField value={entry.change.transitionEndsOn ?? ''} locale={dayLocale(locale)} clearable onChange={(value) => actions?.regs?.onChangeDraft?.({ ...entry.change, transitionEndsOn: value || null })} />
              </Field>
            </div>
            <span className="fw-rm-row">
              <Button onClick={() => actions?.regs?.onEntryMode?.('view')}>{t('common.cancel')}</Button>
              <Button variant="primary" heldReason={busy ? t('held.busy') : changeHeld(entry.change) ? t(changeHeld(entry.change)!) : null} onClick={() => actions?.regs?.onChangeSave?.()}>
                {t('regs.changeSave')}
              </Button>
            </span>
          </div>
        )}
        {entry.mode === 'delete' && (
          <Banner
            tone="danger"
            title={t('regs.deleteConfirm', { label: row.label })}
            action={
              <span className="fw-rm-row">
                <Button size="sm" onClick={() => actions?.regs?.onEntryMode?.('view')}>
                  {t('common.cancel')}
                </Button>
                <Button size="sm" variant="danger" heldReason={busy ? t('held.busy') : deleteHeld} onClick={() => actions?.regs?.onDelete?.()}>
                  {t('regs.delete')}
                </Button>
              </span>
            }
          />
        )}
        <WriteProblem writing={entry.writing} />
        {entry.mode === 'view' && (
          <span className="fw-rm-row">
            <Button heldReason={manageHeld} onClick={() => actions?.regs?.onEntryMode?.('move')}>
              {t('regs.move')}
            </Button>
            <Button heldReason={manageHeld} onClick={() => actions?.regs?.onEntryMode?.('change')}>
              {t('regs.recordChange')}
            </Button>
            <Button variant="danger" heldReason={deleteHeld} onClick={() => actions?.regs?.onEntryMode?.('delete')}>
              {t('regs.delete')}
            </Button>
          </span>
        )}
      </div>
    )
  }
  return (
    <Modal open onClose={close} title={record?.entry.label ?? t('regs.entry')} subtitle={record ? t(`regKind.${record.entry.kind}`) : undefined} size="lg">
      {body()}
    </Modal>
  )
}

/**
 * A change of the watch: what changed, the transition, the registered certificates it names and the styles they cover, the
 * type-change reviews it opened, the impact task; Assess (impact NONE, REVIEW or RETEST in words; REVIEW / RETEST name the
 * certificates whose notified body must look again — each opens W2a's review, which holds the revision's class label until
 * decided), Open impact task (one checklist item per affected style) and Close.
 */
export function ChangeWindow({ model, state, actions }: { model: RulesMarketsModel; state: RegsState; actions?: RulesMarketsActions | undefined }) {
  const t = useWords()
  const day = useDay()
  const windowState = state.change!
  const close = () => actions?.onAddress?.({ change: null })
  const manageHeld = model.can.rulesManage ? (model.live === 'offline' ? t('held.offline') : null) : t('held.rulesManage')
  const busy = windowState.writing.busy
  const body = () => {
    if (windowState.read.status === 'loading') return <SectionLoading rows={4} />
    if (windowState.read.status === 'error') return <SectionFailed title={t('watch.changeFailed')} problem={windowState.read.problem} onRetry={actions?.regs?.onRetryOpen} />
    const change = windowState.read.value
    const assess = windowState.assess
    const toggle = (id: string, on: boolean) => actions?.regs?.onAssess?.({ ...assess, reviewCertificateIds: on ? [...assess.reviewCertificateIds, id] : assess.reviewCertificateIds.filter((entry) => entry !== id) })
    return (
      <div className="fw-rm-form">
        {windowState.saved && <NoticeBanner tone={windowState.saved.tone} title={t(windowState.saved.key, windowState.saved.params)} />}
        <div className="fw-rm-facts">
          <Pill tone={CHANGE_TONE[change.status]} dot>
            {t(`changeStatus.${change.status}`)}
          </Pill>
          <span>{t(`changeKind.${change.kind}`)}</span>
          {change.transition !== 'NONE' && <Pill tone={TRANSITION_TONE[change.transition]}>{t(`transition.${change.transition}`, { date: day(change.transitionEndsOn) })}</Pill>}
          <span className="fw-rm-muted">{t('watch.noticed', { date: day(change.noticedAt), name: change.noticedBy?.name ?? t('watch.theRegister') })}</span>
        </div>
        <p>{change.whatChanged}</p>
        {change.sourceReference && <p className="fw-rm-muted">{t('watch.source', { source: change.sourceReference })}</p>}
        <h3 className="fw-rm-h3">{t('watch.affected', { certificates: change.certificates.length, styles: change.styles.length })}</h3>
        {change.styles.length === 0 ? (
          <p className="fw-rm-muted">{t('watch.noStyles')}</p>
        ) : (
          <SummaryTable
            label={t('watch.col.styles')}
            columns={[t('watch.col.style'), t('watch.col.coveredBy')]}
            rows={change.styles.map((style) => ({
              id: style.id,
              cells: [`${style.code} · ${style.name}`, style.certificateIds.map((id) => change.certificates.find((certificate) => certificate.id === id)?.number ?? '').filter(Boolean).join(', ')],
            }))}
            stackOnPhone
          />
        )}
        {change.reviews.length > 0 && (
          <>
            <h3 className="fw-rm-h3">{t('watch.reviews', { count: change.reviews.length })}</h3>
            <ul className="fw-rm-lines">
              {change.reviews.map((review) => (
                <li key={review.id}>{t('watch.review', { style: review.styleCode, revision: review.revision, status: review.status })}</li>
              ))}
            </ul>
          </>
        )}
        {change.status !== 'OPEN' && change.impact && (
          <p>
            <b>{t(`impact.${change.impact}`)}</b> — {change.assessment} <span className="fw-rm-muted">{t('watch.assessedBy', { name: change.assessedBy?.name ?? '—', date: day(change.assessedAt) })}</span>
          </p>
        )}
        {change.status === 'OPEN' && (
          <div className="fw-rm-panel">
            <h3 className="fw-rm-h3">{t('watch.assessTitle')}</h3>
            <fieldset className="fw-rm-choices" disabled={!!manageHeld}>
              <legend className="fw-rm-question">{t('field.impact')}</legend>
              {IMPACTS.map((impact) => (
                <RadioCard key={impact} name="rm-impact" checked={assess.impact === impact} selected={assess.impact === impact} onChange={() => actions?.regs?.onAssess?.({ ...assess, impact, reviewCertificateIds: impact === 'NONE' ? [] : assess.reviewCertificateIds })} title={t(`impact.${impact}`)} description={t(`impactHint.${impact}`)} />
              ))}
            </fieldset>
            {assess.impact && assess.impact !== 'NONE' && (
              <fieldset className="fw-rm-choices" disabled={!!manageHeld}>
                <legend className="fw-rm-question">{t('field.reviewCertificateIds')}</legend>
                {change.certificates.length === 0 ? (
                  <p className="fw-rm-muted">{t('watch.noCertificates')}</p>
                ) : (
                  change.certificates.map((certificate) => <Checkbox key={certificate.id} label={`${certificate.number} · ${certificate.status} · ${day(certificate.validTo)}`} checked={assess.reviewCertificateIds.includes(certificate.id)} onChange={(event) => toggle(certificate.id, event.target.checked)} />)
                )}
                <p className="fw-rm-muted">{t('watch.reviewNote')}</p>
              </fieldset>
            )}
            <Field label={t('field.assessment')} required>
              <Textarea value={assess.assessment} rows={3} maxLength={4000} disabled={!!manageHeld} onChange={(event) => actions?.regs?.onAssess?.({ ...assess, assessment: event.target.value })} />
            </Field>
            <span className="fw-rm-row">
              <Button variant="primary" heldReason={manageHeld ?? (busy ? t('held.busy') : assessHeld(assess) ? t(assessHeld(assess)!) : null)} onClick={() => actions?.regs?.onAssessSave?.()}>
                {t('watch.assess')}
              </Button>
            </span>
          </div>
        )}
        <WriteProblem writing={windowState.writing} />
        <span className="fw-rm-row">
          {change.task ? (
            <span className="fw-rm-muted">{t('watch.taskOpen', { title: change.task.title, status: change.task.status })}</span>
          ) : (
            <Button heldReason={manageHeld ?? (change.status === 'CLOSED' ? t('held.closed') : busy ? t('held.busy') : null)} onClick={() => actions?.regs?.onTask?.()}>
              {t('watch.openTask')}
            </Button>
          )}
          <Button variant="primary" heldReason={manageHeld ?? (change.status !== 'ASSESSED' ? t(change.status === 'CLOSED' ? 'held.closed' : 'held.assessFirst') : busy ? t('held.busy') : null)} onClick={() => actions?.regs?.onClose?.()}>
            {t('watch.close')}
          </Button>
        </span>
      </div>
    )
  }
  const change = valueOf(windowState.read)
  return (
    <Modal open onClose={close} title={change ? t('watch.changeTitle', { label: change.standard.label }) : t('watch.change')} subtitle={change ? t(`changeKind.${change.kind}`) : undefined} size="lg">
      {body()}
    </Modal>
  )
}
