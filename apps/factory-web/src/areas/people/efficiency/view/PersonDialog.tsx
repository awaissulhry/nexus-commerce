'use client'

import { Banner, Card, Combobox, EmptyState, SummaryTable } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { printHide } from '@nexus/ui/patterns/print-view/index'
import { Button, Select, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { useWords } from '../../_shared/parts'
import { OPEN_REASONS, type OpenReason } from '../api'
import { individualWhy, minutesText, percentText, personHeld } from '../model'
import type { PersonDialogActions, PersonDialogState } from '../use-person'
import type { EfficiencyActions, EfficiencyModel } from './EfficiencyView'
import { SectionHead } from './FiguresPanels'

/**
 * One person's figures (design sec:individual; MES-249). The panel appears only when the API says the site has its recorded legal
 * basis AND the viewer is HR or the worker (`individual.available`): until then there is no picker and no person, and the
 * words say why. "View one person" is the only way in, one person at a time, with a purpose.
 */
export function IndividualPanel({ model, actions }: { model: EfficiencyModel; actions?: EfficiencyActions | undefined }) {
  const t = useT('people-efficiency')
  const people = useWords()
  const ds = useDsWords()
  const sight = model.sight.status === 'ready' ? model.sight.sight : null
  const overview = model.overview.status === 'ready' ? model.overview.value : null
  if (!sight || model.overview.status === 'error') return null
  const available = overview?.individual.available ?? false
  const law = <LawRef law={people('privacy.law')} plain={people('privacy.lawPlain')} labels={ds.lawRef} />
  return (
    <Card padded>
      <SectionHead
        id="fw-ef-individual"
        title={t('section.individual')}
        tools={
          available ? (
            <Button size="sm" onClick={() => actions?.person?.onOpen()}>
              {t('individual.view')}
            </Button>
          ) : null
        }
      />
      <PrivacyNote level={available ? 'individual' : 'line'} variant="panel" text={t(individualWhy(sight.open, available))} law={law} {...(available ? { recorded: true } : {})} labels={ds.privacyNote} />
    </Card>
  )
}

/**
 * The dialog (pop:individual): person, purpose, then the person's days with trainee days left out. What the answer holds lives only
 * in `model` (the hook's state): closing forgets it. No comparison, no rank, no target, no export; off paper too (`printHide`).
 */
export function PersonDialog({ model, scope, timeZone, actions }: { model: PersonDialogState; scope: { from: string; to: string }; timeZone: string; actions?: PersonDialogActions | undefined }) {
  const t = useT('people-efficiency')
  const people = useWords()
  const locale = useLocale()
  const ds = useDsWords()
  const { draft, figures } = model
  const held = personHeld(draft, model.busy)
  const day = (date: string) => formatDate(`${date}T12:00:00Z`, { locale, timeZone })
  const purposeLabel = draft.reason ? t(`purpose.${draft.reason}`) : ''
  const problem = model.problem ?? (model.people.status === 'error' ? model.people.problem : null)
  return (
    <Modal
      open
      onClose={() => actions?.onClose()}
      title={figures ? t('person.titleOf', { name: figures.person.name }) : t('section.individual')}
      size="lg"
      footer={
        figures ? (
          <>
            <Button variant="quiet" onClick={() => actions?.onBack()}>
              {t('person.another')}
            </Button>
            <Button onClick={() => actions?.onClose()}>{people('common.close')}</Button>
          </>
        ) : (
          <>
            <Button variant="quiet" onClick={() => actions?.onClose()}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onShow()}>
              {t('person.show')}
            </Button>
          </>
        )
      }
    >
      <div className="fw-pp-stack" {...printHide}>
        <PrivacyNote level="individual" variant="panel" text={t('person.recorded')} labels={ds.privacyNote} />
        {problem && <Banner tone="danger" title={problem.ns === 'efficiency' ? t(problem.words.key) : people(problem.words.key, problem.words.params)} />}
        {figures ? (
          <>
            <p className="fw-pp-hint">{t('person.period', { from: day(figures.from), to: day(figures.to), purpose: purposeLabel })}</p>
            {figures.days.length === 0 ? (
              <EmptyState title={t('person.empty')} description={t('person.emptyBody')} />
            ) : (
              <SummaryTable
                label={t('person.tableLabel')}
                columns={[t('person.day'), t('person.pieces'), t('tile.earned'), t('person.timed'), t('tile.offStandard'), t('person.efficiency')]}
                align={[undefined, 'right', 'right', 'right', 'right', 'right']}
                stackOnPhone
                rows={figures.days.map((row) => ({ id: row.date, cells: [day(row.date), String(row.pieces), minutesText(row.earnedMinutes, locale), minutesText(row.timedMinutes, locale), minutesText(row.offStandardMinutes, locale), percentText(row.efficiency, locale)] }))}
              />
            )}
            <ul className="fw-pp-list">
              <li>{t('person.denominator')}</li>
              {figures.leftOut.traineeDays > 0 && <li>{t('person.traineeDays', { count: figures.leftOut.traineeDays })}</li>}
              {figures.leftOut.sharedReports > 0 && <li>{t('person.sharedReports', { count: figures.leftOut.sharedReports })}</li>}
              <li>{t('person.noExport')}</li>
            </ul>
          </>
        ) : model.people.status === 'noRegister' ? (
          <EmptyState title={t('person.noRegister')} description={t('person.noRegisterBody')} />
        ) : model.people.status === 'loading' ? (
          <p className="fw-pp-hint" role="status">
            <Spinner size={12} /> {t('common.loading')}
          </p>
        ) : model.people.status === 'ready' ? (
          <>
            <div className="fw-pp-stack tight">
              <span id="fw-ef-person-label">{t('person.who')}</span>
              <Combobox
                labelledBy="fw-ef-person-label"
                placeholder={t('person.search')}
                options={model.people.people.map((entry) => ({ value: entry.id, label: entry.code ? `${entry.name} · ${entry.code}` : entry.name }))}
                value={draft.personId}
                onChange={(personId) => actions?.onDraft({ personId })}
                labels={ds.combobox}
              />
            </div>
            <label className="fw-pp-stack tight">
              <span>{t('person.purpose')}</span>
              <Select value={draft.reason} onChange={(event) => actions?.onDraft({ reason: event.target.value as OpenReason | '' })}>
                <option value="">{t('person.pickPurpose')}</option>
                {OPEN_REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {t(`purpose.${reason}`)}
                  </option>
                ))}
              </Select>
            </label>
            <label className="fw-pp-stack tight">
              <span>{t('person.note')}</span>
              <Textarea value={draft.note} onChange={(event) => actions?.onDraft({ note: event.target.value })} />
            </label>
            <p className="fw-pp-hint">{t('person.scope', { from: day(scope.from), to: day(scope.to) })}</p>
          </>
        ) : null}
      </div>
    </Modal>
  )
}
