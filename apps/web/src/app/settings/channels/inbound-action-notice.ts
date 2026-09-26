export interface InboundActionNotice {
  tone: 'success' | 'info' | 'danger'
  title: string
  text: string
}

/** Operator feedback for the inbound retry/replay response contract. */
export function inboundActionNotice(action: 'retry' | 'replay', status: number, body: unknown): InboundActionNotice {
  const result = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
  if (status < 200 || status >= 300 || result.success !== true
    || (result.queued !== undefined && typeof result.queued !== 'boolean')
    || (action === 'retry' && result.queued !== true)) {
    return { tone: 'danger', title: 'Result not confirmed', text: typeof result.error === 'string' && result.error.trim()
      ? result.error : 'The result could not be confirmed. Refresh the event before trying again.' }
  }
  if (status === 202 || result.queued === true) {
    return { tone: 'info', title: 'Queued', text: 'Accepted for processing. Check the event for its final result.' }
  }
  return { tone: 'success', title: 'Completed', text: 'Replayed successfully.' }
}
