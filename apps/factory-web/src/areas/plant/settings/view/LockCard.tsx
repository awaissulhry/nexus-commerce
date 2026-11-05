'use client'

import { Banner, Card, EmptyState, Field } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { RadioCard, Toggle } from '@nexus/ui/primitives'
import { H1_SETTINGS } from '@nexus/factory-domain/plant/requests/lock'
import { EditModeBar, useDsWords } from '../../../../lib/i18n/ds-parts'
import { LOCK_BY, SIGN_SAFE_BY } from '../depth-api'
import { lockChangeCount, lockDraftOf, lockHeld, lockLoosens } from '../depth-model'
import type { DepthActions, DepthModel } from '../depth-view-model'
import { CardHead, say, SectionState, useSettingsWords } from './parts'

/** The law the lock rests on (design plant.settings sec:lock LawRef). Its name only: the plain words are the catalogue's. */
export const LOCK_LAW = 'D.Lgs. 81/2008 art. 71'

/**
 * Unsafe lock (design plant.settings sec:lock, QHS-183, Owner answer H1): who may lock a machine as unsafe and who signs it
 * safe again, as radio cards, and whether a lock asks for a hazard report in Plant › Incidents — one card of the site,
 * saved with the EditModeBar (⌘S). H1 holds: the other choices are drawn so the reader sees what the design offers, and
 * choosing one holds Apply with the reason (the API answers the same: 409 refusal/H1_HELD). Switching the hazard report off
 * loosens a safety rule: Apply asks the office's fresh code (DS StepUpModal) at the moment of the save, never before.
 */
export function LockCard({ depth, actions }: { depth: DepthModel; actions?: DepthActions }) {
  const t = useSettingsWords()
  const ds = useDsWords()
  const { read, draft, busy, problem } = depth.lock
  return (
    <Card padded>
      <section className="fw-pls-stack" aria-labelledby="fw-pls-lock" data-pls-section="lock">
        <CardHead
          id="fw-pls-lock"
          title={t('lock.title')}
          purpose={t('lock.purpose')}
          side={
            <span className="fw-pls-cardside-row">
              {depth.site && <span className="fw-pls-hint">{t('routing.forSite', { site: depth.site.name })}</span>}
              <LawRef law={LOCK_LAW} plain={t('lock.lawPlain')} labels={ds.lawRef} />
            </span>
          }
        />
        {!depth.site ? (
          <EmptyState title={t('section.noSite')} description={t('section.noSiteBody')} />
        ) : (
          <SectionState read={read} title={t('lock.title')} onRetry={() => actions?.onLockRetry?.()}>
            {(value) => {
              const asRead = lockDraftOf(value)
              const shown = draft ?? asRead
              const manage = value.canManage
              const changes = lockChangeCount(asRead, shown)
              const held = lockHeld(shown, busy)
              const loosening = lockLoosens(asRead, shown)
              const set = (patch: Partial<typeof shown>) => actions?.onLockDraft?.(patch)
              return (
                <>
                  {value.version === null && <p className="fw-pls-hint">{t('lock.defaults')}</p>}
                  {!manage && <p className="fw-pls-hint">{t('lock.readOnly')}</p>}
                  {problem && <Banner tone="danger" title={say(t, problem) ?? ''} />}
                  <fieldset className="fw-pls-fieldset" disabled={!manage}>
                    <legend>{t('lock.lockBy')}</legend>
                    <div className="fw-pls-radios">
                      {LOCK_BY.map((choice) => (
                        <RadioCard
                          key={choice}
                          name="fw-pls-lock-by"
                          value={choice}
                          checked={shown.lockBy === choice}
                          selected={shown.lockBy === choice}
                          disabled={!manage}
                          onChange={() => set({ lockBy: choice })}
                          title={t(`lock.by.${choice}`)}
                          description={t(choice === H1_SETTINGS.lockBy ? `lock.by.${choice}Hint` : 'lock.heldByH1')}
                        />
                      ))}
                    </div>
                  </fieldset>
                  <fieldset className="fw-pls-fieldset" disabled={!manage}>
                    <legend>{t('lock.signSafeBy')}</legend>
                    <div className="fw-pls-radios">
                      {SIGN_SAFE_BY.map((choice) => (
                        <RadioCard
                          key={choice}
                          name="fw-pls-sign-safe"
                          value={choice}
                          checked={shown.signSafeBy === choice}
                          selected={shown.signSafeBy === choice}
                          disabled={!manage}
                          onChange={() => set({ signSafeBy: choice })}
                          title={t(`lock.sign.${choice}`)}
                          description={t(choice === H1_SETTINGS.signSafeBy ? `lock.sign.${choice}Hint` : 'lock.heldByH1')}
                        />
                      ))}
                    </div>
                  </fieldset>
                  {(held === 'held.h1Lock' || held === 'held.h1SignSafe') && <Banner tone="info" title={t('lock.h1Title')}>{t('lock.h1Body')}</Banner>}
                  <Field label={t('lock.hazard')} hint={t('lock.hazardHint')}>
                    <Toggle checked={shown.hazardReportOnLock} disabled={!manage} aria-label={t('lock.hazard')} onChange={(next) => set({ hazardReportOnLock: next })} />
                  </Field>
                  {loosening && <Banner tone="warning" title={t('lock.looserTitle')}>{t('lock.looserBody')}</Banner>}
                  {changes > 0 && (
                    <EditModeBar
                      message={t('lock.unsaved', { count: changes })}
                      count={changes}
                      busy={busy}
                      applyHeldReason={held ? t(held) : null}
                      applyLabel={t(loosening ? 'lock.applyWithCode' : 'lock.apply')}
                      saveShortcut
                      onDiscard={() => actions?.onLockDiscard?.()}
                      onApply={() => actions?.onLockSave?.()}
                    />
                  )}
                </>
              )
            }}
          </SectionState>
        )}
      </section>
    </Card>
  )
}
