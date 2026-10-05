# 04 — Industry patterns for approving AI-agent actions (research, 2026-10-05)

Read-only web research for the Approvals grid rebuild. No repository code was read or changed for this file.
Every pattern lists: **What** · **Who** (with source) · **Fits** (why it suits one owner selling on Amazon, eBay,
Shopify and Etsy) · **Risk**. Sources were checked on 2026-10-05. A claim that comes only from a third-party
review site is marked *(review site)*.

## Summary
1. The best tools stopped asking a person about everything. Anthropic found people approve **93%** of Claude Code prompts, so it built auto mode. When auto mode blocks an action, it tells the agent why, and the agent keeps working.
2. Most products settle on three settings per kind of action: **Always allow / Needs approval / Blocked** (Claude.ai connectors, Claude Code allow/ask/deny). A deny always wins over an allow.
3. "Always allow" is safe only when it is **scoped and shown in full**. Claude Code offers "don't ask again" only when the prompt can show everything the rule would allow. Copilot Studio and Amazon pricing add limits (an amount threshold, a min/max price).
4. Before a rule goes live, show what it **would have done** (Stripe Radar tests a rule on 6 months of past payments). In Nexus that is "this rule would have run 34 of your last 40 requests; you rejected 2 of them".
5. The queue UIs that work best are a **list or table with a detail panel**, one-key actions (Linear 1/2/3/H, Superhuman j/k/e/z), **bulk apply by type** (Amazon Ads, Perpetua) and **edit before approve**.
6. Waiting must not block the agent. Agent frameworks park the request durably (OpenAI RunState, Temporal, Inngest, Cloudflare). They tell the agent "rejected + reason", "expired" or "approved" as separate results. Zapier makes the timeout behaviour an explicit choice.
7. Progress needs a **status for every stage** (Shopify Flow: in progress, waiting, rate limited, canceled, completed, with errors by step, a Retries column and a manual Retry). A failure must say why in the row (GitHub merge queue).
8. Automation must stay **visible and reversible**. Google Ads shows, for each auto-applied type, the count for the last 7 days, the last run, who turned it on and when, with Disable and Undo. Gmail's 5–30 s "undo send" is the model for the existing stop window.
9. Trust grows per kind of action, not per agent. Experienced users auto-approve twice as often (20% → 40%) but also interrupt more often. Graduated-autonomy designs promote slowly and demote at once after one mistake. Nexus should **suggest** a promotion and never take it on its own.
10. Anti-patterns: rubber-stamping (an approval rate above 90%), flooding (OWASP "Overwhelming HITL"), previews written by the agent (OWASP "Lies-in-the-Loop"), hidden auto-actions (Google Ads auto-apply backlash), denylists treated as safety (Cursor dropped its denylist), and irreversible bulk actions.

## Key numbers

| Number | What it says | Source |
| :- | :- | :- |
| 93% | Share of Claude Code permission prompts that users approve: the main reason auto mode exists | [Anthropic, auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode) |
| 3 in a row / 20 total | Auto-mode blocks after which Claude Code stops and asks the person again | [Claude Code docs, permission modes](https://code.claude.com/docs/en/permission-modes) |
| 20% → 40%+ | Sessions with full auto-approve, from new users (<50 sessions) to experienced users (750 sessions) | [Anthropic, measuring agent autonomy](https://www.anthropic.com/research/measuring-agent-autonomy) |
| 5% → 9% | Share of turns in which users interrupt. Experienced users interrupt *more*: they watch and step in instead of approving each action | same |
| 6 months | Past data a Stripe Radar rule is tested against before it goes live | [Stripe Radar rules](https://docs.stripe.com/radar/rules) |
| 14 days | Lifetime of an Amazon Ads recommendation before it expires | [Amazon Ads, campaign recommendations](https://advertising.amazon.com/library/guides/practice-guide-to-campaign-recommendations) |
| 7 days | Time a Perpetua "Dismiss" mutes the same recommendation | [Perpetua help](https://help.perpetua.io/en/articles/4332332-recommendations-and-strategies) |
| 5/10/20/30 s | Gmail undo-send window choices | [Google blog](https://blog.google/products/gmail/how-to-unsend-email-gmail/) |
| 100 | Most UiPath Action Center tasks a person can bulk edit at once | [UiPath, managing actions](https://docs.uipath.com/action-center/automation-cloud/latest/user-guide/managing-actions) |
| 50 actions | Rolling window AWS's graduated-autonomy design scores before promoting an agent; it demotes at once | [AWS architecture blog](https://aws.amazon.com/blogs/architecture/closing-the-ai-agent-trust-gap-with-graduated-autonomy/) |
| >90% | Approval rate at which an "approval budget" says to retire that class of prompt into a rule | [Ready Solutions, approval budget](https://readysolutions.ai/blog/2026-06-12-approval-fatigue-attention-budget/) |

---

## 1. Queue layout

### 1.1 A table with a detail panel, not cards
- **What:** One row per item, checkboxes, sortable columns and a side panel or drawer for the full detail. Cards and chat threads look friendly but show 3–5 items per screen. A table shows 20–40.
- **Who:** Amazon Ads recommendations are a table: values are preselected, any line can be edited, and you apply by type or all at once ([Amazon Ads](https://advertising.amazon.com/library/guides/practice-guide-to-campaign-recommendations)). UiPath Action Center has a Pending tab table with bulk assign and a colour-coded due status ([UiPath](https://docs.uipath.com/action-center/automation-cloud/latest/user-guide/managing-actions)). Shopify Flow's run list has the columns Start time, Run status, Results, Retries and Trigger type ([Shopify Flow monitor](https://help.shopify.com/en/manual/shopify-flow/manage/monitor)). LangChain's Agent Inbox is the counter-example: an email-style inbox with one thread at a time and no bulk actions ([agent-inbox](https://github.com/langchain-ai/agent-inbox)).
- **Fits:** The Owner already works in the product sheet grid. Claude produces bursts of similar requests (40 listing prices, 12 bids), which suits a table and suits cards badly.
- **Risk:** A dense table invites "select all → approve". Keep bulk limits (§6) and a readable before → after cell. A grid without a detail panel hides long text such as buyer messages and descriptions.

### 1.2 Grouping: by Claude plan by default, then by kind, then by product
- **What:** Collapsible groups, each with its own counted action ("Approve 12").
- **Who:** Perpetua lists recommendations **by strategy**, with select-all per strategy ([Perpetua](https://help.perpetua.io/en/articles/4332332-recommendations-and-strategies)). Amazon Ads applies **by recommendation type**. LangChain presents every interrupt from one agent turn **as one batch**, decided together and in order ([LangChain HITL](https://docs.langchain.com/oss/python/langchain/human-in-the-loop)). PagerDuty **groups alerts into one incident** so you are not paged once per alert ([PagerDuty alert grouping](https://support.pagerduty.com/main/docs/time-based-alert-grouping)).
- **Fits:** Nexus already has change plans (up to 200 steps). The plan is the natural unit: "Claude: reprice helmets +5% (40 rows)". Grouping by kind answers "what is waiting for me today". Grouping by product catches two requests that touch the same SKU (price and stock).
- **Risk:** Group-level approve is the fastest path to rubber-stamping. The group header must show the spread (min/max change, e.g. "+3% … +11%") and flag outliers inside the group.

### 1.3 The columns that matter
From the tools above, for one owner:

| Column | Why | Seen in |
| :- | :- | :- |
| Select checkbox | bulk | Amazon Ads, UiPath, PagerDuty |
| Age / expires in | old requests go stale | UiPath SLA colours, Amazon Ads 14-day expiry |
| Kind (plain words: "Listing price", "Ad bid", "Buyer message") | grouping and automation | Google Ads types, Perpetua strategy |
| What: product / listing, channel · market | scope | — |
| **Before → After** (computed, coloured) | the decision itself | Terraform plan, Amazon Ads |
| Why (Claude's one-line reason, plain text) | context | Copilot Studio AI rationale, Perpetua autopilot logs |
| Decided by: You / Rule "name" / Claude (code) / Expired | accountability | Google Ads history, Copilot Studio stages |
| Status (waiting → … → reached the channel) | progress | Shopify Flow, GitHub merge queue |
| Row actions: Approve · Reject · Edit · Automate… | speed | Perpetua (Approve/Edit/Dismiss), Agent Inbox (Accept/Edit/Respond/Ignore) |

### 1.4 Before → after preview, computed by Nexus and pinned to what you saw
- **What:** Show the change as a diff (`€49.90 → €52.40 (+5.0%)`, `stock 12 → 0`, `title: changed 14 words`) and a one-line summary at the top ("12 prices up, 2 down, 0 listings closed"). Approving runs **exactly** the reviewed change. If the data changed since the preview, the row needs a fresh look.
- **Who:** Terraform's `+ ~ -` symbols and its summary line "Plan: 1 to add, 0 to change, 0 to destroy". `terraform apply plan.tfplan` applies exactly the saved plan, which blocks drift between review and run ([Spacelift on terraform plan](https://spacelift.io/blog/terraform-plan)). Smashing's "Intent Preview" says to write "Cancel flight AA123 to San Francisco", not "cancel_booking(id: 4A7B)" ([Smashing, 2026-02](https://www.smashingmagazine.com/2026/02/designing-agentic-ai-practical-ux-patterns/)).
- **Fits:** A price or stock change is a small, exact diff and suits a grid cell. Nexus products have a version, so a "stale" mark is cheap.
- **Risk:** **Never build the preview from Claude's own text.** OWASP's "Lies-in-the-Loop" attack pads or forges the approval dialog with agent-supplied text and Markdown. The advice is not to render the agent's Markdown and to protect the action metadata ([OWASP](https://community.owasp.org/attacks/Lies_in_the_Loop)). Show Claude's reason as plain, clearly labelled text, separate from the computed diff.

---

## 2. Speed

### 2.1 One-key triage
- **What:** j/k move; one key approves, rejects, edits, snoozes; z undoes the last decision; `?` shows the keys.
- **Who:** Linear Triage: `1` accept, `2` decline, `3` duplicate, `H` snooze ([Linear triage](https://linear.app/docs/triage)). Superhuman: `j`/`k`, `e` done, `h` remind, `z` undo ([Superhuman shortcuts](https://download.superhuman.com/Superhuman%20Keyboard%20Shortcuts.pdf)). Claude Code: `Tab` on Yes/No adds a note to Claude, `Esc` cancels ([Claude Code permissions](https://code.claude.com/docs/en/permissions)).
- **Fits:** One owner and many similar rows. Keys make 40 rows a one-minute job and work alongside the grid's existing keyboard model.
- **Risk:** Speed lowers attention. Keep `z` undo of the *decision* (before it runs) and never bind a bulk approve to a single unmodified key.

### 2.2 Approve a group or a type, with a counted button
- **What:** "Approve 12 listing prices" on the group header or after a multi-select. The button says the count and the kind.
- **Who:** Amazon Ads (apply by type), Perpetua (select all, accept or dismiss many), PagerDuty (bulk acknowledge, resolve, merge, snooze — [service profile](https://support.pagerduty.com/main/docs/service-profile)), UiPath (bulk, capped at 100).
- **Fits:** Claude's work arrives as batches of one kind, so this matches the PSIE dialog pattern the Owner liked: one summary, one table, a counted primary button, Done with Undo.
- **Risk:** Irreversible kinds (refunds, buyer messages, deletes) must be excluded from bulk or need a second step. Cap the batch size (UiPath caps at 100).

### 2.3 Edit, then approve
- **What:** Change the proposed value in the cell, then approve. The edited value runs and the row shows "edited by you".
- **Who:** Perpetua "Edit" ([help](https://help.perpetua.io/en/articles/4332332-recommendations-and-strategies)), Amazon Ads (edit any line item), Zapier (lets the reviewer edit the request, [Zapier HITL](https://help.zapier.com/hc/en-us/articles/38731463206029-Request-approval-to-keep-your-workflow-running-with-Human-in-the-Loop)), LangChain `edit` decision.
- **Fits:** "Right idea, wrong number" is the most common case for prices and bids. It saves a round trip through Claude.
- **Risk:** LangChain warns to edit "conservatively": an edited call can confuse the agent's own plan. Tell Claude the final value through approval-status.

### 2.4 Reject with a reason that goes back to Claude
- **What:** Reject has an optional one-line reason. Claude reads it and adjusts its next step.
- **Who:** LangChain: the reject `message` "is added to the conversation as feedback"; with no message, the default tells the model not to retry the same call ([LangChain HITL](https://docs.langchain.com/oss/python/langchain/human-in-the-loop)). Claude Code: "No" plus `Tab` comment. Auto mode returns the rule it matched, e.g. `[Data Exfiltration]` ([permission modes](https://code.claude.com/docs/en/permission-modes)).
- **Fits:** Without a reason, Claude tends to ask again in a slightly different form, which creates more approvals.
- **Risk:** None worth noting. Keep the field optional so it does not slow things down.

### 2.5 Snooze or "not now"
- **What:** Hide a request until a time, or mute a kind of suggestion for N days.
- **Who:** Perpetua "Dismiss" mutes that recommendation for 7 days. Linear "Snooze" returns the item at a chosen time or on new activity. PagerDuty snooze offers 1/4/8/24 h.
- **Fits:** Some requests are right but untimely (a price change before a sale event).
- **Risk:** A snoozed request must not quietly expire. Show it in the health header ("2 snoozed").

### 2.6 Smart defaults
- **What:** Preselect the safe choice, sort by what needs you first (failed, then expiring soon, then oldest), and default the group view to "waiting for me".
- **Who:** Amazon Ads preselects recommendations ("preselezionati"). UiPath colours the due status. Stripe's review queue is "a prioritized list" ([Stripe reviews](https://docs.stripe.com/radar/reviews)).
- **Fits:** The Owner opens the page to act, so the default view should be the work.
- **Risk:** A preselected checkbox is a default to approve. Preselect only reversible kinds.

---

## 3. From the queue to automation

### 3.1 Three states per kind: Always allow · Needs approval · Blocked
- **What:** Every kind of request carries one of three settings. Deny beats ask, and ask beats allow.
- **Who:** Claude.ai connectors: Always allow / Needs approval / Blocked, per tool or per group of tools ([Claude support](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities)). Claude Code: allow / ask / deny rules, where "an allow rule can't carve an exception out of a deny rule" ([permissions](https://code.claude.com/docs/en/permissions)). MCP tool annotations (`readOnlyHint`, `destructiveHint`) are hints clients use to decide when to skip a prompt, not a security control ([MCP annotations overview](https://mcpblog.dev/blog/2026-03-13-mcp-tool-annotations)).
- **Fits:** Nexus already has the middle state and two variants of "allow" (run by rule; confirm in Claude). The page only needs one clear switch per kind.
- **Risk:** Too many states confuse. Keep the Nexus words: **Ask me · Run by rule · Confirm in Claude · Off**.

### 3.2 "Automate this kind…" from the row, scoped to what you can see
- **What:** A row action opens a small rule form, pre-filled from that row: kind, channel/market, product filter and limits. The rule covers only what the form shows.
- **Who:** Claude Code's prompt offers "Yes, and don't ask again for: npm test *". It offers that option *only when the prompt can show everything it would allow*, so a saved rule covers only what its option named ([permissions](https://code.claude.com/docs/en/permissions)). The OpenAI Agents SDK has `alwaysApprove`, sticky for the current run only ([OpenAI Agents JS HITL](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)). Linear Triage Intelligence can auto-apply per property type, narrowed by filters ([Linear](https://linear.app/docs/triage-intelligence)).
- **Fits:** This is exactly the per-row "automate this" the Owner described. Starting from a real request makes the scope concrete.
- **Risk:** A rule that is too broad ("all prices") from one click. Default to the narrowest scope (this kind + this channel/market + limits) and make widening explicit.

### 3.3 Limits inside the rule
- **What:** A rule auto-runs only inside limits, for example price change ≤ ±5%, never below cost or the min price, stock change ≤ 20 units, bid ≤ €1.50, ≤ 50 runs a day. Anything outside the limits falls back to "Ask me".
- **Who:** Copilot Studio multistage approvals: a condition auto-approves expenses under $5,000 and sends larger ones to a manager ([Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-copilot-studio/flows-advanced-approvals)). Amazon Automate Pricing *requires* a minimum price per SKU and recommends a maximum ([Amazon](https://sell.amazon.com/blog/automate-pricing-rules)).
- **Fits:** Sellers already think in floors, ceilings and percentages, and Nexus already has price bounds and ad guardrails to reuse.
- **Risk:** Limits that are only checked in the UI. They must be checked server-side at run time, on the real values.

### 3.4 Test the rule on history before turning it on
- **What:** The rule form shows what the rule would have done over the last 30–90 days of requests, for example "would have auto-run 34 of 40; you rejected 2 of those (show them)".
- **Who:** Stripe Radar runs a candidate rule against 6 months of past payments and summarises how many would match, by outcome ([Stripe Radar rules](https://docs.stripe.com/radar/rules)).
- **Fits:** Nexus stores every past request and its decision, so this costs little and is very convincing. It also catches the rule that would have approved something the Owner rejected.
- **Risk:** Few past rows make the test weak. Show "based on N requests" and hide the test below about 10.

### 3.5 Trust that grows, but only with the Owner's yes
- **What:** Nexus tracks a record per kind (approved unchanged, edited, rejected, undone, failed). When the record is clean it *suggests* a promotion ("You approved 25 of 25 listing-price requests unchanged in 30 days. Run them by rule within ±5%?"). One undo or failure demotes the kind to "Ask me" at once, and tells the Owner.
- **Who:** Anthropic: auto-approve grows from about 20% to over 40% of sessions with experience, and experienced users interrupt more ([Anthropic research](https://www.anthropic.com/research/measuring-agent-autonomy)). AWS graduated autonomy: a rolling window of 50 actions, slow promotion, immediate demotion ([AWS](https://aws.amazon.com/blogs/architecture/closing-the-ai-agent-trust-gap-with-graduated-autonomy/)). Feng, McDonald & Zhang define levels from operator to observer, with L4 "approver" = the user is engaged only in risky or pre-specified cases ([arXiv 2506.12469](https://arxiv.org/abs/2506.12469)). Smashing's "Autonomy Dial" works per task type: "trust is not a binary switch" ([Smashing](https://www.smashingmagazine.com/2026/02/designing-agentic-ai-practical-ux-patterns/)). GitHub keeps human approval of Copilot's workflow runs as the default; admins may opt out ([GitHub changelog 2026-03-13](https://github.blog/changelog/2026-03-13-optionally-skip-approval-for-copilot-coding-agent-actions-workflows/)).
- **Fits:** It fits the Owner's rule that automation must keep his control: the system proposes and he decides.
- **Risk:** Auto-promotion without consent (do not build it). A suggestion that nags (show it once per kind per month, and allow "don't suggest again").

### 3.6 Expiry of requests and rules
- **What:** Waiting requests expire (for example after 7 days, shown as "expires in 2 d"). Rules can carry an optional end date ("until 31 Oct") and a review reminder.
- **Who:** Amazon Ads recommendations expire after 14 days. Perpetua's dismiss lasts 7 days. Claude Code file-edit approvals last until the session ends. OpenAI's `alwaysApprove` lasts for one run.
- **Fits:** Prices and stock go stale fast. A 6-day-old price request is usually wrong today. Seasonal rules (sale weeks) should end on their own.
- **Risk:** Silent expiry. Claude must read "expired" through approval-status, and the Owner sees it in the header.

### 3.7 Show who decided: a person, a rule or a code
- **What:** Every row and every timeline entry names the decider: **You**, **Rule "Price ±5% IT"** (linked), **Claude + your code** (confirm in Claude) or **Expired**. Each rule shows its own record: runs in the last 7 days, last run, who turned it on and when.
- **Who:** Google Ads auto-apply History shows "how many times that recommendation has been applied in the past week, when it was last applied, and when you first turned it on". It also shows which user opted in, a Disable button and a weekly e-mail summary ([Google Ads help](https://support.google.com/google-ads/answer/10276359?hl=en)). Perpetua's autopilot logs record every bid change with the reason. Copilot Studio stores each AI stage's decision and rationale in the approval history.
- **Fits:** This answers the Owner's "what is happening" without asking Claude.
- **Risk:** Mixing rule runs into the waiting list. By default show them under a "Ran by rule" filter and count them in the header.

### 3.8 Stop and undo instead of warnings
- **What:** A rule-run row shows a countdown ("runs in 0:45 — Stop"). After it runs: "Undo" where Nexus can put the change back (undo-change). One switch per kind turns a rule off. A global "Pause all rules" is the emergency stop.
- **Who:** Gmail undo send (5–30 s window). Aza Raskin's "Never use a warning when you mean undo": people get used to OK buttons, while undo really works ([A List Apart](https://alistapart.com/article/neveruseawarning/)). Google Ads change history has Undo for each auto-applied change. Smashing's "Action Audit & Undo" sets a target reversion rate below 5%. Claude Code's circuit breaker falls back to asking after 3 blocks in a row or 20 in total.
- **Fits:** Nexus already has the stop window and undo-change, so the page only has to show them.
- **Risk:** Undo that cannot really undo (a sent buyer message, a refund, an eBay relist that creates a new Item ID). Mark those rows "cannot be undone" and keep them out of rules.

---

## 4. Not blocking the agent

### 4.1 Ask, get an id, keep working
- **What:** A change request returns at once with an id. The agent carries on with other work and checks the status later. The paused work survives restarts.
- **Who:** The OpenAI Agents SDK returns interruptions and lets you save `RunState` and resume later ([OpenAI Agents JS](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)). Cloudflare Agents' "durable-pause" parks the action until `approveExecution()` is called from any dashboard ([Cloudflare](https://developers.cloudflare.com/agents/concepts/agentic-patterns/human-in-the-loop/)). Temporal and Inngest wait hours or days without holding compute ([Temporal cookbook](https://docs.temporal.io/ai-cookbook/human-in-the-loop-python), [Inngest](https://www.inngest.com/docs/ai-patterns/human-in-the-loop)). LangChain's "ambient agents" run in the background and ask only when needed ([LangChain](https://www.langchain.com/blog/ux-for-agents-part-2-ambient)).
- **Fits:** Nexus already works this way (approvalId + approval-status). The page's job is to make the decision fast, not to keep Claude waiting.
- **Risk:** Claude piling up many dependent requests (a stock change after a price change on the same SKU). Show the dependency or the same-product grouping (§1.2).

### 4.2 Tell the agent exactly what happened, in separate words
- **What:** approval-status returns distinct states with plain reasons: `waiting`, `approved` (by you / by rule), `edited` (final value), `rejected` (+ reason), `expired`, `stopped`, `running`, `done`, `failed` (+ channel error).
- **Who:** Zapier makes the timeout outcome an explicit setting: "Skip and continue" or "End run" ([Zapier](https://help.zapier.com/hc/en-us/articles/38731463206029-Request-approval-to-keep-your-workflow-running-with-Human-in-the-Loop)). Inngest's `waitForEvent` returns null on timeout, which is distinct from a rejection. Claude Code auto mode tells the agent the matched rule, and the agent "should recover and try a safer approach" ([Anthropic](https://www.anthropic.com/engineering/claude-code-auto-mode)).
- **Fits:** It keeps Claude honest in chat ("the price change is still waiting" vs "you rejected it: too high").
- **Risk:** Claude retrying a rejected request in a new form. The rejection text should say "do not ask again unless the person asks".

### 4.3 Notifications: one badge and a digest, not a ping per request
- **What:** A count badge in the Nexus navigation. One push or e-mail when something new waits *and* has not been seen for X minutes, with a reminder later. A daily or weekly summary of what rules did.
- **Who:** Zapier sends the request by e-mail or Slack, with a configurable reminder. n8n's "send and wait for response" puts Approve/Decline buttons into Slack, Gmail, Telegram, Teams and WhatsApp ([n8n](https://docs.n8n.io/build/integrate-ai/ai-examples/human-in-the-loop-for-tools)). Copilot Studio approvals are answered in Teams or Outlook. Google Ads e-mails a weekly auto-apply summary. PagerDuty groups alerts so later ones do not notify again.
- **Fits:** For one owner, a ping per request becomes noise within a day. A digest plus a badge respects his attention.
- **Risk:** Approve buttons inside e-mail or chat skip the before → after view. If a notification has buttons, keep them to reversible kinds and link to the row for everything else.

### 4.4 A plan is one decision unit
- **What:** Claude sends many steps as one plan. The page shows the plan as one group with its total diff; you approve all, some or none.
- **Who:** LangChain batches all interrupts from one turn and the human answers each in order. Terraform presents a whole change set with one summary line.
- **Fits:** Nexus's submit-change-plan (up to 200 steps) and the change-plan skill already produce this.
- **Risk:** A 200-step plan is too long to read. Show the summary, then the outliers first (the largest % change, any close or delete, any irreversible step).

---

## 5. Progress and problems

### 5.1 One status column with the whole life of a request
- **What:** Waiting → Approved / By rule (stop window) → Running → **Reached the channel** (confirmed) — or Failed / Rejected / Expired / Stopped. "Done" means the channel confirmed it, not that Nexus sent it.
- **Who:** Shopify Flow run statuses: In progress (also covers retrying), Waiting, Rate limited, Canceled, Completed. Its Results column lists actions and errors by step, and a Retries column sits beside it ([Shopify Flow monitor](https://help.shopify.com/en/manual/shopify-flow/manage/monitor)). A GitHub merge-queue entry merges only after checks pass; when it is removed, the timeline says why ([GitHub docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)).
- **Fits:** The Owner's main question is "did it reach Amazon/eBay?". Nexus already tracks channel pushes and publication status.
- **Risk:** Too many states. Show 5 colours (waiting, running, done, failed, no action), with the exact state in a tooltip or the detail panel.

### 5.2 Errors in plain words, in the row, with Retry
- **What:** The failed row says what went wrong and what to do ("eBay refused: price below the promotion floor — edit price or end promotion"), with Retry and "Ask Claude to fix".
- **Who:** Shopify Flow manual retry of one run or many after the cause is fixed, and bulk cancel of runs that are waiting or retrying ([Shopify retry](https://help.shopify.com/en/manual/shopify-flow/manage/manual-retry)). Claude Code's "Recently denied" tab lists blocked actions; pressing `r` retries with a manual approval ([permission modes](https://code.claude.com/docs/en/permission-modes)).
- **Fits:** Channel errors are cryptic (Amazon codes, eBay error ids), and the Owner should not have to read logs.
- **Risk:** A retry that repeats a non-idempotent action (a second message, a second label). Allow Retry only for idempotent kinds.

### 5.3 A health strip on top
- **What:** One line: "**3 waiting** · **1 failed** · 12 ran by rule today · 2 snoozed · oldest waiting 3 h". Each number is a filter.
- **Who:** Terraform's one-line plan summary. Google Ads' "applied in the past week" counts. UiPath's due status. Shopify Flow's Errors filter.
- **Fits:** It meets the Owner's "at a glance" goal and costs almost nothing to build.
- **Risk:** Counts that disagree with the rows (cache). Compute them from the same query.

### 5.4 An activity timeline per request and per rule
- **What:** The detail panel shows: asked by Claude (conversation link) → preview → decided by → running → channel reply → undo, if any.
- **Who:** Perpetua's Activity Stream, filterable by Applied/Dismissed. Smashing's "Action Audit". Google Ads change history with Undo.
- **Fits:** It answers "who changed this price and why" weeks later.
- **Risk:** None worth noting. Keep it in the detail panel, not in the grid.

---

## 6. Anti-patterns to avoid

| Anti-pattern | Evidence | What to do instead |
| :- | :- | :- |
| **Toll-booth approvals** (everything asks) | 93% of Claude Code prompts approved ([Anthropic](https://www.anthropic.com/engineering/claude-code-auto-mode)); "a gate that opens 93 times out of 100 is not a gate" ([approval budget](https://readysolutions.ai/blog/2026-06-12-approval-fatigue-attention-budget/)) | Show the approval rate per kind; above 90% unchanged, *suggest* a rule (§3.5) |
| **Flooding** hides the one bad request | OWASP "Overwhelming HITL": an attacker floods reviewers with low-risk requests, then slips in a risky one ([OWASP Agentic Threats](https://www.aigl.blog/content/files/2025/04/Agentic-AI---Threats-and-Mitigations.pdf)) | Group, flag outliers inside groups, keep irreversible kinds out of bulk |
| **Agent-written preview** | OWASP "Lies-in-the-Loop": padded or forged dialogs ([OWASP](https://community.owasp.org/attacks/Lies_in_the_Loop)) | Nexus computes the diff from the payload; Claude's text is plain and labelled |
| **Blanket friction** (a ±1% price change and a refund get the same gate) | Approval-budget tiers: ask only for irreversible, outward-reaching or scope-widening actions | Per-kind settings (§3.1) and limits (§3.3) |
| **Hidden auto-actions** | Google Ads auto-apply backlash: unexpected keyword/budget changes, "accidental activation" ([HawkSEM](https://hawksem.com/blog/google-ads-auto-apply/)) | Opt-in per kind, "By rule" label, rule history, weekly summary (§3.7) |
| **Denylist as safety** | Cursor deprecated its auto-run denylist after bypasses; its allowlist is "best-effort, not a security boundary" ([Backslash](https://www.backslash.security/blog/cursor-ai-security-flaw-autorun-denylist)) | Rules are allowlists with limits; default = ask |
| **Irreversible bulk** | Raskin: people get used to warnings ([A List Apart](https://alistapart.com/article/neveruseawarning/)); UiPath caps bulk at 100 | Exclude non-undoable kinds from bulk; cap batch size; Undo for the rest |
| **Silent timeouts** | Inngest/Zapier treat timeout as its own outcome | "Expired" state, visible to both Claude and the Owner |
| **Stale approval** (you approved a price on yesterday's data) | Terraform applies only the saved plan | Pin the approval to the previewed version; if the data changed, mark it "needs a new look" |
| **Auto-promoted trust** | Expectation gaps hurt: users who expected autopilot spent ~6 h/week approving Teikametrics suggestions *(review site: [SellerStack](https://www.sellerstack.ai/compare/teikametrics))*; GitHub keeps approval by default | Suggest promotion, the Owner decides; demote at once on an undo or failure |
| **Approval ≠ detection** | A review of 21 production agent systems finds approval stuck "between approval fatigue and uncontrolled agent autonomy" ([arXiv 2605.24309](https://arxiv.org/abs/2605.24309)) | Hard server-side limits do the safety; the page is for intent and speed |

---

## Mapping to what Nexus already has (from the MCP server's own description)
- *Change tool returns a preview + approvalId* → §1.4 and §4.1. Make sure the grid shows the **computed** diff.
- *Run by rule with a short stop window* → §3.3, §3.7, §3.8. The grid needs the countdown, a Stop button, a "By rule" label and per-rule history.
- *Confirm in Claude (6-digit code)* → a fourth decider label ("Claude + your code"). Keep it for high-risk kinds (refunds, buyer messages) as a step-up, not as a convenience.
- *approval-status, undo-change, change plans* → §4.2, §3.8, §4.4. The page shows the same states Claude reads.

## TOP 10 for the Approvals grid (simplest first)
1. One row per request with a Nexus-computed **before → after** cell and Claude's reason as plain labelled text, never rendered Markdown.
2. A **health strip** on top: "3 waiting · 1 failed · 12 ran by rule today · oldest 3 h". Each number is a filter.
3. One **status column** for the whole life: waiting → approved/by rule → running → reached the channel / failed (plain words + Retry).
4. A **"Decided by"** column: You · Rule "name" (linked) · Claude + your code · Expired.
5. **Keyboard triage**: j/k, a approve, r reject (optional reason sent back to Claude), e edit value, x select, z undo the last decision.
6. **Group by Claude plan** (default), kind or product, with a counted "Approve 12 listing prices" button; outliers flagged inside the group.
7. **Edit, then approve** in the cell. Claude reads the final value and every outcome (approved, edited, rejected + reason, expired, stopped) through approval-status.
8. Keep **irreversible kinds** (refunds, buyer messages, deletes/closes) out of bulk and rules, cap bulk size, and show Stop during the window and Undo afterwards where undo-change exists.
9. A per-row **"Automate this kind…"** pre-filled from the row (channel/market + limits such as ±% price, max qty), with a history test: "would have run 34 of 40; you rejected 2".
10. **Suggested trust**: after a clean record (e.g. 25/25 approved unchanged in 30 days), Nexus *offers* a rule and the Owner decides; one undo or failure demotes the kind to "Ask me" at once.
