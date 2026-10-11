/**
 * Ads wave 4c — every write control that reaches Amazon on the bid, negatives, harvest and keyword-action pages (and
 * campaign detail and portfolios) is off on a market Nexus only reads, with the same keyboard-reachable reason: the
 * DS InfoTip beside it (`WriteBlockedTip`). A source check, because the tests run without a browser: a control that
 * loses its block, or a new write control added without one, fails here. The write gate stays the backstop.
 *
 * The Bid page (rebuilt 2026-10-10) holds its writes the DS way: the control stays focusable and says the market's reason
 * (`Button heldReason`, a held mode step or menu item) instead of `disabled` + a tip. Its rows guard the live files — the
 * parked `bid/BidEditing.tsx` this test read before is gone (use audit A1, A13).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ads = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = (rel: string) => readFileSync(join(ads, rel), 'utf8')

const CONTROLS: Array<{ file: string; button: RegExp }> = [
  { file: 'rules-automation/negative-targeting/NegRemoval.tsx', button: /disabled=\{busy \|\| writeCount === 0 \|\| !!blocked\}/ },
  { file: 'rules-automation/negative-targeting/NegWastefulWords.tsx', button: /disabled=\{busy \|\| !!targetBlocked\}/ },
  { file: 'rules-automation/keyword-harvest/HvPromote.tsx', button: /disabled=\{busy \|\| plan\.promotable === 0 \|\| !!blocked\}/ },
  { file: 'rules-automation/keyword-tracker/BidAction.tsx', button: /disabled=\{loading \|\| !!blocked\}/ },
  { file: 'rules-automation/keyword-tracker/BidAction.tsx', button: /disabled=\{!p\.canPropose \|\| loading \|\| !!blocked\}/ },
  { file: 'campaigns/[id]/tabs/DetailsTab.tsx', button: /\|\| !!writeBlock\}/ },
  { file: 'portfolios/PortfoliosClient.tsx', button: /\|\| !!rowWriteBlock\(r\)\}/ },
]

/** The Bid page: each write control and the pattern that holds it with the market's reason. */
const BID = 'rules-automation/bid'
const BID_CONTROLS: Array<{ file: string; what: string; held: RegExp[] }> = [
  { file: `${BID}/bids/BidsView.tsx`, what: 'every row carries its market\'s reason; bulk Apply suggested', held: [/const blockOf = useWriteBlockOf\(\)/, /writeBlock: blockOf\(\[market, r\.market\]\)/, /autoLock: r\.writeBlock \?\? autoHeld/, /heldReason=\{applyHeld\(bulkPlan\)\}/] },
  { file: `${BID}/bids/suggestedModel.ts`, what: 'Apply leaves a held row out, with the reason', held: [/const skip = row\.writeBlock \? row\.writeBlock/] },
  { file: `${BID}/bids/bidsColumns.tsx`, what: 'row Apply; the Auto switch', held: [/heldReason=\{data\.writeBlock\}/, /disabledReason: \(r\) => r\.autoLock/] },
  { file: `${BID}/bids/BidDetail.tsx`, what: 'Set bid, Lock, Apply, Auto / Manual, Goal, History Undo', held: [/const editHeld = row\.writeBlock \?\? editHeldReason/, /: row\.writeBlock \? row\.writeBlock/, /heldReason=\{row\.writeBlock \?\? \(canBids/, /heldReason=\{row\.writeBlock \?\? autoHeld/, /row\.writeBlock \?\? goalHeld/, /canEdit \? row\.writeBlock/] },
  { file: `${BID}/bids/useBidReview.ts`, what: 'a review that opens anyway saves nothing', held: [/const blocked = a\.kind === 'apply' \? null : r\.writeBlock/] },
  { file: `${BID}/rules/RulesView.tsx`, what: 'mode, archive, New rule, bulk, the detail\'s writes', held: [/const pageBlock = useWriteBlock\(\[market\]\)/, /const blockOf = useWriteBlockOf\(\)/, /archiveHeld = canAutomation \? pageBlock/, /undoHeld = canCampaigns \? pageBlock/, /heldReason=\{archiveHeld\} onClick=\{openNew\}/, /heldReason=\{bulkArchiveHeld\}/, /modeHeld=\{modeHeld \?\? panelBlock\}/, /decideHeld=\{undoHeld \?\? panelBlock\}/, /editHeld=\{panelBlock\}/] },
  { file: `${BID}/rules/RulesTable.tsx`, what: 'the row\'s mode picker and its Archive / Restore', held: [/lockReason: \(g\) => modeLock\(g\.row\) \?\? g\.block/, /const held = h\.archiveHeld \?\? g\.block/] },
  { file: `${BID}/rules/RulePanel.tsx`, what: 'Archive / Restore, Edit all, Roll back', held: [/heldReason=\{p\.archiveHeld\} onClick=\{p\.onArchive\}/, /heldReason=\{p\.editHeld\}/, /heldReason=\{undoHeld\} onClick=\{\(\) => onRollback/] },
  { file: `${BID}/rules/WaitingTab.tsx`, what: 'Approve / Reject', held: [/heldReason=\{aHeld\}/, /heldReason=\{rHeld\}/] },
]

describe('🔴 the Bid page — every write control is held with the market\'s reason on a reading-only market (A1)', () => {
  for (const c of BID_CONTROLS) {
    it(`${c.file}: ${c.what}`, () => {
      const s = src(c.file)
      for (const re of c.held) expect(s).toMatch(re)
    })
  }

  it('no Bid file switches a write off with `disabled` (a disabled control never says why)', () => {
    for (const c of BID_CONTROLS) expect(src(c.file)).not.toMatch(/<Button[^>]*\sdisabled=\{/)
  })
})

describe('🔴 4c — write controls on a reading-only market are off, with a focusable reason', () => {
  for (const c of CONTROLS) {
    it(`${c.file}: disabled by the market's write block, reason in WriteBlockedTip`, () => {
      const s = src(c.file)
      expect(s).toMatch(c.button)
      expect(s).toMatch(/<WriteBlockedTip reason=\{/)
    })
  }

  it('the harvest selection bar is off too, from the page\'s market', () => {
    expect(src('rules-automation/keyword-harvest/KeywordHarvestClient.tsx')).toMatch(/\}, promoteBlocked\)\}/)
    expect(src('rules-automation/keyword-harvest/HvPromote.tsx')).toMatch(/className="h10-hv-promote" disabled=\{!!blocked\}/)
  })
})
