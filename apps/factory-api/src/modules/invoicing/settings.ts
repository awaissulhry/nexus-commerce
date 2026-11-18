import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { sellerOf } from '@nexus/factory-domain/invoicing/document'
import { INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import type { NumberKind } from '@nexus/factory-domain/numbering/kinds'
import type { CommandCaller } from '../../core/command'
import { actorOf } from '../../core/context'
import { serverClock } from '../../core/time'
import { companyFacts } from './facts'
import { numberPreview } from './issue'
import { officeContextOf } from './store'

/**
 * Finance settings as invoicing reads them today (A2 SCR-083; FIN-084, FIN-092): per company the caller may see invoices
 * of, the seller data every invoice header takes (and what is missing to issue one, the issue check's own words), the
 * company's SDI connection (the integration account: its mode and state — FAKE until the intermediary is chosen, Q21),
 * the legal archive at the intermediary (how many sends are archived, the last one), and the number each fiscal series
 * gives next. Read only: the company's data is changed in Admin › Companies, the connection in Admin › Connections; the
 * VAT rules and their printed wording are the domain's (factory-domain tax/rules, tax/vat-treatment) until W2b's tax
 * settings. Finance holds invoices.view but neither companies.view nor integrations.view, so this read is theirs.
 */

const SERIES_KINDS = ['INVOICE', 'DEPOSIT_INVOICE', 'CREDIT_NOTE'] as const satisfies readonly NumberKind[]

export async function financeSettings(caller: CommandCaller) {
  const context = officeContextOf(caller)
  const today = businessDate(serverClock.now())
  return caller.withClient(async (client) => {
    const where = scopeWhere(actorOf(context), INVOICES_VIEW, { company: 'id' }) as Prisma.CompanyWhereInput
    const companies = await client.company.findMany({ where, select: { id: true, code: true, legalName: true }, orderBy: { code: 'asc' } })
    const views = []
    for (const company of companies) {
      const facts = await companyFacts(client, company.id)
      const seller = facts ? sellerOf(facts) : { seller: null, issues: [{ path: 'company', message: 'The company is not found.' }] }
      const accounts = await client.integrationAccount.findMany({ where: { provider: 'SDI', companyId: company.id, status: { not: 'DISABLED' } }, select: { id: true, label: true, mode: true, status: true }, orderBy: { id: 'asc' } })
      const archived = await client.sdiSubmission.aggregate({ where: { invoice: { companyId: company.id }, archivedAt: { not: null } }, _count: { _all: true }, _max: { archivedAt: true } })
      const series = []
      for (const kind of SERIES_KINDS) series.push({ kind, next: await numberPreview(client, company.id, kind, today) })
      views.push({
        id: company.id,
        code: company.code,
        legalName: company.legalName,
        identity: facts
          ? {
              vatNumber: facts.vatNumber,
              fiscalCode: facts.fiscalCode,
              regimeFiscale: facts.regimeFiscale,
              reaOffice: facts.reaOffice,
              reaNumber: facts.reaNumber,
              shareCapital: facts.shareCapital,
              soleShareholder: facts.soleShareholder,
              inLiquidation: facts.inLiquidation,
              address: facts.address ? { line1: facts.address.line1, line2: facts.address.line2 ?? null, postalCode: facts.address.postalCode, city: facts.address.city, province: facts.address.province ?? null, country: facts.address.country } : null,
            }
          : null,
        seller: { ready: seller.issues.length === 0, problems: seller.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
        sdi: {
          state: accounts.length === 0 ? ('NONE' as const) : accounts.length > 1 ? ('SEVERAL' as const) : accounts[0]!.status === 'PAUSED' ? ('PAUSED' as const) : ('ACTIVE' as const),
          accounts: accounts.map((account) => ({ id: account.id, label: account.label, mode: account.mode, status: account.status })),
        },
        archive: { archivedSends: archived._count._all, lastArchivedAt: archived._max.archivedAt ? archived._max.archivedAt.toISOString() : null },
        series,
      })
    }
    return { settings: { asOf: today, companies: views } }
  })
}
