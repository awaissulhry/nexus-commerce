import { notFound } from 'next/navigation'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'
import '@/design-system/styles/a11y.css'
import { FormulaWorkflowFixture } from './workflow'

/** Opt-in local verification surface; never available in the normal app or production. */
export default function Page() {
  if (process.env.NODE_ENV !== 'development' || process.env.FORMULA_BROWSER_FIXTURE !== '1' || process.env.NEXT_PUBLIC_API_URL !== 'http://localhost:4115') notFound()
  return <FormulaWorkflowFixture />
}
