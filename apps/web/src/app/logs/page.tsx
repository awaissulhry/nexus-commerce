import { redirect } from 'next/navigation'

// TECH_DEBT #3 — /logs was the original sync-logs page (Prisma in a
// server component, ran 500 on Vercel and was orphaned from the
// sidebar). The sidebar already treats /logs and /sync-logs as the
// same active state, so we 301 here. Keeps any external bookmark or
// inbound link working without re-introducing the broken page.
export default function LogsRedirect() {
  redirect('/sync-logs')
}
