import { ImpactReview } from '../../_shared/ImpactReview'
import { PageHeader } from '@/design-system/patterns'

export default async function MappingImpactPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <>
    <PageHeader title="Review mapping impact" />
    <div style={{ padding: 'var(--nds-space-16)' }}><ImpactReview jobId={id} /></div>
  </>
}
