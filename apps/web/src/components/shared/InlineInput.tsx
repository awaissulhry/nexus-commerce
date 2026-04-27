"use client";

import { useState, useCallback, useRef } from "react";

interface InlineInputProps {
  initialValue: number;
  /** Called on blur/enter with the new numeric value. Return { success } */
  onSave: (value: number) => Promise<{ success: boolean; error?: string }>;
  field: "price" | "stock";
  prefix?: string;
  className?: string;
}

/**
 * Reusable inline-editable numeric input with save-on-blur,
 * spinner, green checkmark, and red X feedback.
 */
export default function InlineInput({
  initialValue,
  onSave,
  field,
  prefix,
  className,
}: InlineInputProps) {
  const [value, setValue] = useState(
    field === "price" ? initialValue.toFixed(2) : String(initialValue)
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(false);
  const originalRef = useRef(initialValue);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSave = useCallback(async () => {
    const numVal = parseFloat(value);
    if (isNaN(numVal) || numVal < 0) {
      setValue(
        field === "price"
          ? originalRef.current.toFixed(2)
          : String(originalRef.current)
      );
      return;
    }

    if (numVal === originalRef.current) return;

    setSaving(true);
    setError(false);
    setSaved(false);

    try {
      const result = await onSave(numVal);

      if (result.success) {
        originalRef.current = numVal;
        setSaved(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setSaved(false), 2000);
      } else {
        setError(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setError(false), 3000);
      }
    } catch {
      setError(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setError(false), 3000);
    } finally {
      setSaving(false);
    }
  }, [value, field, onSave]);

  return (
    <div className={`flex items-center gap-1.5 ${className ?? ""}`}>
      {prefix && <span className="text-gray-500 text-sm">{prefix}</span>}
      <input
        type="number"
        value={value}
        step={field === "price" ? "0.01" : "1"}
        min={0}
        onChange={(e) => setValue(e.target.value)}
        onBlur={handleSave}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            (e.target as HTMLInputElement).blur();
          }
        }}
        className={`w-20 px-2 py-1 text-sm border rounded transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
          error
            ? "border-red-400 bg-red-50"
            : saved
              ? "border-green-400 bg-green-50"
              : "border-gray-300"
        }`}
        disabled={saving}
      />
      <div className="w-5 flex items-center justify-center">
        {saving && (
          <svg
            className="w-4 h-4 text-blue-500 animate-spin"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
        )}
        {saved && !saving && (
          <svg
            className="w-4 h-4 text-green-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2.5}
              d="M5 13l4 4L19 7"
            />
          </svg>
        )}
        {error && !saving && (
          <svg
            className="w-4 h-4 text-red-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2.5}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        )}
      </div>
    </div>
  );
}
