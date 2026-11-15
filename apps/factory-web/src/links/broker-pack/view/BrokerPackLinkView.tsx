'use client'

import { Download, FileText, Send } from 'lucide-react'
import { Banner, Card, Field, FileRow, KeyValue } from '@nexus/ui/components'
import { EndState } from '@nexus/ui/components/EndState/index'
import { Button, Input, Pill, Skeleton, Spinner } from '@nexus/ui/primitives'
import { formatDate } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { LinkFrameView } from '../../../shell/links/view/LinkFrameView'
import type { BrokerPackPage } from '../api'
import { downloadHeldKey, filedOf, mrnProblemKey, sendHeldKey, type BrokerPackLinkActions, type BrokerPackLinkModel } from '../model'
import '../broker-pack-link.css'

export type { BrokerPackLinkActions, BrokerPackLinkModel } from '../model'

/**
 * SCR-580 — Export declaration papers (B-W2b-409; LOG-097 "one click sends the broker the invoice, packing list, origin papers
 * and DoC as a link and collects the MRN back"; a BROKER_PACK link of one export declaration): the link frame around ONE task
 * on one phone screen — the shipment and where it goes, the papers to download one by one, then the MRN typed back once the
 * declaration is filed (its pattern checked while typing; sent once). A filed declaration shows its MRN and thanks the broker.
 * Every held button says why. No price on the page (the values are in the papers the sender chose to send).
 */
export function BrokerPackLinkView({ model, actions }: { model: BrokerPackLinkModel; actions?: BrokerPackLinkActions }) {
  return (
    <WithMessages namespaces={['broker-pack', 'ds-words']}>
      <Page model={model} actions={actions} />
    </WithMessages>
  )
}

function Page({ model, actions }: { model: BrokerPackLinkModel; actions?: BrokerPackLinkActions | undefined }) {
  const t = useT('broker-pack')
  const page = model.page
  const valid = model.link === 'valid'
  return (
    <LinkFrameView
      model={{
        sender: page ? { name: page.companyName } : null,
        title: page ? t('title', { number: page.shipment.number }) : null,
        body: valid ? { kind: 'task' } : { kind: 'link', state: model.link, purpose: 'BROKER_PACK', expiresAt: null, usesLeft: null },
      }}
    >
      {valid ? (
        page ? (
          <Body page={page} model={model} actions={actions} />
        ) : model.problem ? (
          <Card padded>
            <Banner tone="danger" title={t(model.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('retry')}</Button>} />
          </Card>
        ) : (
          <div className="fw-bpl" aria-busy="true">
            <Skeleton height={28} width="60%" />
            <Skeleton height={120} />
            <p className="fw-bpl-hint" role="status">
              {t('loading')}
            </p>
          </div>
        )
      ) : null}
    </LinkFrameView>
  )
}

function Body({ page, model, actions }: { page: BrokerPackPage; model: BrokerPackLinkModel; actions?: BrokerPackLinkActions | undefined }) {
  const t = useT('broker-pack')
  const locale = useLocale()
  const filed = filedOf(page)
  const sendHeld = sendHeldKey(model)
  const typed = mrnProblemKey(model.mrn)
  return (
    <div className="fw-bpl">
      {model.offline && <Banner tone="warning" title={t('offline')} />}
      {model.problem && <Banner tone="danger" title={t(model.problem)} />}
      {filed && <EndState tone="success" focusOnMount={false} title={t('filed.title')} body={t('filed.body', { mrn: page.declaration.mrn ?? '' })} />}
      <Card padded>
        <div className="fw-bpl-stack">
          <h2 className="fw-bpl-h2">
            <FileText size={16} aria-hidden /> {t('papers')}
          </h2>
          <KeyValue
            columns={2}
            items={[
              { label: t('shipment'), value: page.shipment.number },
              { label: t('destination'), value: page.shipment.country ?? '—' },
              { label: t('state'), value: <Pill tone={filed ? 'success' : 'info'}>{t(`status.${page.declaration.status}`)}</Pill> },
              { label: t('until'), value: formatDate(page.link.expiresAt, { locale }) },
            ]}
          />
          <p className="fw-bpl-hint">{t('papersHint')}</p>
          {page.papers.length === 0 ? (
            <p className="fw-bpl-hint">{t('noPapers')}</p>
          ) : (
            <div className="fw-bpl-files">
              {page.papers.map((paper) => {
                const held = downloadHeldKey(model, paper)
                const busy = typeof model.busy === 'object' && model.busy !== null && model.busy.download === paper.fileId
                return (
                  <FileRow
                    key={paper.fileId}
                    name={paper.name}
                    size={paper.sizeBytes}
                    status={paper.available ? null : t('held.gone')}
                    actions={
                      <Button size="sm" heldReason={held ? t(held) : null} aria-label={t('downloadOne', { name: paper.name })} onClick={() => actions?.onDownload?.(paper.fileId)}>
                        {busy ? <Spinner size={12} /> : <Download size={14} aria-hidden />} {t('download')}
                      </Button>
                    }
                  />
                )
              })}
            </div>
          )}
        </div>
      </Card>
      {!filed && (
        <Card padded>
          <div className="fw-bpl-stack">
            <h2 className="fw-bpl-h2">
              <Send size={16} aria-hidden /> {t('mrn.title')}
            </h2>
            <p className="fw-bpl-hint">{t('mrn.hint')}</p>
            <Field label={t('mrn.label')} hint={t('mrn.format')} error={typed ? t(typed) : undefined}>
              <Input value={model.mrn} autoComplete="off" spellCheck={false} maxLength={40} inputMode="text" onChange={(event) => actions?.onMrn?.(event.target.value)} />
            </Field>
            <div className="fw-bpl-actions">
              <Button variant="primary" heldReason={sendHeld ? t(sendHeld) : null} onClick={() => actions?.onSend?.()}>
                {model.busy === 'mrn' ? <Spinner size={12} /> : <Send size={14} aria-hidden />} {t('mrn.send')}
              </Button>
            </div>
          </div>
        </Card>
      )}
      {filed && (
        <Card padded>
          <KeyValue columns={1} items={[{ label: t('mrn.label'), value: <span className="fw-bpl-code">{page.declaration.mrn}</span> }]} />
        </Card>
      )}
    </div>
  )
}
