import { redirect } from 'next/navigation'
import { cutRecordAddress } from '../../../../../../../areas/production/cutting/record/redirect'

/**
 * Production › Cutting › a cut — F-PR-06: the Cut record merged into the work order's Cutting & bundles tab (the same work order,
 * the same fact). Its address, with any old `?tab=lay|pieces|yield|tickets`, opens `/production/work-orders/<id>?tab=cutting`.
 */
export default async function ProductionCutPage({ params }: { params: Promise<{ company: string; id: string }> }) {
  const { company, id } = await params
  redirect(cutRecordAddress(company, id))
}
