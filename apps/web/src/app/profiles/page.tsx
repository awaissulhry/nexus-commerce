import { Suspense } from 'react'
import ProfilesClient from './ProfilesClient'
export const dynamic = 'force-dynamic'
export default function ProfilesPage() { return <div className="business-profiles-surface"><Suspense><ProfilesClient /></Suspense></div> }
