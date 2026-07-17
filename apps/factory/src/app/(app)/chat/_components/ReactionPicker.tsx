/**
 * FC4 — the curated emoji picker (Google-Chat hover affordance): a quick row
 * of 8 + a "More" toggle revealing the compact 24-emoji grid (chat/ui.ts owns
 * both lists). A small local popover composed on tokens — the DS has no
 * popover primitive and Menu is an action list, not a grid. Closes on
 * outside-click or Esc; Esc is consumed (preventDefault) so the chat shell's
 * own Esc handler (close thread / focus rail) stays quiet.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { MORE_REACTIONS, QUICK_REACTIONS } from "@/lib/chat/ui";

export function ReactionPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const [more, setMore] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault(); // claim the key — the shell's Esc must not also fire
        onClose();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const pick = (emoji: string) => {
    onPick(emoji);
    onClose();
  };

  return (
    <div ref={ref} className="fc4-picker" role="dialog" aria-label="Add a reaction">
      <div className="fc4-picker-row">
        {QUICK_REACTIONS.map((e) => (
          <button key={e} type="button" className="fc4-picker-btn" onClick={() => pick(e)} aria-label={`React ${e}`}>
            {e}
          </button>
        ))}
        <button
          type="button"
          className="fc4-picker-btn fc4-picker-more"
          onClick={() => setMore((m) => !m)}
          title={more ? "Fewer emoji" : "More emoji"}
          aria-label={more ? "Fewer emoji" : "More emoji"}
          aria-expanded={more}
        >
          {more ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>
      {more && (
        <div className="fc4-picker-grid">
          {MORE_REACTIONS.map((e) => (
            <button key={e} type="button" className="fc4-picker-btn" onClick={() => pick(e)} aria-label={`React ${e}`}>
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
