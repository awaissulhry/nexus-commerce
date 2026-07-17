# EPI.2 — Files & Previews (binding spec)

Second build phase of the approved `EPI-PROPOSAL.md` (Owner 2026-07-17: "Proceed however you recommend"). The Owner's original #1 ask: open images and attachments directly in the inbox, with previews — plus the composer's file ergonomics. Design source: proposal §5.3–5.5 (dossier). Verdicts applied: Gmail lightbox actions + Linear zoom mechanics (BEAT — Front has no lightbox), pdf-native-iframe (ADOPT), Office = card + Drive path (ADAPT), Gmail two-zone drop + GitHub paste (ADOPT).

## Purpose

Every file in a thread is visible where it lives: image thumbnails in the bubble, click-to-open lightbox with keyboard grammar, PDFs in-app, `cid:` inline images finally rendering (closing the FP1 gap + backlog item), a per-conversation Files panel, and a composer that accepts drag/drop/paste and lets internal comments carry files.

## Scope IN

**1. Inline preview route (no new route file):** `GET …/attachments/[attId]?inline=1` streams with `Content-Disposition: inline` + the real Content-Type for an ALLOWLIST only — raster images (jpeg/png/gif/webp/bmp) and `application/pdf`. Everything else (SVG, HTML, Office, unknown) keeps forced-download regardless of the param — XSS posture. Pure `previewKind(mimeType) → "image" | "pdf" | "none"` helper, unit-tested.

**2. `cid:` inline images — migration-free:** new route `GET /api/inbox/[id]/messages/[msgId]/cid/[cid]` (permission `pages.inbox`): ownership-checked, resolves the Content-ID against the Gmail message's MIME parts live, caches bytes under `data/attachments/cid/<msgId>/`, streams inline (raster allowlist only). `MessageBubble` rewrites `src="cid:…"` to that route before srcdoc. CSP evolves: blocked state `img-src 'self' data:` (embedded + our own cid/preview bytes are not tracking pixels — Gmail's model), loaded state adds `https:`. The blocked-state hide + counter now target **remote** (`http`/`https`) images only.

**3. Lightbox** (`_components/Lightbox.tsx`, DS-composed overlay, portal-free fixed layer):
- Opens from any previewable chip/thumbnail; navigates ←/→ across ALL attachments of the conversation (position line "2 of 7").
- Images: zoom (+/−/scroll), pan by drag when zoomed, click or `0` fit↔100%, `space` toggle. PDFs: native browser viewer in an iframe on the inline route. Non-previewable: metadata card (icon · filename · type · size) + Download + Drive actions.
- Header actions: Save-to-Drive (reuses the existing per-attachment call) · Download · Open in new tab · ✕.
- Keys: `Esc` resets zoom first, then closes — never navigates the app (Linear's lesson); `⌘S` downloads. `role="dialog"` + `aria-modal`, focus trapped, focus restored to the trigger on close.
- Deep link `?focus=<conv>&file=<attId>` (URL composer extended; open/close writes it).

**4. Chip thumbnails:** image attachments render as a 72px thumb grid (lazy-loaded from the inline route, object-fit cover) ahead of the non-image chips; click = lightbox. Non-image chips: click = lightbox for PDFs, download for the rest; explicit download icon stays on every chip. EPI.1's repeated-from-earlier expander behavior is preserved for both forms.

**5. Rail Files panel:** new "Files" `Card` (between Conversation and Quotes): every attachment in the thread — image thumb row + file rows, each with preview/download and **"show in conversation"** (scrolls the timeline to the carrying message, brief highlight). Renders only when the thread has attachments.

**6. Composer file ergonomics:**
- **Drag-and-drop:** dragging files over the composer shows a "Drop to attach" overlay (both modes); drop appends to the pending list.
- **Paste-to-attach:** pasting an image/file into the textarea attaches immediately (GitHub pattern).
- **Internal comments can attach files** (FP1 deferral): `/api/comments` gains multipart support (JSON stays for other pages); files stored locally under `data/attachments/comment-<commentId>/`, `Attachment` rows with `entityType:"comment"` (polymorphic fields exist — **no migration**), 15MB total cap (mirror of the reply cap). Comment bubbles render the same chip/thumb row; comment attachments join the Files panel and lightbox ring.
- **FS3 `MentionTextarea` adopted** for comment mode (the registry's remaining composer handoff): typed-@ autocomplete against `/api/users-lite`; reply mode keeps the plain textarea.

## Scope OUT
Views/rules (EPI.3) · templates/undo/scheduled/CC (EPI.4) · in-thread find/read-state (EPI.5) · Office in-app rendering (card + Drive path is the design) · server-side thumbnail generation (client downscale is fine at local scale; FS5 owns streaming if ever needed) · attachment search across the inbox (rides FS5 FTS) · `?msg=` URL anchor (EPI.6 defines it for FC).

## Data & API deltas
**No schema migration.** Route changes: attachment GET gains `?inline=1`; new cid route; `/api/comments` gains multipart branch (same permission). New pure helpers `src/lib/inbox/preview.ts` (`previewKind`, cid extraction/rewrite) — unit-tested.

## RBAC
No new permissions. Inline/cid routes ride `pages.inbox` with the same ownership checks as download; comment attachments ride `comments.create`; strip untouched (no money fields).

## Acceptance targets
- Click an image chip → lightbox <150ms perceived (local cache), ←/→ walks every file incl. comment attachments, Esc-zoom-then-close verified, focus restored.
- A real `cid:` mail renders its inline images in BOTH image states (blocked/loaded) with zero broken boxes; remote-hidden counter counts remote only.
- PDF opens in-app; SVG/Office refuse inline (download only) — verified by response headers.
- Drag-drop + paste attach work in both modes; a comment with a file lands, renders chips, notifies mentions typed via the autocomplete.
- `?file=` deep link opens the lightbox directly; close returns to the clean URL.
- All fences green; headless verify on :3199 (read-only + one disposable comment-with-file on a test thread, removed after; NO reply sends); FS0 harness unaffected (no new list queries).

## Build plan (scoped commits)
EPI2.1 routes + preview lib + cid rendering → EPI2.2 lightbox + thumbnails + deep link → EPI2.3 Files panel → EPI2.4 composer (drop/paste/comment-files/MentionTextarea) → EPI2.5 headless verify + `EPI2-REPORT.md`.
