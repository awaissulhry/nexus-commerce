import { notFound } from 'next/navigation'
import { ResponsiveFrames } from './frames'
export default function Page() {
  if (process.env.NODE_ENV !== 'development' || process.env.FORMULA_BROWSER_FIXTURE !== '1') notFound()
  return <ResponsiveFrames />
}
