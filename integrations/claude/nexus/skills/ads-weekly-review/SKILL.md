---
name: ads-weekly-review
description: Weekly advertising review in Nexus, market by market, for Amazon Sponsored Products and eBay Promoted Listings - read spend, sales and ACoS, wasteful and converting search terms, bids and the engines' recommendations, explain them in plain words, then offer the changes as one change plan (negatives, exact keywords, lower bids, budgets, eBay rates) that a person approves. Never pauses anything. Use when the person asks how their ads are doing, for a weekly ads or bid review, or what to change in their campaigns.
---

# Ads weekly review

Reads first, then proposes. Nothing changes until a person approves the plan in Nexus (or the business lets a tool run by its rule). Ads in Nexus are **never paused**: to stop spend, bids go down (to the 2-cent floor with `suppress-campaign`), and a suppressed bid is never raised.

## Ground rules

- **Say which business first.** This connection works in one business, and every Nexus answer names it (`business`). Before you ask for any change, say it in plain words ("This connection works in Acme Racing"), and pass that exact name as `business` on the change tool or on `submit-change-plan`. Never reuse an id, a SKU or an approvalId read on another business's connection: the same SKU can exist in both.
- **Read first, show the plan, ask.** Read what is there now. Show the plan: what changes, from → to, how many, and where it lands (Nexus only, or a marketplace or a buyer). Ask a plain question; go on only after a clear yes. If the person changes the plan, show it again.
- **One request.** Several changes go in ONE `submit-change-plan` (up to 200 steps; a bulk tool counts as one step) or one bulk tool. Never a loop of single requests.
- **Follow up.** A change answers `status: "waiting_for_approval"` (a person approves it on the Nexus Approvals page: give the `approveAt` link; it expires at `expiresAt`), or `status: "runs_by_rule"` (the business lets it run by itself at `runsAt`, and anyone can stop it before then at `stopAt`). With a `confirm` part, the business set it to "confirm in Claude": ask the person who asked for the 6-digit code from their authenticator app, then call `confirm-change` with the `approvalId`, the `planHash` and the code. Never say anything changed until `approval-status` says it ran; repeat its `meaning`.
- **Never** pause an ad (lower its bids instead), change an FBA quantity (it is Amazon's number), send anyone to the old Amazon or eBay flat-file pages (use the product sheet and the product studio), or guess, keep or reuse an authenticator code.
- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason in plain words and carry on with the rest.

## How to read the numbers

- Amounts are minor units (cents) of each campaign's own currency, with the currency named beside them. Never convert, and never add two markets together: each market is reported on its own.
- The last 3 days are provisional (Amazon restates them for up to 72 hours). `dataAsOf` is the newest day of data.
- A person without the ad-spend money permission sees the same answers without amounts: say so, and review by clicks, orders and ACoS only.
- `liveWrites` / the preview say whether a change lands live at Amazon or eBay or only in sandbox. A campaign off the live-write allowlist does not take a live change; putting it on (`set-campaign-live-writes`) is the person's decision and always waits for a person.

## 1. Per market: read

Ask which channel (`amazon`, the default, or `ebay`) and markets, or take every market with spend.

1. `ads-overview` (`channel`, `market`, `days`: 7 by default): spend, sales, ACoS, ROAS, against the period before; top spenders; the automation dial; data feed health.
2. `ad-campaigns` (`market`, `status`, `days`): per campaign budget, ACoS, `liveWrites`, suppressed bids, pins.
3. `ad-search-terms` (`kind: "wasteful"` then `"converting"`, `market`, `days: 30`): terms that spent with no order (negative candidates) and terms with 2 or more orders (exact-keyword candidates).
4. `ad-targets` (`campaignId` or `market`, `search`) for the bids behind a problem.
5. `ad-recommendations` (`market`, `category`): what the engines and the rules suggest, with the ids each change tool takes and `suggestedTool`. A pause suggestion is information only.
6. `ad-changes` (`days: 14`) when the person asks "what changed" or a number moved for no clear reason.

## 2. Explain

Per market, a few lines: spend and sales against last week, ACoS against the target, the 3 biggest wastes, the 3 best converting terms, campaigns over budget or starved, anything an engine flags. Then a short list of proposed changes with why.

## 3. Propose (one plan per review)

| To | Tool |
|---|---|
| Stop a search term triggering ads | `create-negative-keyword` (`externalCampaignId`, `externalAdGroupId`, `keywordText`, `matchType`) |
| Promote a converting term to an exact keyword | `graduate-keyword` (`query`, `sourceExternalCampaignId`, …) |
| Change one bid / many bids | `set-target-bid` (`targetId`, `proposedBidCents`) / `bulk-ad-bid-change` (`bids` up to 250, or a selection and `percent`) |
| Change a daily budget | `set-campaign-budget` (a raise always waits for a person) |
| Placement adjustments | `set-placement-multipliers` |
| Stop a campaign spending (no pause) | `suppress-campaign`; `restore-campaign` puts the bids back |
| Apply or dismiss what PROPOSE rules suggested | `decide-automation-suggestions` (a pause suggestion is refused: dismiss it) |
| eBay: rates, keywords, budgets, promote listings | `set-ebay-ad-rates`, `ebay-keywords-change`, `set-ebay-campaign-budget`, `promote-ebay-listings` |

- Give `why` on every change: the approver reads it, and it stays in the ads audit.
- Put the review's changes in ONE `submit-change-plan` (a bulk bid change is one step). Show the table first: campaign, what, from → to, currency, live or sandbox.
- New campaigns (`create-ad-campaign`, `create-ebay-campaign`) only when the person asks: an Amazon one is born safe (bids at the floor, off the allowlist), an eBay General one starts at the 2% minimum rate with no listings.
- Rules, engines and guardrails belong to the `automation-review` skill.

## 4. After

`approval-status` shows `ads` (writes waiting, sent, refused by the write gate, failed, or run in sandbox) and `ebay` for eBay writes. `undo-change` puts an approved ad change back (see `review-and-undo`).
