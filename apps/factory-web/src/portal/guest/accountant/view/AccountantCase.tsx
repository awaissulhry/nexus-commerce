'use client'

import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { PortalShellView, type PortalShellViewModel } from '../../../shell/view/PortalShellView'
import { ThreadView, type ThreadViewModel } from '../../../shell/view/ThreadView'
import { NS } from '../model'
import type { PortalFrameMode } from '../../../shell/record/model' // B-TH-276
import { AccountantClosedView, AccountantView, type AccountantViewModel } from './AccountantView'

/**
 * SCR-268 as one case of the design review (B-W2b-201): the portal frame (B-W2b-173's PortalShellView, its band filled as the
 * live page fills it) around the accountant's room — or the page a person's role does not open — with made-up data. Ask
 * finance is the frame's ThreadView with made-up messages, docked (B-TH-276; the live page docks PortalThread there). The live
 * page (AccountantPage) composes the same views.
 */

export interface AccountantCaseModel {
  shell: PortalShellViewModel
  // B-TH-276: `frame` — the width the case draws (docked at 1440, the narrow page with its "Messages" button, its view open).
  page: { kind: 'page'; model: AccountantViewModel; thread: ThreadViewModel | null; frame?: { mode: PortalFrameMode; viewOpen?: boolean; newCount?: number } } | { kind: 'closed' }
}

/** A case is drawn in the page's language: its made-up words come in both. */
export type AccountantCaseBuilder = (locale: Locale) => AccountantCaseModel

export function AccountantCase({ model: build }: { model: AccountantCaseBuilder }) {
  const model = build(useLocale())
  return (
    <WithMessages namespaces={[NS, 'portal', 'shell', 'ds-words', 'lists']}>
      <PortalShellView model={model.shell}>
        {model.page.kind === 'page' ? (
          <AccountantView model={model.page.model} thread={model.page.thread ? <ThreadView model={model.page.thread} /> : null} frame={model.page.frame ?? { mode: 'docked' }} />
        ) : (
          <AccountantClosedView model={{ homeHref: model.shell.prefix }} />
        )}
      </PortalShellView>
    </WithMessages>
  )
}
