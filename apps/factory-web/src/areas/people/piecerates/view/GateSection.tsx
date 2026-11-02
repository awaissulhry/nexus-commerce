'use client'

import { Banner, KeyValue } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { LegalGate, type LegalGateItem } from '@nexus/ui/components/LegalGate/index'
import { Button } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { dayText, preconditionHref, preconditionWords, startDayFloor } from '../model'
import type { PieceActions, PieceModel } from '../view-model'
import { ReadBlock, said, Section, usePieceWords } from './parts'

const built = (path: string): boolean => OFFICE_PAGES.has(path)

/**
 * Legal switch (design people.piecerates sec:gate; GATE-PIECE-PAY): each precondition with its state, its law and where it is
 * kept. "Start piece pay at <site>" is held with the missing items in words, never greyed; once on, the gate folds to one
 * line. Nexus records what piece pay rests on: it does not judge it: the CCNL, the notice of rates and the labour
 * consultant's yes are the employer's, and the page says so.
 */
export function GateSection({ model, actions }: { model: PieceModel; actions?: PieceActions | undefined }) {
  const t = usePieceWords()
  const locale = useLocale()
  const ds = useDsWords()
  if (!model.gate) return null
  return (
    <Section id="gate" title={t('gate.title')} hint={t('gate.hint')}>
      <ReadBlock read={model.gate} onRetry={actions?.onRetry} rows={5}>
        {(view) => {
          const site = view.site.name
          const items: LegalGateItem[] = view.preconditions.map((item) => {
            const href = preconditionHref(item.code, model.prefix, built)
            return {
              id: item.code,
              label: t(`gate.${item.code}.label`),
              state: item.met ? 'met' : 'missing',
              law: { law: t(`gate.${item.code}.law`), plain: t(`gate.${item.code}.plain`) },
              detail: said(t, preconditionWords(item, view, locale)),
              recordedBy: t(`gate.${item.code}.kept`),
              ...(href ? { href, linkLabel: t(item.met ? 'gate.see' : 'gate.record') } : {}),
            }
          })
          const held = view.state === 'OFF' && !view.canSwitch ? t('gate.heldRight', { permission: 'people.piecerates.switch' }) : null
          return (
            <>
              <LegalGate
                title={t(view.state === 'ON' ? 'gate.titleOn' : 'gate.titleOff', { site })}
                items={items}
                on={view.state === 'ON'}
                onSince={dayText(view.onFrom, locale) ?? ''}
                {...(view.canSwitch ? { action: { label: t('gate.start', { site, day: dayText(startDayFloor(view), locale) ?? '' }), onClick: () => actions?.onStart() } } : {})}
                labels={{ ...ds.legalGate, recordedBy: (who: string) => who }}
                lawLabels={ds.lawRef}
              >
                <div className="fw-pr8-row">
                  {view.canManage && (
                    <Button size="sm" variant="secondary" onClick={() => actions?.onPreconditions()}>
                      {t(view.state === 'ON' ? 'gate.note' : 'gate.recordAll')}
                    </Button>
                  )}
                  {view.state === 'ON' && view.canSwitch && (
                    <Button size="sm" variant="quiet" onClick={() => actions?.onStop()}>
                      {t('gate.stop')}
                    </Button>
                  )}
                  {held && <span className="fw-pr8-hint">{held}</span>}
                </div>
              </LegalGate>
              {view.state === 'OFF' && view.offFrom && <Banner tone="info" title={t('gate.stoppedTitle', { day: dayText(view.offFrom, locale) ?? '' })}>{t('gate.stoppedBody')}</Banner>}
              {view.noticeReadBy && view.recorded.workerNotice && view.state === 'OFF' && <p className="fw-pr8-hint">{t('gate.noticeRead', { read: view.noticeReadBy.read, of: view.noticeReadBy.of })}</p>}
              {view.state === 'OFF' && (
                <KeyValue
                  dense
                  items={[
                    { label: t('gate.honest'), value: t('gate.honestBody') },
                    { label: t('gate.law'), value: <LawRef law={t('gate.lawName')} plain={t('gate.lawPlain')} labels={ds.lawRef} /> },
                  ]}
                />
              )}
            </>
          )
        }}
      </ReadBlock>
    </Section>
  )
}
