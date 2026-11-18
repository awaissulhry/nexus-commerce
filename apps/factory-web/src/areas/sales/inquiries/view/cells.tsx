import type { Phrase } from '../model'

/**
 * B-TH-216 (threads plan TH-1b, Sales › Incoming): the small helpers of an Incoming row the Orders sheet's parts do not cover. The
 * doors, the funnel and the peek card are the Orders sheet's own parts (areas/sales/orders/list/sheet/parts.tsx), so both lists read
 * the same. F-SA-212: the Picture cell and the picture large are the ONE picture part (lib/record-picture), with Incoming's
 * file-kinds fallback. Words: the `sales-inquiries` catalogue.
 */

/** Phrases said one after the other ("2 photos · 1 document"). */
export const joined = (phrases: readonly Phrase[], say: (phrase: Phrase) => string | null): string => phrases.map((phrase) => say(phrase) ?? '').filter(Boolean).join(' · ')
