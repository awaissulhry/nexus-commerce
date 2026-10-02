/**
 * MCP full control C9 — the calls Settings › AI › Claude makes (apps/api/src/routes/claude-control.routes.ts).
 *
 * The installed fetch (lib/auth/install-fetch.ts) adds the business from the page URL, the session and the CSRF
 * token, so these calls carry nothing of their own. A refusal carries the API's own sentence and code: the page shows
 * it as it is (a raise without the 2FA code, a permission this person lacks, a change that moved).
 */
import { getBackendUrl } from '@/lib/backend-url'
import { commandConflictMessage, commandKeyFor, sendCommand } from '@/lib/command-key'
import type { ActivityRow, Autonomy, ClaudeRule, ClaudeRules, ClaudeTrust, Outcome } from './claudeWords'

export class ClaudeApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
  }
}

async function call<T>(path: string, init?: { method: 'POST' | 'PUT'; body: unknown }): Promise<T> {
  const response = await fetch(`${getBackendUrl()}/api/claude/${path}`, init
    ? { method: init.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }
    : { cache: 'no-store' })
  const data = (await response.json().catch(() => ({}))) as { error?: string; code?: string }
  if (!response.ok) throw new ClaudeApiError(data.error ?? 'That could not be completed. Try again.', response.status, data.code)
  return data as T
}

/**
 * Pause, Resume and Undo are keyed commands (apps/api/src/lib/command-idempotency.ts): one press, one run. The key of a
 * press whose answer was lost is kept, so pressing again replays the stored answer instead of running it twice.
 */
async function command<T>(slot: string, url: string, body: unknown, what: string): Promise<T> {
  const sent = await sendCommand<{ error?: string; code?: string }>(commandKeyFor(slot), url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (sent.conflict) throw new ClaudeApiError(commandConflictMessage(sent.conflict, what), sent.response.status)
  const data = sent.body ?? {}
  if (!sent.response.ok) throw new ClaudeApiError(data.error ?? 'That could not be completed. Try again.', sent.response.status, data.code)
  return data as T
}

export const claudeApi = {
  rules: () => call<ClaudeRules>('trust'),
  /** level and/or limits; raising either needs `code` (a fresh 2FA code) and settings.security.manage. */
  setRule: (tool: string, patch: { level?: ClaudeTrust; limits?: Record<string, number> | null; code?: string }) =>
    call<{ ok: true; rule: Pick<ClaudeRule, 'level' | 'stored' | 'limits'> }>(`trust/${encodeURIComponent(tool)}`, { method: 'PUT', body: patch }),
  setDailyCap: (dailyAutoCap: number, code?: string) =>
    call<{ ok: true; dailyAutoCap: number }>('autonomy', { method: 'PUT', body: { dailyAutoCap, ...(code ? { code } : {}) } }),
  pause: (reason?: string) =>
    command<{ ok: true; handedBack: number }>('claude-pause', `${getBackendUrl()}/api/claude/pause`, { reason }, 'pause request'),
  resume: (code: string) =>
    command<{ ok: true }>('claude-resume', `${getBackendUrl()}/api/claude/resume`, { code }, 'resume request'),
  activity: (filters: { outcome?: Outcome; tool?: string; cursor?: string | null; limit?: number }) => {
    const query = new URLSearchParams()
    if (filters.outcome) query.set('outcome', filters.outcome)
    if (filters.tool?.trim()) query.set('tool', filters.tool.trim())
    if (filters.cursor) query.set('cursor', filters.cursor)
    query.set('limit', String(filters.limit ?? 50))
    return call<{ rows: ActivityRow[]; nextCursor: string | null }>(`activity?${query}`)
  },
  undo: (changeId: string) =>
    command<{ ok: true; approvalId: string; tool: string; executeAfter: string }>(
      `claude-undo:${changeId}`,
      `${getBackendUrl()}/api/claude/changes/${encodeURIComponent(changeId)}/undo`,
      {},
      'undo request',
    ),
}

export type { Autonomy }
