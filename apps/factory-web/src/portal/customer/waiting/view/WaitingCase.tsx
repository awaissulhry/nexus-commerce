'use client'

import { useMemo, useState } from 'react'
import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { PortalShellView, type PortalShellViewModel } from '../../../shell/view/PortalShellView'
import type { ApproveDialogModel } from '../../home/view/ApproveDialog'
import { NS } from '../model'
import { WaitingView, type WaitingViewModel } from './WaitingView'

/**
 * F-PR-16 (the browser walk) — Home › Waiting for you as one case of the design review: the portal frame (its band as the live page
 * fills it) around the page, with made-up data. The live page (WaitingPage) composes the same view. Review on a row opens the answer
 * dialog here and Esc or Cancel closes it again, so the review walks Tab order, Esc and the focus going back to the row. Nothing is
 * sent from here.
 */
export interface WaitingCaseModel {
  shell: PortalShellViewModel
  page: WaitingViewModel
  /** What Review opens here. */
  opens?: { readonly dialog?: ApproveDialogModel }
}

/** A case is drawn in the page's language: its made-up words come in both. */
export type WaitingCaseBuilder = (locale: Locale) => WaitingCaseModel

export function WaitingCase({ model: build }: { model: WaitingCaseBuilder }) {
  const locale = useLocale()
  const built = useMemo(() => build(locale), [build, locale])
  return (
    <WithMessages namespaces={[NS, 'portal-customer-home', 'portal', 'shell', 'ds-words']}>
      <CaseState key={locale} built={built} />
    </WithMessages>
  )
}

function CaseState({ built }: { built: WaitingCaseModel }) {
  const [dialog, setDialog] = useState<ApproveDialogModel | null | undefined>(undefined)
  const shown = dialog === undefined ? built.page.dialog : dialog
  const opens = built.opens ?? {}
  return (
    <PortalShellView model={built.shell}>
      <WaitingView
        model={{ ...built.page, dialog: shown }}
        actions={{
          ...(opens.dialog ? { onOpen: () => setDialog(opens.dialog ?? null) } : {}),
          dialog: { onClose: () => setDialog(null) },
        }}
      />
    </PortalShellView>
  )
}
