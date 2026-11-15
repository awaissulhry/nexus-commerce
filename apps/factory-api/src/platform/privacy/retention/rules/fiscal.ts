import type { Prisma } from '@nexus/factory-db'
import { holdAll, type RetentionType } from './type'

/**
 * Fiscal records a retention rule may name (B-W2b-405; PLT-204; c.c. art. 2220; DPR 633/72 art. 39): kept ten years and then
 * archived where they are. Nothing is erased: an applying sweep counts them as held (ARCHIVE_STAYS); the fiscal archive keeps the
 * document and its file.
 */
const invoices: RetentionType = {
  recordType: 'Invoice',
  companyScoped: true,
  actions: ['ARCHIVE'],
  countsFrom: 'the issue date (a draft is never due)',
  does: { ARCHIVE: 'Archives the issued invoice where it is: nothing is erased (the fiscal archive keeps the document and its file).' },
  holdsAll: 'ARCHIVE_STAYS',
  async due(db, scope, cut, _now, take) {
    const where: Prisma.InvoiceWhereInput = {
      AND: [scope.companyId !== null ? { companyId: scope.companyId } : scope.exceptCompanies.length > 0 ? { companyId: { notIn: [...scope.exceptCompanies] } } : {}, { status: { not: 'DRAFT' } }, { issueDate: { lt: cut.day } }],
    }
    const [total, rows] = await Promise.all([db.invoice.count({ where }), db.invoice.findMany({ where, select: { id: true }, orderBy: [{ issueDate: 'asc' }, { id: 'asc' }], take })])
    return { total, ids: rows.map((row) => row.id) }
  },
  apply: holdAll('ARCHIVE_STAYS'),
}

export const FISCAL_TYPES: readonly RetentionType[] = [invoices]
