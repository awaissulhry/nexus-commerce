import type { Metadata } from 'next'
import { StatementPdf } from '../../../../../../../../areas/people/piecerates/statement/StatementPdf'

export const metadata: Metadata = { title: 'Worker statement · Nexus Factory' }

/** People › Piece rates › Worker statement (a new tab: the PDF the API makes; each opening is recorded). */
export default async function PeopleStatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <StatementPdf statementId={id} />
}
