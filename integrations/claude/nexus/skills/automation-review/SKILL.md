---
name: automation-review
description: Review every automation in a Nexus business - ads rules and engines, budget schedules and pools, the agent fleet, repricing, listing, replenishment, review and bulk rules, scheduled jobs and alerts - say what each may do now and what it actually did, explain why something did or did not happen, and propose changes (level up or down, a rule, a guardrail, a setting, stop or resume) as requests a person approves. Use when the person asks what is automated, why a rule did or did not act, to switch an automation on or off, or to create or tune a rule.
---

# Automation review

List, explain, propose. Every automation sits on a ladder: OFF · OBSERVE (runs and records, does nothing) · PROPOSE (suggests, a person decides) · AUTO (acts by itself inside its caps). What it may do is the lower of what the server allows (its env switch) and what this business set. Nothing here pauses an ad: rules lower bids instead.

## Ground rules

- **Say which business first.** This connection works in one business, and every Nexus answer names it (`business`). Before you ask for any change, say it in plain words ("This connection works in Acme Racing"), and pass that exact name as `business` on the change tool or on `submit-change-plan`. Never reuse an id, a SKU or an approvalId read on another business's connection: the same SKU can exist in both.
- **Read first, show the plan, ask.** Read what is there now. Show the plan: what changes, from → to, how many, and where it lands (Nexus only, or a marketplace or a buyer). Ask a plain question; go on only after a clear yes. If the person changes the plan, show it again.
- **One request.** Several changes go in ONE `submit-change-plan` (up to 200 steps; a bulk tool counts as one step) or one bulk tool. Never a loop of single requests.
- **Follow up.** A change answers `status: "waiting_for_approval"` (a person approves it on the Nexus Approvals page: give the `approveAt` link; it expires at `expiresAt`), or `status: "runs_by_rule"` (the business lets it run by itself at `runsAt`, and anyone can stop it before then at `stopAt`). With a `confirm` part, the business set it to "confirm in Claude": ask the person who asked for the 6-digit code from their authenticator app, then call `confirm-change` with the `approvalId`, the `planHash` and the code. Never say anything changed until `approval-status` says it ran; repeat its `meaning`.
- **Never** pause an ad (lower its bids instead), change an FBA quantity (it is Amazon's number), send anyone to the old Amazon or eBay flat-file pages (use the product sheet and the product studio), or guess, keep or reuse an authenticator code.
- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason in plain words and carry on with the rest.

## 1. List

`list-automations` (optional `area`: amazon-ads, ebay-ads, marketing, agents, pricing, products, listings, replenishment, reviews, bulk, alerts, detectors; optional `level`): each automation's number (A1 …, E1, F1, N1 …), its effective level and why, scope, schedule, caps, last run and up to 5 of its rules. An automation the server switches off reads OFF and names the env flag.

## 2. Explain

- One automation in full: `automation-detail` (`automation`, optional `rowId` for one rule, plan, schedule or pool).
- What it did: `automation-activity` (`automation`, `rowId`, `days` up to 30) — its runs, what it wrote, whether it ever wrote anything, and what stopped it (its own cap, a value cap). Use it for "why did it do X" and "why did nothing happen".
- What it would do now: `preview-automation` (`automation`, `rowId`, or an unsaved `draft`) — writes nothing, sends nothing.
- Report: what is at AUTO, what is only watching, what is off and why, and anything that looks wrong (a rule at AUTO that never wrote, a cap that decides more than the conditions).

## 3. Propose (only when asked)

| To | Tool |
|---|---|
| Go up the ladder | `turn-up-automation` (`automation`, `rowId`, `level`). AUTO only after the graduation gate (14 days watched, 10 real runs, 1 match) and always a person's click. An engine the server env switches goes up only as far as the env allows (leave `rowId` out). |
| Go down | `turn-down-automation` (`level`: PROPOSE, OBSERVE or OFF). Turning down a brake (a rule that lowers bids, a dayparting or budget schedule, budget enforcement, rank-defend) can raise spend: it always needs a person. OFF retires a rule; nothing is deleted. |
| Stop an area now | `stop-automation` (`area`: amazon-ads, ebay-ads, agent-fleet, review-mailer, rules + `domain`; `reason`) |
| Resume it | `resume-automation` — always a person's decision |
| A new or changed ads or marketing rule | `save-ad-rule` (born OBSERVE; an eBay rule is saved OFF; a pause is refused — use `lower_bid_to_floor`; caps required; ratios as fractions, 0.3 not 30) |
| An operations rule (listings, replenishment, reviews, bulk) | `save-ops-rule` (born OBSERVE; a review rule OFF; daily run cap required) |
| A repricing rule | `save-price-rule` (born OFF; its min/max must sit inside the product's price bounds) |
| A guardrail (spend ceiling, bid policy, protected term) | `set-ad-guardrail` (tightening may run inside the business's limits; loosening always needs a person) |
| An engine's setting (budget pool, coverage caps, rank target, budget schedule, harvest policy, eBay campaign policy, target ACoS, breaker) | `tune-ad-engine` (a move that can raise spend always needs a person) |
| The agent fleet's workers | `steer-fleet` (run now, pause, resume, level, assign; never their prompts, model or budget) |
| Rule suggestions waiting | `decide-automation-suggestions` (apply or dismiss; a pause suggestion is refused — dismiss it) |

- Before proposing a rule, run `preview-automation` with the `draft` and show what it would do now.
- Several changes: ONE `submit-change-plan`. Show the table: automation, from → to level (or setting from → to), why, and whether it can raise spend.
- Never edit a worker's prompt, the AI providers, budgets or the kill switch: those stay a person's own settings in Nexus.

## 4. After

`approval-status` for each request; then `list-automations` again to confirm the new level, and `automation-activity` after its next run.
