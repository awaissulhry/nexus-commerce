import { z } from 'zod'
import { businessDate, defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { FILE_ASK_ADDRESSEES, FILE_ASK_KINDS, FILE_ASK_LIMITS, FILE_ASK_STATUSES, FILE_ASK_TARGETS } from '@nexus/factory-domain/files/asks'
import { notMoney } from '@nexus/factory-domain/money/marked'

/**
 * B-OF-031 (order files tab; 13-backend §2): the ask-for-a-file commands of one sales order. Every write sends the version it read
 * (409 with words on a stale one). No field carries money: `priced` is a lock flag (the asked file shows prices), not an amount.
 */

const orderParams = input({ orderId: id() })
const askParams = input({ orderId: id(), askId: id() })

/** Where the file lands: the order itself, one of its lines, or one of its work orders (and one step of it). */
const target = input({
  type: z.enum(FILE_ASK_TARGETS),
  lineId: id().optional(),
  workOrderId: id().optional(),
  operationId: id().optional(),
})

/** Who is asked: an office person, an office role, a floor role, a floor team, or whoever works the target's step (no id). */
const who = input({
  kind: z.enum(FILE_ASK_ADDRESSEES),
  userId: id().optional(),
  roleId: id().optional(),
  teamId: id().optional(),
})

const words = z.string().min(1).max(FILE_ASK_LIMITS.words)
const reason = z.string().min(FILE_ASK_LIMITS.reasonMin).max(FILE_ASK_LIMITS.reasonMax)
const version = z.number().int().min(1)

/** What a command answers: the ask as it is now, and how many Tasks it wrote (an office addressee's "Upload: …"). */
const askAnswer = output({
  ask: output({ id: id(), version: z.number().int(), status: z.enum(FILE_ASK_STATUSES) }),
  tasks: z.number().int(),
})

// ---- S2.1: make, change, reassign, cancel ---------------------------------------------------------------------------------------
export const makeAskBody = input({
  words,
  fileKind: z.enum(FILE_ASK_KINDS),
  target,
  who,
  dueOn: businessDate(),
  /** The file shows prices: only for (and of) people who see prices; never of the floor. */
  priced: notMoney(z.boolean()).optional(),
  /** The file is body data (a measurement sheet): only between holders of the measurements right; never of the floor. */
  bodyData: z.boolean().optional(),
})
export type MakeAskBody = z.infer<typeof makeAskBody>
export const makeAskContract = defineContract({ params: orderParams, body: makeAskBody, response: { 201: askAnswer } })

export const changeAskBody = input({ version, words: words.optional(), dueOn: businessDate().optional() })
export type ChangeAskBody = z.infer<typeof changeAskBody>
export const changeAskContract = defineContract({ params: askParams, body: changeAskBody, response: { 200: askAnswer } })

export const reassignAskBody = input({ version, who, reason: z.string().max(FILE_ASK_LIMITS.reasonMax).optional() })
export type ReassignAskBody = z.infer<typeof reassignAskBody>
export const reassignAskContract = defineContract({ params: askParams, body: reassignAskBody, response: { 200: askAnswer } })

export const reasonBody = input({ version, reason })
export type ReasonBody = z.infer<typeof reasonBody>
export const cancelAskContract = defineContract({ params: askParams, body: reasonBody, response: { 200: askAnswer } })

// ---- S2.2: answer, accept, ask again, chase -----------------------------------------------------------------------------------
export const versionBody = input({ version })
export type VersionBody = z.infer<typeof versionBody>

export const answerAskBody = input({ version, fileIds: z.array(id()).min(1).max(FILE_ASK_LIMITS.files) })
export type AnswerAskBody = z.infer<typeof answerAskBody>
export const answerAskContract = defineContract({ params: askParams, body: answerAskBody, response: { 200: askAnswer } })
export const acceptAskContract = defineContract({ params: askParams, body: versionBody, response: { 200: askAnswer } })
export const askAgainContract = defineContract({ params: askParams, body: reasonBody, response: { 200: askAnswer } })
export const chaseAskContract = defineContract({ params: askParams, body: versionBody, response: { 200: askAnswer } })
