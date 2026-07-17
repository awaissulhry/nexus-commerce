# EPI2-REPORT — Files & Previews gate report (built to `EPI2-SPEC.md`)

Delivered 2026-07-17. All spec items shipped, **no schema migration**. Verified headlessly on an isolated `:3199` production build: 9 targets PASS, 1 N/A (no `cid:` mail exists in the synced corpus to exercise live — the resolver stays unit-tested and header-proven), and the verifier caught **one real pre-existing bug** (fixed + re-verified same day). ⏳ Awaiting Owner click-through.

## Plain-English summary (what changed for you)

- **You can finally SEE files.** Images in a thread render as thumbnails; click one and a full-screen viewer opens — zoom, pan, arrow through every file in the conversation, Esc to back out (un-zooms first). PDFs open right in the app. Other types show a clean card with Download / Save to Drive.
- **Inline images in email bodies now render** (they were gray boxes since FP1) — and the "images hidden" gate now only counts genuinely remote images, Gmail-style.
- **A Files card in the right rail** lists every file in the conversation — thumbnails, preview, download, and a crosshair that jumps you to the exact message carrying the file.
- **The composer handles files like 2026:** drag-and-drop ("Drop to attach"), paste a screenshot straight in, and **internal notes can carry files now** (they show as chips, join the viewer and the Files card, never leave the building).
- **@mentions autocomplete** in note mode (type `@` + a name) instead of blind-typing handles.
- **Bonus bug killed:** a helper stamped the wrong content-type on file uploads from the UI — the note-with-file path 400'd and the plain reply path was affected the same way. One-line fix, verified live with an intercepted send.

## Files (5 commits)

- EPI2.1 `src/lib/inbox/preview.ts` (+8 tests) · attachment route `?inline=1` allowlist · new cid resolver route · bubble CSP/counter rework
- EPI2.2 `Lightbox.tsx` · bubble thumbnails/preview chips · `?focus=&file=` deep link · dialog-inert key grammar
- EPI2.3 rail `FilesCard` + `data-msg` scroll anchors
- EPI2.4 comments multipart (+local storage, polymorphic Attachment rows, 15MB cap) · comment chips/ring/panel · drag/paste attach · attach-in-both-modes · FS3 `MentionTextarea` adoption (registry handoff closed)
- EPI2.5 `api-client.ts` FormData content-type fix

## Verification

606 tests · rbac 145 routes · no-touch · ds-parity · query-bounds · isolated build — green. Headless: thumbnails (72px, real bytes), full lightbox grammar (nav/zoom/Esc-order/URL/focus-restore/j-k-inert), native PDF in-app, **response-header proof of the allowlist** (image/pdf → `inline`; everything else → `attachment` even with `?inline=1`; no cookie → 401), Files panel + crosshair scroll, paste-chip + drop-overlay, comment-with-file end-to-end (real 201 via UI after the fix; captured `multipart/form-data; boundary=…`), reply path header proven by interception (fulfilled 400 locally — nothing sent, message count unchanged), mention popover. Disposable verify comment fully deleted; sessions revoked; :3100 never touched.

## Findings & deviations (flagged, not hidden)

1. **Pre-existing P0 caught & fixed:** `apiFetch` forced `application/json` onto FormData bodies — the UI reply path has plausibly 400'd since F1 for anyone using it (the golden flow's sends go via the quote-send route, which is JSON — why it never surfaced). Fixed to string-bodies-only; all JSON call-sites unaffected.
2. **cid verification N/A:** the corpus has no `cid:` mail today; the resolver is unit-tested, allowlist-gated, and will light up on the first such mail. Flagged rather than faked.
3. **CLS 0.0464 on thread load** (target ≤0.02) — pre-existing FP1 iframe height-fit behavior (80px → measured after load), not introduced by EPI.2. Candidate fix (persist last-known per-message heights) noted for EPI.5's thread-ergonomics pass.
4. Non-previewable-type inline probe used a `*/*` -mime pdf (no Office file exists in the corpus); the allowlist logic is unit-tested for Office/SVG/HTML regardless.
5. Comment attachments don't appear in Drive save-through (spec'd: local only; Drive save works from the lightbox for message attachments).

## Rollback

Each commit independent; no migration. Reverting EPI2.4 removes multipart comments (JSON comments unaffected); reverting the api-client fix would re-break UI FormData posts — don't.

## Click-through script (Owner)

1. Open the TORINO thread: the suit photo is a thumbnail — click it; arrow through to the PDF (renders in-app); Esc twice. 2. Rail: Files card — click the crosshair on the PDF row. 3. Toggle "Load remote images" on a newsletter: counter counts only remote images. 4. Drag any file onto the composer — overlay + chip; remove it. 5. Paste a screenshot — chip appears. 6. Internal comment + attach a photo → amber bubble with chip; click the chip → viewer shows it in the ring. 7. Type `@` + a teammate's name in a note — pick from the popover. 8. Send one real reply (with an attachment if you like) — it threads in Gmail and no longer risks the content-type 400.
