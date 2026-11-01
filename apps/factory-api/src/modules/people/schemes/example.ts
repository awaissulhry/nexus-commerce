import { toMinorUnits } from '@nexus/factory-domain/core/money'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { PEOPLE_PIECERATES_VIEW } from '@nexus/factory-domain/people/piecerates/permissions'
import { averagePerMinuteOf, defectPayOf, paidTimeOf, periodPayOf, SchemePayError, teamSplitOf, type DefectKind } from '@nexus/factory-domain/people/schemes/pay'
import { guaranteeRefusal, PAID_TIME_WORDS, SPLIT_WORDS } from '@nexus/factory-domain/people/schemes/rules'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import type { CommandCaller } from '../../../core/command'
import { refuseScheme } from './access'
import { schemeOf, schemeRowOf } from './store'

/**
 * "Try the scheme" (B-W2b-38; MES-257, MES-258, MES-259; GATE-PIECE-PAY: the labour consultant agrees the make-up): one
 * made-up period of one made-up worker under a scheme, computed by factory-domain people/schemes/pay exactly as the
 * period run (B-W2b-43) will compute it: pieces, waiting, rework and scrap, the make-up to the guaranteed pay or the
 * standard-minute bonus, and a team's split among members named by letters. Nothing is read of anyone's records and
 * nothing is written; every figure is `money.pay` (a caller without the pay grain cannot send or see one).
 */

export interface DefectBody {
  readonly ownPieces?: number | undefined
  readonly ratePerPiece?: string | undefined
  readonly othersMinutes?: number | undefined
}

export interface ExampleBody {
  readonly minutesPresent: number
  readonly traineeMinutes?: number | undefined
  /** money.pay: optional in the contract (a marked field), required here. */
  readonly pieceEarnings?: string | undefined
  readonly earnedStandardMinutes?: string | undefined
  readonly waitingMinutes?: number | undefined
  readonly rework?: DefectBody | undefined
  readonly scrap?: DefectBody | undefined
  readonly team?: { readonly teamEarnings?: string | undefined; readonly members: readonly { readonly label: string; readonly minutesPresent?: number | undefined; readonly skillWeight?: string | undefined }[] } | undefined
}

type LineCode = 'PIECES' | 'TIME' | 'BONUS' | 'WAITING' | 'REWORK_OWN' | 'REWORK_OTHERS' | 'SCRAP_OWN' | 'SCRAP_OTHERS' | 'MAKE_UP'

export async function example(caller: CommandCaller, schemeId: string, body: ExampleBody) {
  const { scheme: record } = await schemeOf(caller, schemeId, PEOPLE_PIECERATES_VIEW)
  const scheme = schemeRowOf(record)
  refuseScheme(guaranteeRefusal(scheme))
  const offMinutes = (body.waitingMinutes ?? 0) + (body.rework?.othersMinutes ?? 0) + (body.scrap?.othersMinutes ?? 0)
  const problems = [
    ...(body.pieceEarnings === undefined ? [{ path: 'pieceEarnings', message: 'Give what the good pieces paid at their rates.' }] : []),
    ...(body.team && body.team.teamEarnings === undefined ? [{ path: 'team/teamEarnings', message: "Give the team's pay to split." }] : []),
    ...((body.traineeMinutes ?? 0) > body.minutesPresent ? [{ path: 'traineeMinutes', message: "A trainee's minutes are part of the minutes present." }] : []),
    ...(offMinutes > body.minutesPresent ? [{ path: 'waitingMinutes', message: 'Waiting and the minutes of rework and scrap caused by others are part of the minutes present.' }] : []),
    ...(scheme.kind === 'STANDARD_MINUTE_BONUS' && (body.earnedStandardMinutes === undefined || !/^\d{1,9}(\.\d{1,3})?$/.test(body.earnedStandardMinutes)) ? [{ path: 'earnedStandardMinutes', message: 'A standard-minute bonus needs the standard minutes the pieces earned (at most 3 decimals).' }] : []),
    ...(['rework', 'scrap'] as const).flatMap((what) => ((body[what]?.ownPieces ?? 0) > 0 && body[what]?.ratePerPiece === undefined ? [{ path: `${what}/ratePerPiece`, message: 'Pieces of the worker\'s own fault need their rate per piece.' }] : [])),
    ...(body.team && scheme.kind !== 'TEAM_INCENTIVE' ? [{ path: 'team', message: 'Only a team incentive splits a team\'s pay.' }] : []),
  ]
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'This example is not complete.', problems)

  const currency = scheme.currency
  const pieces = toMinorUnits(body.pieceEarnings!, currency)
  const standardMinutes = body.minutesPresent - offMinutes
  const average = averagePerMinuteOf({ earned: pieces, minutes: standardMinutes, currency })
  const lines: { code: LineCode; words: string; minutes: string | null; pieces: number | null; rate: string | null; amount: number }[] = []
  const words: string[] = []

  // Waiting, and rework and scrap: priced by the scheme's rules (paid time is part of what the period earned).
  // Under a standard-minute bonus they are inside the hours present the guaranteed pay covers: nothing is added.
  let earned = pieces
  const bonusScheme = scheme.kind === 'STANDARD_MINUTE_BONUS'
  if (!bonusScheme && (body.waitingMinutes ?? 0) > 0) {
    const time = paidTimeOf(scheme, { rule: scheme.waitingPay, minutes: body.waitingMinutes!, averagePerMinute: average })
    lines.push({ code: 'WAITING', words: `Waiting that was not the worker's doing, paid ${PAID_TIME_WORDS[time.basis]}.`, minutes: String(time.minutes), pieces: null, rate: time.ratePerMinute, amount: time.amount })
    earned += time.amount
  }
  for (const what of ['rework', 'scrap'] as const) {
    const facts = body[what]
    if (!facts || bonusScheme) continue
    const kind: DefectKind = what === 'rework' ? 'REWORK' : 'SCRAP'
    const label = what === 'rework' ? 'Rework' : 'Scrap'
    if ((facts.ownPieces ?? 0) > 0) {
      const pay = defectPayOf(scheme, { what: kind, fault: 'OWN', pieces: facts.ownPieces!, ratePerPiece: facts.ratePerPiece!, minutes: 0, averagePerMinute: average })
      const rule = pay.pays === 'NOTHING' ? 'not paid' : pay.rule === 'FULL_RATE' ? 'paid at the full rate' : `paid at ${scheme.ownFaultRatePct}% of the rate`
      lines.push({ code: kind === 'REWORK' ? 'REWORK_OWN' : 'SCRAP_OWN', words: `${label} of the worker's own fault: ${rule}.`, minutes: null, pieces: facts.ownPieces!, rate: pay.pays === 'PIECES' ? pay.rate : null, amount: pay.amount })
      earned += pay.amount
    }
    if ((facts.othersMinutes ?? 0) > 0) {
      const pay = defectPayOf(scheme, { what: kind, fault: 'OTHERS', pieces: 0, ratePerPiece: '0', minutes: facts.othersMinutes!, averagePerMinute: average })
      if (pay.pays !== 'TIME') continue
      lines.push({ code: kind === 'REWORK' ? 'REWORK_OTHERS' : 'SCRAP_OTHERS', words: `${label} caused by others, paid as time off standard ${PAID_TIME_WORDS[pay.time.basis]}.`, minutes: String(pay.time.minutes), pieces: null, rate: pay.time.ratePerMinute, amount: pay.amount })
      earned += pay.amount
    }
  }

  const period = periodPayOf(scheme, {
    minutesPresent: body.minutesPresent,
    traineeMinutes: body.traineeMinutes,
    earned,
    earnedStandardMinutes: body.earnedStandardMinutes,
    earnedValue: pieces,
  })
  if (period.bonus) {
    // The bonus scheme pays the time and the bonus; the pieces' value only measures the bonus.
    lines.unshift({ code: 'TIME', words: 'The guaranteed pay for the minutes present.', minutes: String(body.minutesPresent), pieces: null, rate: null, amount: period.guaranteed })
    lines.push({ code: 'BONUS', words: `The standard minutes earned above the threshold (${period.bonus.bonusMinutes} of them), at the value they earned.`, minutes: period.bonus.bonusMinutes, pieces: null, rate: null, amount: period.bonus.bonus })
    words.push('A standard-minute bonus pays the guaranteed pay for the hours present and the bonus; waiting, rework and scrap are inside those hours.')
  } else {
    lines.unshift({ code: 'PIECES', words: 'The good pieces at the rates of their operations.', minutes: null, pieces: null, rate: null, amount: pieces })
    const makeUp = period.makeUp!
    if (makeUp.makeUp > 0) {
      lines.push({ code: 'MAKE_UP', words: 'The make-up to the guaranteed pay for the minutes present (c.c. art. 2101; the CCNL minimum).', minutes: String(makeUp.minutes), pieces: null, rate: makeUp.ratePerMinute, amount: makeUp.makeUp })
      words.push('What the period earned is below the guaranteed pay: the make-up tops it up, so piece pay is never below the guaranteed pay.')
    } else {
      words.push('What the period earned is at or above the guaranteed pay: no make-up.')
    }
  }

  let teamShares: { label: string; sharePct: string; amount: number }[] = []
  if (body.team) {
    try {
      teamShares = teamSplitOf({
        basis: scheme.teamSplit!,
        pay: toMinorUnits(body.team.teamEarnings!, currency),
        members: body.team.members.map((member) => ({ key: member.label, minutesPresent: member.minutesPresent, skillWeight: member.skillWeight })),
      }).map((share) => ({ label: share.key, sharePct: share.sharePct, amount: share.amount }))
      words.push(`${SPLIT_WORDS[scheme.teamSplit!]} The shares add up to the team's pay exactly.`)
    } catch (error) {
      if (error instanceof SchemePayError) throw new ValidationError(`The team cannot be split: ${error.message}.`, [{ path: 'team/members', message: error.message }])
      throw error
    }
  }

  return {
    scheme: { id: record.id, name: record.name, kind: scheme.kind },
    currency,
    lines: lines.map((line) => ({ ...line, rate: asMoney('pay', line.rate), amount: asMoney('pay', line.amount) })),
    guaranteed: asMoney('pay', period.guaranteed),
    makeUp: asMoney('pay', period.makeUp?.makeUp ?? 0),
    total: asMoney('pay', period.total),
    efficiencyPct: period.bonus?.efficiencyPct ?? null,
    teamShares: teamShares.map((share) => ({ ...share, amount: asMoney('pay', share.amount) })),
    words,
  }
}
