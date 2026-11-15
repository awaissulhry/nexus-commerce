'use client'

import type { ReactNode } from 'react'
import { FlaskConical } from 'lucide-react'
import { Banner, KeyValue } from '@nexus/ui/components'
import { Pill, Toggle } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Words } from '../../../shipments/queue/shared/depth'
import { DepthDialog, PartRead } from '../../../shipments/queue/shared/DepthDialog'
import { DISPATCH_NAMESPACES, DISPATCH_NS } from '../../../shipments/pickup/dispatch'
import { liveHeld, testHeld, type TestModeActions, type TestModeModel } from '../model'
import { SettingsCard } from '../settings-card'
import '../../../shipments/queue/shared/depth.css'
import '../../shipping-setup.css'

/**
 * SCR-656 — Carriers & shipping › Test mode (B-W2b-412 on B-W2b-390; LOG-035; design warehouse.shipping sec sp-test, pop
 * sp-golive): the chosen site's switch with the words of what it does — in test mode the labels come from a test carrier,
 * marked TEST, and nothing is sent to a carrier or charged — and Switch to live labels: the confirm says labels are bought and
 * charged from then on and how many TEST labels of shipments not left yet are cleared, asks a fresh code, and is held with the
 * reason while the site cannot go live (no settings, no usable carrier connection). Back to test mode keeps the labels bought.
 */
export function TestModeView({ model, actions }: { model: TestModeModel; actions?: TestModeActions }) {
  return (
    <WithMessages namespaces={DISPATCH_NAMESPACES}>
      <Body model={model} actions={actions} />
    </WithMessages>
  )
}

function Body({ model, actions }: { model: TestModeModel; actions?: TestModeActions }) {
  const t = useT(DISPATCH_NS)
  const locale = useLocale()
  const say = (value: Words | null) => (value ? t(value.key, value.params) : null)
  const card = (children: ReactNode) => (
    <SettingsCard id="test-mode" icon={<FlaskConical size={16} aria-hidden />} title={t('test.title')} intro={t('test.intro')} done={model.done} problem={model.confirm ? null : model.problem} onDismiss={actions?.onDismiss} stepUp={model.stepUp} onStepUpSubmit={actions?.onStepUpSubmit} onStepUpCancel={actions?.onStepUpCancel}>
      {children}
    </SettingsCard>
  )
  if (model.sites.state !== 'ready') return card(<PartRead problem={model.sites.state === 'error' ? model.sites.problem : null} onRetry={actions?.onRetry} label={t('test.title')} />)
  const site = model.sites.value.find((entry) => entry.siteId === model.siteId) ?? null
  if (!site) return card(<p className="fw-shipset-hint">{t('test.noSite')}</p>)
  const others = model.sites.value.filter((entry) => entry.siteId !== site.siteId && entry.testMode).length
  const held = site.testMode ? liveHeld(site, model.can, model.busy) : testHeld(site, model.can, model.busy)
  return card(
    <>
      <span className="fw-shipset-pills">
        <Pill tone={site.testMode ? 'warning' : 'success'}>{t(site.testMode ? 'test.pill.test' : 'test.pill.live')}</Pill>
        {model.can.settingsManage && (
          <Toggle
            checked={site.testMode}
            onChange={(next) => actions?.onConfirm?.(next ? 'test' : 'live')}
            aria-label={t('test.toggle', { site: site.code })}
            title={say(held) ?? undefined}
          />
        )}
        <span className="fw-shipset-hint">{t(site.testMode ? 'test.toggleOn' : 'test.toggleOff')}</span>
      </span>
      <p className="fw-shipset-hint">{t(site.testMode ? 'test.words.on' : 'test.words.off')}</p>
      <KeyValue
        items={[
          { label: t('test.site'), value: `${site.code} · ${site.name}` },
          { label: t('test.since'), value: site.liveSince ? t('test.liveSince', { when: formatDateTime(site.liveSince, { locale }) }) : t('test.neverLive') },
          ...(site.testMode && site.goLive.testLabelsToClear > 0 ? [{ label: t('test.testLabels'), value: t('test.toClear', { count: site.goLive.testLabelsToClear }) }] : []),
        ]}
      />
      {site.testMode && !site.goLive.ready && <Banner tone="info" title={say(liveHeld(site, { settingsManage: true }, false))} />}
      {!model.can.settingsManage && <p className="fw-shipset-hint">{t('test.held.noRight')}</p>}
      {others > 0 && <p className="fw-shipset-hint">{t('test.others', { count: others })}</p>}
      {model.confirm === 'live' && (
        <DepthDialog title={t('test.live.title', { site: site.code })} held={say(liveHeld(site, model.can, model.busy))} onGo={() => actions?.onGo?.()} goLabel={t('test.live.go')} onClose={() => actions?.onConfirm?.(null)} problem={say(model.problem)} tone="danger" size="sm">
          <Banner tone="warning" title={t('test.live.warning')} />
          {site.goLive.testLabelsToClear > 0 && <p>{t('test.live.clears', { count: site.goLive.testLabelsToClear })}</p>}
          <p className="fw-shipset-hint">{t('test.live.code')}</p>
        </DepthDialog>
      )}
      {model.confirm === 'test' && (
        <DepthDialog title={t('test.back.title', { site: site.code })} held={say(testHeld(site, model.can, model.busy))} onGo={() => actions?.onGo?.()} goLabel={t('test.back.go')} onClose={() => actions?.onConfirm?.(null)} problem={say(model.problem)} size="sm">
          <p>{t('test.back.body')}</p>
        </DepthDialog>
      )}
    </>,
  )
}
