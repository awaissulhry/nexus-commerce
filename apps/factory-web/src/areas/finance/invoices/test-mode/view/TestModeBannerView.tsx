'use client'

import { FlaskConical } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { DEPTH, DEPTH_NAMESPACES } from '../depth'
import { answerWords, type TestModeBannerModel } from '../model'

/**
 * The test-mode banner (design finance.invoices page.h "test mode banner 'E-invoice test mode — nothing goes to SDI' when
 * on"; Owner rule W2b-6: a test mode shows a banner on every page while it is on): on every invoice page — the list, the
 * record, Payables' self-invoices, Finance settings — while a company the page shows is in test mode. Who answers its sends
 * on the line below (simulated here with the answer chosen, the FAKE intermediary, or no connection yet); each company
 * named when the person sees several. Nothing is drawn while every company is live.
 */
export function TestModeBannerView({ model }: { model: TestModeBannerModel }) {
  if (model.testing.length === 0) return null
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <TestBanner model={model} />
    </WithMessages>
  )
}

function TestBanner({ model }: { model: TestModeBannerModel }) {
  const w = useT(DEPTH)
  return (
    <Banner tone="warning" icon={<FlaskConical size={16} aria-hidden />} title={w('testMode.banner')}>
      {model.testing.map((company) => {
        const words = answerWords(company)
        return <p key={company.companyId}>{model.named ? w('testMode.companyLine', { company: company.legalName, words: w(words.key, words.params) }) : w(words.key, words.params)}</p>
      })}
    </Banner>
  )
}
