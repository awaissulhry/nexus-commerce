# Nexus UI work

- Use `apps/web/src/design-system` for all new and changed platform UI. Read
  `DESIGN.md` and the relevant component `.tsx` source before implementing it.
- Compose existing Nexus primitives, components, and patterns first. The older
  `components/ui` kit is migration history, not the source for new UI.
- If a reusable control or pattern is missing, add or extend it in the design
  system, export it, document it in the catalog and changelog, and consume it
  from the feature. Record the gap in `.claude/DS-GAPS.md`.
- Keep feature CSS to layout and domain content. Use semantic `--nds-*` tokens;
  do not restyle shared controls locally or introduce raw palette values.
- Mirror changes to shared design-system files in `apps/factory` without
  overwriting unrelated work. Check types, tokens, keyboard behavior, and
  responsive light/dark presentation. Report unrelated guard failures clearly.
