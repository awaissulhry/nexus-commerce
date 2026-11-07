'use client'

import { useEffect, useState } from 'react'
import { CalendarPlus, MoreHorizontal, Stethoscope } from 'lucide-react'
import { Banner, Card, MetricStrip, Menu, type Metric } from '@nexus/ui/components'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { AsOf, useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { isListKey } from '../../../../list-frame/model'
import { HEALTH_PATH, isFilterTile, pageMode, tileChange, TILES, wordsIn, type TileId } from '../model'
import type { HealthPageActions, HealthPageModel } from '../view-model'
import '../health.css'
import { BookDialog } from './BookDialog'
import { DueSection } from './DueSection'
import { JudgeDialog } from './JudgeDialog'
import { JudgementsSection, ShowConfirm } from './JudgementsSection'
import { JudgementWindow } from './JudgementWindow'
import { HEALTH_NAMESPACES, KeysModal, NoHealthAccess, ProtectedLaw, SectionFailed, useWords, WhoLooked } from './parts'
import { PlanDialog, PlansSection } from './PlansSection'
import { PlanVisitsDialog } from './PlanVisitsDialog'
import { VisitWindow } from './VisitWindow'

export type { HealthPageActions, HealthPageModel } from '../view-model'

/**
 * SCR-212 — Plant › Health & safety › Health surveillance (design plant.health; QHS-252, QHS-253, QHS-254, QHS-256; D.Lgs.
 * 81/2008 art. 41; GDPR art. 9): the band (the PrivacyNote pill; Plan visits, `p`; Record a judgement, `j`; ⋯ the doctor's visit
 * list, Export due list held with its reason, the keys), the protected page's note (who sees it, the law, every view recorded,
 * "Who looked" for HR and the DPO; live use waits for the company doctor), the tiles (counts), the due list (names: its read is
 * recorded), the judgements (anonymised until Show, each row's view recorded) and the plans per role. The page reads the note
 * FIRST and nothing that names a person before it is on screen. One view model, nothing fetched; the page fills the main area
 * (no max-width); every word from the catalogues; every held button says why.
 */
export function HealthView({ model, actions }: { model: HealthPageModel; actions?: HealthPageActions }) {
  return (
    <WithMessages namespaces={HEALTH_NAMESPACES}>
      <Page model={model} actions={actions} />
    </WithMessages>
  )
}

function Page({ model, actions }: { model: HealthPageModel; actions?: HealthPageActions | undefined }) {
  const t = useWords()
  const ds = useDsWords()
  const [keysOpen, setKeysOpen] = useState(model.keysOpen ?? false)
  const [heldSaid, setHeldSaid] = useState<string | null>(null)
  const { address, can } = model
  const mode = pageMode(can)
  const frame = model.frame.status === 'ready' ? model.frame.value : null
  const manage = frame ? frame.can.manage : can.manage
  const writeHeld = !manage ? t('held.manage') : !frame ? t('held.reading') : null
  const dialogOpen = Boolean(address.judge || address.planVisits || address.visit || address.judgement || address.plan || model.book || keysOpen || model.shown.state === 'confirm')

  // j records a judgement, p plans visits, ? the keys (not in a field, a menu or a dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (dialogOpen || mode !== 'full' || !isListKey(event, event.target as HTMLElement | null)) return
      if (event.key === 'j' || event.key === 'p') {
        event.preventDefault()
        if (writeHeld) setHeldSaid(writeHeld)
        else actions?.onAddress?.(event.key === 'j' ? { judge: '1' } : { planVisits: true })
      } else if (event.key === '?') {
        event.preventDefault()
        setKeysOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (mode === 'none') {
    return (
      <div className="fw-hv">
        <NoHealthAccess />
      </div>
    )
  }

  const printHref = `${model.prefix}${HEALTH_PATH}/print`
  return (
    <div className="fw-hv">
      <div className="fw-hv-band" role="group" aria-label={t('band.label')}>
        <span className="fw-hv-status">
          <PrivacyNote level="protected" text={t('privacy.pill')} recorded labels={ds.privacyNote} />
          {model.readAt ? <AsOf at={model.readAt} /> : null}
        </span>
        {mode === 'full' && (
          <span className="fw-hv-actions">
            <Button size="sm" aria-keyshortcuts="p" heldReason={writeHeld} onClick={() => actions?.onAddress?.({ planVisits: true })}>
              <CalendarPlus size={14} aria-hidden /> {t('band.planVisits')}
            </Button>
            <Button size="sm" variant="primary" aria-keyshortcuts="j" heldReason={writeHeld} onClick={() => actions?.onAddress?.({ judge: '1' })}>
              <Stethoscope size={14} aria-hidden /> {t('band.judge')}
            </Button>
            <Menu
              label={<MoreHorizontal size={16} aria-hidden />}
              align="right"
              triggerProps={{ 'aria-label': t('band.more') }}
              items={[
                { id: 'print', label: t('band.print'), description: t('band.printHint'), href: printHref, target: '_blank' },
                { id: 'export', label: t('band.export'), description: t('band.exportHeld'), disabled: true },
                { id: 'keys', label: t('keys.title'), onSelect: () => setKeysOpen(true) },
              ]}
            />
          </span>
        )}
      </div>

      {heldSaid && (
        <Banner
          tone="info"
          title={heldSaid}
          action={
            <Button size="sm" variant="quiet" onClick={() => setHeldSaid(null)}>
              {t('common.close')}
            </Button>
          }
        />
      )}

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, { ...(model.notice.params ?? {}), count: model.notice.params?.count ?? 0 })}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.close')}
            </Button>
          }
        />
      )}

      <PrivacySection model={model} actions={actions} />

      {mode === 'full' ? (
        <>
          <TilesSection model={model} actions={actions} />
          <DueSection model={model} actions={actions} onHelp={() => setKeysOpen(true)} />
          <JudgementsSection model={model} actions={actions} onHelp={() => setKeysOpen(true)} />
        </>
      ) : (
        <Card padded>
          <p className="fw-hv-muted">{t('limited.body')}</p>
        </Card>
      )}
      {can.plansRead && <PlansSection model={model} actions={actions} />}

      {model.book && <BookDialog model={model} state={model.book} actions={actions} />}
      {model.judge && <JudgeDialog model={model} state={model.judge} actions={actions} />}
      {model.planVisits && <PlanVisitsDialog model={model} state={model.planVisits} actions={actions} />}
      {model.visit && <VisitWindow model={model} state={model.visit} actions={actions} />}
      {model.judgement && <JudgementWindow model={model} state={model.judgement} actions={actions} />}
      {model.plan && <PlanDialog model={model} state={model.plan} actions={actions} />}
      {model.shown.state === 'confirm' && <ShowConfirm model={model} ids={model.shown.ids} actions={actions} />}
      {keysOpen && <KeysModal onClose={() => setKeysOpen(false)} />}
    </div>
  )
}

/**
 * design sec:privacy — "Says who can see this and that views are recorded (QHS-256; GDPR art. 9)": one line + LawRef, the view log
 * of the lists for HR and the DPO; then, in words, that live use waits for the company doctor and what plans itself. The limited
 * page (the plans, the log) says the same from its own words: it reads no frame.
 */
function PrivacySection({ model, actions }: { model: HealthPageModel; actions?: HealthPageActions | undefined }) {
  const t = useWords()
  const ds = useDsWords()
  const locale = useLocale()
  const limited = pageMode(model.can) === 'limited'
  const frame = model.frame.status === 'ready' ? model.frame.value : null
  const viewLog = (frame ? frame.privacy.viewLog : model.can.views) && model.companyId
  const who = viewLog ? <WhoLooked of={{ companyId: model.companyId!, lists: true }} state={model.whoLooked} onOpen={actions?.onWhoLooked} label={t('who.lists')} /> : undefined
  return (
    <section className="fw-hv-section" aria-labelledby="fw-hv-privacy">
      <h2 id="fw-hv-privacy" className="fw-hv-vh">
        {t('privacy.title')}
      </h2>
      {limited ? (
        <PrivacyNote level="protected" variant="panel" recorded text={t('privacy.words')} whoMore={t('privacy.whoMore')} law={<ProtectedLaw />} action={who} labels={ds.privacyNote} />
      ) : model.frame.status === 'loading' ? (
        <div className="fw-hv-loading" aria-busy="true">
          <Skeleton height={40} />
          <span className="fw-hv-slow" role="status">
            {t('common.stillLoading')}
          </span>
        </div>
      ) : model.frame.status === 'error' ? (
        <SectionFailed title={t('privacy.failed')} problem={model.frame.problem} onRetry={actions?.onRetryFrame} />
      ) : (
        <>
          <PrivacyNote level="protected" variant="panel" recorded text={wordsIn(model.frame.value.privacy.words, locale)} whoMore={t('privacy.whoMore')} law={<ProtectedLaw law={model.frame.value.privacy.law} />} action={who} labels={ds.privacyNote} />
          <Banner tone="info" title={t('privacy.liveUseTitle')}>
            <span className="fw-hv-stack-sm">
              <span>{wordsIn(model.frame.value.liveUse, locale)}</span>
              <span className="fw-hv-muted">{wordsIn(model.frame.value.automatic, locale)}</span>
            </span>
          </Banner>
        </>
      )}
    </section>
  )
}

/** design sec:tiles — what is due (counts only: nothing recorded). A tile filters the due list; the unfit ending are judgements. */
function TilesSection({ model, actions }: { model: HealthPageModel; actions?: HealthPageActions | undefined }) {
  const t = useWords()
  const tiles = model.frame.status === 'ready' ? model.frame.value.tiles : null
  const metrics: Metric[] = TILES.map((id: TileId): Metric => {
    const value = tiles ? tiles[id] : null
    const filter = isFilterTile(id)
    return {
      label: t(`tile.${id}.label`),
      value: value === null ? model.frame.status === 'loading' ? <Skeleton width={40} height={24} /> : '—' : String(value),
      hint: t(`tile.${id}.hint`),
      ...((id === 'overdue' || id === 'returnVisits') && (value ?? 0) > 0 ? { accent: 'var(--nds-danger)' } : {}),
      ...((id === 'dueIn30' || id === 'beforeTask' || id === 'unfitEnding') && (value ?? 0) > 0 ? { accent: 'var(--nds-warning)' } : {}),
      ...(filter ? { onClick: () => actions?.onAddress?.(tileChange(id, model.address)), active: model.address.tile === id } : {}),
    }
  })
  return (
    <section className="fw-hv-section" aria-labelledby="fw-hv-tiles">
      <h2 id="fw-hv-tiles" className="fw-hv-vh">
        {t('tile.title')}
      </h2>
      <MetricStrip metrics={metrics} minTileWidth={180} />
      {model.frame.status === 'loading' && <span className="fw-hv-slow">{t('common.stillLoading')}</span>}
      {model.frame.status === 'error' && <p className="fw-hv-warn">{t('tile.failed')}</p>}
    </section>
  )
}
