'use client'

import { Download, FileArchive } from 'lucide-react'
import { Banner, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Spinner } from '@nexus/ui/primitives'
import { JobProgress, Modal } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { askHeld, MY_STATE_PILL, myState, type MyDataModel } from '../model'
import '../my-data.css'

export interface MyDataActions {
  onOpen?: () => void
  onClose?: () => void
  onAsk?: () => void
  onDownload?: (requestId: string) => void
  onRetry?: () => void
}

/**
 * SCR-663 — My profile › Download my data (design shell.profile h.more "Download my data (W2b)"; PLT-202; GDPR arts. 15, 20):
 * the page head's button opens the dialog — what the copy holds (one ZIP: data.json, the files, a README with the checksums),
 * my requests with their state (being collected with the DS JobProgress, ready, handed over), Ask for my data (held with why:
 * one at a time, or no company picked), Download (the first download hands it over). The session proves who asks: no form.
 */
export function MyDataView({ model, actions }: { model: MyDataModel; actions?: MyDataActions }) {
  return (
    <WithMessages namespaces={['admin-privacy-depth']}>
      <MyDataButton model={model} actions={actions} />
    </WithMessages>
  )
}

function MyDataButton({ model, actions }: { model: MyDataModel; actions?: MyDataActions }) {
  const t = useT('admin-privacy-depth')
  return (
    <>
      <Button onClick={() => actions?.onOpen?.()}>
        <Download size={14} aria-hidden /> {t('dp.my.button')}
      </Button>
      {model.open && <MyDataDialog model={model} actions={actions} />}
    </>
  )
}

function MyDataDialog({ model, actions }: { model: MyDataModel; actions?: MyDataActions }) {
  const t = useT('admin-privacy-depth')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const data = model.read.value
  const held = askHeld(data)
  const footer = (
    <>
      <Button variant="secondary" onClick={() => actions?.onClose?.()}>
        {t('dp.common.close')}
      </Button>
      <Button variant="primary" onClick={() => actions?.onAsk?.()} heldReason={model.busy ? t('dp.common.working') : held ? t(held) : null}>
        {model.busy && <Spinner size={14} />}
        {t('dp.my.ask')}
      </Button>
    </>
  )
  return (
    <Modal open onClose={() => actions?.onClose?.()} title={t('dp.my.title')} size="lg" footer={footer}>
      <div className="fw-dpmy">
        <p className="fw-dpmy-intro">{t('dp.my.intro')}</p>
        <ul className="fw-dpmy-holds">
          <li>{t('dp.my.holds.data')}</li>
          <li>{t('dp.my.holds.files')}</li>
          <li>{t('dp.my.holds.readme')}</li>
        </ul>
        {model.done && <Banner tone="success" title={t(model.done)} />}
        {model.problem && <Banner tone="danger" title={t(model.problem)} />}
        {model.read.problem ? (
          <EmptyState
            title={t('dp.my.failed')}
            description={t(model.read.problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('dp.common.retry')}
              </Button>
            }
          />
        ) : !data ? (
          <p className="fw-dpmy-muted" role="status">
            <Spinner size={14} /> {t('dp.common.loading')}
          </p>
        ) : data.requests.length === 0 ? (
          <p className="fw-dpmy-muted">{t('dp.my.none')}</p>
        ) : (
          <SummaryTable
            label={t('dp.my.list')}
            stackOnPhone
            columns={[t('dp.my.col.asked'), t('dp.my.col.company'), t('dp.my.col.state'), t('dp.my.col.copy')]}
            align={['left', 'left', 'left', 'left']}
            widths={['20%', '24%', '20%', undefined]}
            rows={data.requests.map((request) => {
              const state = myState(request)
              return {
                id: request.id,
                cells: [
                  formatDate(request.receivedAt, place),
                  request.company.name,
                  <Pill key="s" tone={MY_STATE_PILL[state]}>
                    {t(`dp.my.state.${state}`)}
                  </Pill>,
                  state === 'collecting' || state === 'waiting' ? (
                    <JobProgress key="c" label={t('dp.my.collecting')} startedAt={request.collect?.at ? Date.parse(request.collect.at) : undefined} />
                  ) : request.package && state !== 'closed' ? (
                    <span key="c" className="fw-dpmy-copy">
                      <span className="fw-dpmy-muted">
                        <FileArchive size={14} aria-hidden /> {request.package.name}
                      </span>
                      <Button size="sm" variant={state === 'ready' ? 'primary' : 'secondary'} onClick={() => actions?.onDownload?.(request.id)} heldReason={model.downloading === request.id ? t('dp.common.working') : null}>
                        <Download size={14} aria-hidden /> {t('dp.my.download')}
                      </Button>
                    </span>
                  ) : (
                    <span key="c" className="fw-dpmy-muted">
                      {t(state === 'failed' ? 'dp.my.askAgain' : 'dp.my.noCopy')}
                    </span>
                  ),
                ],
              }
            })}
          />
        )}
        <p className="fw-dpmy-muted">{t('dp.my.handover')}</p>
      </div>
    </Modal>
  )
}
