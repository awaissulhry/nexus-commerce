/**
 * Settings › AI › Claude (MCP full control C9): how far Claude may go in this business without a person, its brakes,
 * and what it did. Thin server shell; the client component loads everything for the business in the URL.
 */
import ClaudeClient from './ClaudeClient'

export const dynamic = 'force-dynamic'

export default function ClaudeSettingsPage() {
  return <ClaudeClient />
}
