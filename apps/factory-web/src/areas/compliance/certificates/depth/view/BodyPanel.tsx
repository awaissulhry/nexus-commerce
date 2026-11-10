'use client'

import Link from 'next/link'
import { BookOpen } from 'lucide-react'
import { Banner, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Spinner, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { dash, Section } from '../../../../quality/_shared/parts'
import type { CertCan } from '../../model'
import { StatusPill, useDay } from '../../view/parts'
import type { Depth } from '../api'
import { nandoHref, writeHeld, type DepthModel } from '../model'
import type { DepthActions } from '../use-depth'
import { DepthMessages, NandoLink, PpeLaw, ScopeLine, useDepthT } from './parts'

const recordHref = (prefix: string, certificateId: string) => `${prefix}/compliance/certificates/${encodeURIComponent(certificateId)}`

/**
 * The certificate's Notified body tab (design compliance.certificates rec Certificate › nb › nb-main, W1 + the W2b parts;
 * PRD-286): who issued it and whether they may — the directory's body (name, 4-digit number, postal address, country,
 * contact), the scope check ("Listed for protective motorcycle clothing ✓", a warning when not), its NANDO entry in a new
 * tab (the Commission's site, outside), Pick from the directory (a draft: any active body, its number fills in; a
 * registered certificate: once, only the body its number names), Notified bodies… (the directory pop-up), and the other
 * certificates from this body. Without a directory body the typed name and number stay, with the reason to pick one.
 */
export function BodyPanel(props: { model: DepthModel; can: CertCan; prefix: string; actions?: DepthActions; onDirectory?: () => void }) {
  return (
    <DepthMessages>
      <Panel {...props} />
    </DepthMessages>
  )
}

function Panel({ model, can, prefix, actions, onDirectory }: { model: DepthModel; can: CertCan; prefix: string; actions?: DepthActions; onDirectory?: () => void }) {
  const d = useDepthT()
  const q = useT('quality')
  if (model.depth.problem)
    return (
      <Section title={d('body.title')}>
        <Banner tone="danger" title={d('depth.failed')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{q('common.retry')}</Button>}>
          <p className="fw-q-hint">{q(model.depth.problem)}</p>
        </Banner>
      </Section>
    )
  if (!model.depth.value)
    return (
      <Section title={d('body.title')}>
        <p className="fw-q-loading">
          <Spinner size={12} /> {q('common.loading')}
        </p>
      </Section>
    )
  return <Ready depth={model.depth.value} can={can} prefix={prefix} actions={actions} onDirectory={onDirectory} />
}

function Ready({ depth, can, prefix, actions, onDirectory }: { depth: Depth; can: CertCan; prefix: string; actions?: DepthActions; onDirectory?: () => void }) {
  const d = useDepthT()
  const t = useT('certificates')
  const day = useDay()
  const body = depth.body.directory
  const pickHeldKey = writeHeld(depth, can, 'body')
  const clearHeld = !can.manage || !depth.mayManage ? d('held.manage') : depth.certificate.registered ? d('held.filledOnce') : null
  const actionsBar = (
    <span className="fw-cd-row">
      <Button size="sm" variant={body ? 'secondary' : 'primary'} heldReason={pickHeldKey ? d(pickHeldKey) : null} onClick={() => actions?.onDialog?.({ kind: 'pickBody' })}>
        {d(body ? 'body.change' : 'body.pick')}
      </Button>
      {body && !depth.certificate.registered && (
        <Button size="sm" variant="quiet" heldReason={clearHeld} onClick={() => actions?.onClearBody?.()}>
          {d('body.clear')}
        </Button>
      )}
      <Button size="sm" variant="quiet" onClick={() => onDirectory?.()}>
        <BookOpen size={14} aria-hidden /> {d('bodies.open')}
      </Button>
    </span>
  )
  return (
    <div className="fw-q-two">
      <Section title={d('body.title')} sub={d('body.intro')} actions={actionsBar}>
        {body ? (
          <div className="fw-cd-stack">
            <KeyValue
              labelCase="sentence"
              items={[
                { label: d('body.name'), value: body.name },
                { label: d('body.number'), value: <span className="fw-q-num">{body.number}</span>, hint: d('body.numberHint') },
                { label: d('body.address'), value: <span className="fw-cd-address">{body.address}</span>, hint: body.country },
                { label: d('body.contact'), value: dash([body.contactEmail, body.contactPhone].filter(Boolean).join(' · ')) },
                { label: d('body.scopes'), value: body.scopes.length > 0 ? <ul className="fw-cd-lines">{body.scopes.map((scope) => <li key={scope}>{scope}</li>)}</ul> : '—' },
              ]}
            />
            {depth.body.scope && <ScopeLine check={depth.body.scope} />}
            {depth.body.scope?.state !== 'LISTED' && <p className="fw-q-hint">{d('scope.lookAgain')}</p>}
            <span className="fw-cd-row">
              <NandoLink href={nandoHref(body)} number={body.number} />
              <PpeLaw point="Annex II 1.4(j)" plainKey="law.annexII" />
            </span>
          </div>
        ) : (
          <div className="fw-cd-stack">
            <KeyValue
              labelCase="sentence"
              items={[
                { label: d('body.name'), value: depth.body.typed.name, hint: d('body.typed') },
                { label: d('body.number'), value: <span className="fw-q-num">{depth.body.typed.number}</span>, hint: d('body.numberHint') },
              ]}
            />
            <Banner tone={depth.body.matching.length > 0 ? 'info' : 'warning'} title={d(depth.body.matching.length > 0 ? 'body.notPicked' : 'body.notInDirectory', { number: depth.body.typed.number })}>
              <p className="fw-q-hint">{d(depth.body.matching.length > 0 ? 'body.notPickedHint' : 'body.notInDirectoryHint')}</p>
            </Banner>
            <span className="fw-cd-row">
              <Tag tone="neutral">{t('law.annexV')}</Tag>
              <PpeLaw point="Annex II 1.4(j)" plainKey="law.annexII" />
            </span>
          </div>
        )}
      </Section>
      <Section title={d('body.others')}>
        {depth.body.others.length === 0 ? (
          <p className="fw-q-hint">{d('body.noOthers')}</p>
        ) : (
          <SummaryTable
            label={d('body.others')}
            stackOnPhone
            columns={[t('csv.number'), t('csv.standard'), t('list.col.valid'), t('list.col.status')]}
            rows={depth.body.others.map((other) => ({
              id: other.id,
              cells: [
                <Link key="n" className="fw-q-link fw-q-code" href={recordHref(prefix, other.id)}>
                  {other.number}
                </Link>,
                other.standard,
                t('list.validRange', { from: day(other.validFrom), to: day(other.validTo) }),
                <StatusPill key="s" status={other.status} />,
              ],
            }))}
          />
        )}
      </Section>
    </div>
  )
}
