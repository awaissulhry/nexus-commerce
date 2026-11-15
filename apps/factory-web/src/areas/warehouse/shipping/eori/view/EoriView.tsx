'use client'

import type { ReactNode } from 'react'
import { Landmark } from 'lucide-react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, Pill, Toggle } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Words } from '../../../shipments/queue/shared/depth'
import { DepthDialog, PartRead } from '../../../shipments/queue/shared/DepthDialog'
import { DISPATCH_NAMESPACES, DISPATCH_NS } from '../../../shipments/pickup/dispatch'
import { EORI_MAX, eoriProblem, packSwitchHeld, saveHeld, type EoriActions, type EoriModel } from '../model'
import { SettingsCard } from '../../test-mode/settings-card'
import '../../../shipments/queue/shared/depth.css'
import '../../shipping-setup.css'

/**
 * SCR-658 — Carriers & shipping › EORI (B-W2b-412 on B-W2b-409; LOG-095, LOG-097; design warehouse.shipping sec sp-eori):
 * the company's EORI for customs documents (kept in capitals without spaces, dots or dashes; without it no commercial
 * invoice or CN 22 / CN 23 is made), and the chosen site's switch to send the broker's pack by link (on: the papers go to a
 * third party, so it asks a fresh code; off: downloads only).
 */
export function EoriView({ model, actions }: { model: EoriModel; actions?: EoriActions }) {
  return (
    <WithMessages namespaces={DISPATCH_NAMESPACES}>
      <Body model={model} actions={actions} />
    </WithMessages>
  )
}

function Body({ model, actions }: { model: EoriModel; actions?: EoriActions }) {
  const t = useT(DISPATCH_NS)
  const say = (value: Words | null) => (value ? t(value.key, value.params) : null)
  const card = (children: ReactNode) => (
    <SettingsCard id="eori" icon={<Landmark size={16} aria-hidden />} title={t('eori.title')} intro={t('eori.intro')} done={model.done} problem={model.confirm ? null : model.problem} onDismiss={actions?.onDismiss} stepUp={model.stepUp} onStepUpSubmit={actions?.onStepUpSubmit} onStepUpCancel={actions?.onStepUpCancel}>
      {children}
    </SettingsCard>
  )
  if (model.settings.state !== 'ready') return card(<PartRead problem={model.settings.state === 'error' ? model.settings.problem : null} onRetry={actions?.onRetry} label={t('eori.title')} />)
  const settings = model.settings.value
  const typed = model.typed ?? settings.company.eori ?? ''
  const editable = model.can.settingsManage && settings.company.mayManage
  const site = settings.sites.find((entry) => entry.siteId === model.siteId) ?? null
  return card(
    <>
      {editable ? (
        <form
          className="fw-dsp-inline-form"
          onSubmit={(event) => {
            event.preventDefault()
            actions?.onSave?.()
          }}
        >
          <Field label={t('eori.field', { company: settings.company.name })} hint={t('eori.hint')} error={say(eoriProblem(typed)) ?? undefined}>
            <Input value={typed} maxLength={EORI_MAX} spellCheck={false} autoCapitalize="characters" className="fw-sh-mono" placeholder="IT00000000000" onChange={(event) => actions?.onType?.(event.target.value.toUpperCase())} />
          </Field>
          <span>
            <Button type="submit" size="sm" variant="primary" heldReason={say(saveHeld(settings, typed, model.can, model.busy))}>
              {t('eori.save')}
            </Button>
          </span>
        </form>
      ) : (
        <KeyValue items={[{ label: t('eori.field', { company: settings.company.name }), value: settings.company.eori ? <span className="fw-sh-mono">{settings.company.eori}</span> : t('eori.none') }]} />
      )}
      {!settings.company.eori && <Banner tone="warning" title={t('eori.missing')} />}
      {site && (
        <div className="fw-shd-check">
          <span className="fw-shipset-pills">
            <strong>{t('eori.pack.title', { site: site.code })}</strong>
            <Pill tone={site.brokerPackOn ? 'info' : 'neutral'}>{t(site.brokerPackOn ? 'eori.pack.on' : 'eori.pack.off')}</Pill>
            {editable && site.hasSettings && <Toggle checked={site.brokerPackOn} onChange={(next) => actions?.onConfirm?.(next ? 'on' : 'off')} aria-label={t('eori.pack.toggle', { site: site.code })} />}
          </span>
          <p className="fw-shipset-hint">{t(site.brokerPackOn ? 'eori.pack.wordsOn' : 'eori.pack.wordsOff')}</p>
          {!site.hasSettings && <p className="fw-shipset-hint">{t('eori.held.noSettings')}</p>}
          {!editable && <p className="fw-shipset-hint">{t('eori.held.noRight')}</p>}
        </div>
      )}
      {model.confirm && site && (
        <DepthDialog
          title={t(model.confirm === 'on' ? 'eori.pack.onTitle' : 'eori.pack.offTitle', { site: site.code })}
          held={say(packSwitchHeld(site, model.can, model.busy))}
          onGo={() => actions?.onSwitch?.()}
          goLabel={t(model.confirm === 'on' ? 'eori.pack.onGo' : 'eori.pack.offGo')}
          onClose={() => actions?.onConfirm?.(null)}
          problem={say(model.problem)}
          size="sm"
        >
          <p>{t(model.confirm === 'on' ? 'eori.pack.onBody' : 'eori.pack.offBody')}</p>
        </DepthDialog>
      )}
    </>,
  )
}
