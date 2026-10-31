import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canAs, GAMMA, inShell, ROWS, type Role } from '../demo/fixtures'
import { rowStatement } from '../model'
import { StatementPdfView, type StatementPdfModel } from './view/StatementPdfView'

/**
 * SCR-151-pdf — the statement PDF tab (design finance.receivables tab:statement-pdf "Statement (PDF)", a document to
 * print or send), made-up data only: one statement, two statements ("Print 2 statements"), one still being made, one
 * that failed, no price grain, nothing named.
 */

/** A one-page PDF that says it is made-up (built here so the design index needs no API). */
function demoPdf(title: string): Uint8Array {
  const text = `BT /F1 20 Tf 72 770 Td (${title}) Tj 0 -28 Td /F1 11 Tf (Made-up design data: Officina Demo S.r.l.) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(body)
}

const GAMMA_PDF = demoPdf('Statement - Gamma Demo S.n.c.')
const MOTO_PDF = demoPdf('Statement - Moto Demo S.r.l.')

interface Case {
  role: Role
  page: StatementPdfModel
}

const gamma = {
  ref: rowStatement(ROWS[0]!),
  name: GAMMA.name,
  pdf: GAMMA_PDF,
  problem: null,
}
const moto = {
  ref: rowStatement(ROWS[1]!),
  name: ROWS[1]!.customer.name,
  pdf: MOTO_PDF,
  problem: null,
}
const base = (role: Role, over: Partial<StatementPdfModel> = {}): Case => ({
  role,
  page: { can: canAs(role), from: null, to: null, entries: [gamma], ...over },
})

function StatementPdfDesign({ model }: { model: Case }) {
  return inShell('/finance/receivables/statement', createElement(StatementPdfView, { model: model.page }), model.role)
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-151-pdf',
  title: 'Statement (PDF): a document to print or send',
  view: StatementPdfDesign,
  cases: [
    {
      id: 'one',
      label: "Finance · Gamma Demo's statement, 1 January → today",
      model: base('finance'),
    },
    {
      id: 'two',
      label: 'Print 2 statements · as of 30 September',
      model: base('finance', { entries: [gamma, moto], to: '2026-09-30' }),
    },
    {
      id: 'reading',
      label: 'One statement still being made: Print held',
      model: base('finance', { entries: [gamma, { ...moto, pdf: null }] }),
    },
    {
      id: 'failed',
      label: "One statement couldn't be made: Try again",
      model: base('finance', {
        entries: [gamma, { ...moto, pdf: null, problem: 'problem.unavailable' }],
      }),
    },
    {
      id: 'no-price',
      label: 'Read-only · no price grain: the statement is not made',
      model: base('readOnly'),
    },
    {
      id: 'none',
      label: 'Nothing named in the address',
      model: base('finance', { entries: [] }),
    },
    {
      id: 'no-permission',
      label: 'Warehouse · no receivables.view',
      model: base('warehouse'),
    },
  ],
})
