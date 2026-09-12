export interface ConnectionAttempt {
  channelKey: string
  workspaceId: string | null
  state: string | null
  /** Only non-shared legacy routes may complete without an OAuth state. */
  legacy?: boolean
}

/** OAuth replies belong to the attempt that opened them, even when its target differs from the page. */
export function matchesConnectionAttempt(data: unknown, attempt: ConnectionAttempt | null, scoped: boolean): boolean {
  if (!attempt || !data || typeof data !== 'object') return false
  const message = data as Record<string, unknown>
  if (message.type !== 'nexus:channel-connected') return false
  if (scoped && message.workspaceId !== attempt.workspaceId) return false
  if (attempt.state ? message.state !== attempt.state : (scoped || !attempt.legacy)) return false
  return message.channelKey === attempt.channelKey || (!scoped && message.channel === attempt.channelKey)
}
