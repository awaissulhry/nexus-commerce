'use client'

import { Power } from 'lucide-react'
import { Banner, Card, Field } from '@nexus/ui/components'
import { Button, Pill, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useAccountingWords } from '../../checks/words'
import { REASON_MAX, type JournalsSettings } from '../api'
import { switchConsequences, switchHeld } from '../model'
import type { MappingActions, MappingPageModel, SwitchDialogModel } from '../view-model'

/**
 * The journals switch (FIN-151; B-W2b-408's GET/PUT /accounting/settings): whether the journal packages also carry their
 * entries with the mapped accounts (an `_entries` file per journal, and the checks "Every account mapped" and "Journal
 * entries balance"). Off by default: it waits for the accountant to confirm the mapping (GATE-ACCOUNTANT). Who switches
 * holds accounting.journals.switch and gives a fresh code; the reason is kept in the history.
 */
export function JournalsCard({ model, actions }: { model: MappingPageModel; actions?: MappingActions }) {
  const t = useAccountingWords()
  const settings = model.answer?.journals ?? null
  return (
    <Card padded className="fw-fac-card fw-fam-journals" aria-labelledby="fw-fam-journals-title">
      <div className="fw-fac-card-head">
        <h3 className="fw-fac-h3" id="fw-fam-journals-title">
          {t('journals.title')}
        </h3>
        {settings ? <Pill tone={settings.journalsOn ? 'success' : 'neutral'}>{t(settings.journalsOn ? 'journals.on.state' : 'journals.off.state')}</Pill> : null}
      </div>
      {settings ? (
        <>
          <p className="fw-fac-muted">{t(settings.journalsOn ? 'journals.on.words' : 'journals.off.words')}</p>
          <p className="fw-fac-muted">{t(`journals.from.${settings.from}`)}</p>
          <span className="fw-fac-actions">
            <Button size="sm" variant={settings.journalsOn ? 'secondary' : 'primary'} heldReason={model.can.switch ? undefined : t('journals.held.noSwitch')} onClick={() => actions?.onSwitchOpen?.()}>
              <Power size={13} aria-hidden /> {t(settings.journalsOn ? 'journals.switchOff' : 'journals.switchOn')}
            </Button>
          </span>
        </>
      ) : (
        <p className="fw-fac-muted">{t(model.problem ? 'mapping.failed' : 'mapping.leadReading')}</p>
      )}
    </Card>
  )
}

/** "Switch the journals on?" / "off?": what changes, the reason, then a fresh code (asked first). Esc closes. */
export function SwitchDialog({ model, switching, settings, unmapped, actions }: { model: MappingPageModel; switching: SwitchDialogModel; settings: JournalsSettings; unmapped: number; actions?: MappingActions }) {
  const t = useAccountingWords()
  const held = switchHeld(switching, model.can)
  const consequences = switchConsequences(settings, unmapped)
  return (
    <Modal
      open
      onClose={() => actions?.onSwitchClose?.()}
      closeHeld={switching.busy ? t('journals.held.running') : null}
      title={t(settings.journalsOn ? 'journals.dialog.offTitle' : 'journals.dialog.onTitle')}
      size="md"
      footer={
        <>
          <Button size="sm" variant="quiet" heldReason={switching.busy ? t('journals.held.running') : undefined} onClick={() => actions?.onSwitchClose?.()}>
            {t('common.cancel')}
          </Button>
          <span className="grow" />
          <Button size="sm" variant={settings.journalsOn ? 'danger' : 'primary'} heldReason={held ? t(held.key, held.params) : undefined} onClick={() => actions?.onSwitchGo?.()}>
            {t(settings.journalsOn ? 'journals.dialog.offGo' : 'journals.dialog.onGo')}
          </Button>
        </>
      }
    >
      <div className="fw-fac-dialog">
        <ul className="fw-fac-list">
          {consequences.map((entry) => (
            <li key={entry.key}>{t(entry.key, entry.params)}</li>
          ))}
        </ul>
        <Field label={t('journals.dialog.reason')} hint={t('journals.dialog.reasonHint')}>
          <Textarea autoFocus value={switching.reason} limit={REASON_MAX} rows={2} onChange={(event) => actions?.onSwitchReason?.(event.target.value)} />
        </Field>
        <p className="fw-fac-muted">{t('journals.dialog.code')}</p>
        {switching.problem && <Banner tone="danger" title={t(switching.problem.key, switching.problem.params)} />}
        {switching.busy && (
          <p className="fw-fac-muted" role="status">
            <Spinner size={12} /> {t('common.working')}
          </p>
        )}
      </div>
    </Modal>
  )
}
