/** Shared publish-gate wording; extracted unchanged from the studio queue. */
export function gateNote(mode: string | null, channelLabel: string): string | null {
  switch (mode) {
    case 'gated':
      return `${channelLabel} publishing is switched off on the server (mode: gated). Re-running these writes would be refused by the same gate that failed them — the queue already holds 368 rows that are exactly that. The flag, not the retry, is what has to change.`
    case 'dry-run':
      return `${channelLabel} is in dry-run: a write runs and reports success without touching the real listing. A cleared queue here would not mean the channel was updated.`
    case 'sandbox':
      return `${channelLabel} is pointed at its sandbox. Writes land there, never on the live listing.`
    /**
     * 🔴 The ONLY mode that earns silence. Publishing is real, a retry does what it says, and there
     * is nothing to warn about.
     */
    case 'live':
      return null
    /**
     * 🔴 An unrecognised mode is NOT the same as `live`, and a shared `default` said it was.
     *
     * This is where the operator most needs telling — the console cannot vouch for what a retry
     * would do under a mode it does not know, and staying quiet reads as "publishing is normal".
     * My own `modeForChannel` two functions up already refuses to guess `'live'` for a channel the
     * server did not describe; falling through to silence here undid that reasoning one step later.
     *
     * ⚠ This warning is the PRECONDITION for opening the union (P2-4): an open union is safe only
     * when every consumer degrades safely, and until this branch existed, a mode the server added
     * tomorrow would have rendered as nothing at all.
     */
    default:
      return mode === null
        ? `${channelLabel}'s publish gate is not described by this server response, so nothing here can say whether a retry would reach the channel.`
        : `${channelLabel} reports an unrecognised publish mode (${mode}). This console cannot say what a retry would do — treat the queue below as unexplained until someone checks the gate.`
  }
}
