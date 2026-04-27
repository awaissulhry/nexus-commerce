'use client';

/**
 * Phase 30: Attribute Lock Toggle Component
 * 
 * Allows users to lock/unlock individual attributes on child variations
 * Locked attributes won't inherit from parent product
 */

import { useState, useCallback } from 'react';
import { Lock, Unlock } from 'lucide-react';

interface AttributeLockToggleProps {
  childVariationId: string;
  attributeName: string;
  isLocked: boolean;
  onToggle: (childId: string, attrName: string, locked: boolean) => Promise<void>;
  disabled?: boolean;
}

export default function AttributeLockToggle({
  childVariationId,
  attributeName,
  isLocked,
  onToggle,
  disabled = false,
}: AttributeLockToggleProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      await onToggle(childVariationId, attributeName, !isLocked);
    } catch (err: any) {
      setError(err.message || 'Failed to toggle attribute lock');
    } finally {
      setLoading(false);
    }
  }, [childVariationId, attributeName, isLocked, onToggle]);

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleToggle}
        disabled={disabled || loading}
        className={`p-1.5 rounded transition-colors ${
          isLocked
            ? 'bg-amber-100 text-amber-700 hover:bg-amber-200'
            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
        } disabled:opacity-50 disabled:cursor-not-allowed`}
        title={isLocked ? 'Unlock to inherit from parent' : 'Lock to prevent inheritance'}
      >
        {isLocked ? (
          <Lock size={16} />
        ) : (
          <Unlock size={16} />
        )}
      </button>
      {error && (
        <span className="text-xs text-red-600">{error}</span>
      )}
    </div>
  );
}
