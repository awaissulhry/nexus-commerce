'use client'

/**
 * The shipping screens' hooks. The live stream, the coalesced re-read and the CSV download are the order screens' (one
 * Office view: the same `/live` stream and the same file download). B-TH-264: the shipment's own thread dock went — the
 * record frame docks the thread beside every tab (⌘J) and an old `?tab=activity` opens it.
 */
export { downloadText, useCoalesced, useLive, type LiveState } from '../../sales/orders/hooks'
