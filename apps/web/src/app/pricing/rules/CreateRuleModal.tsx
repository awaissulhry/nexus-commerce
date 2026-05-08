'use client';

import { useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { getBackendUrl } from '@/lib/backend-url';

interface CreateRuleModalProps {
  onClose: () => void;
  onRuleCreated: () => void;
}

const RULE_TYPES = [
  { value: 'MATCH_LOW', label: 'Match Lowest Price' },
  { value: 'PERCENTAGE_BELOW', label: 'Percentage Below Competitor' },
  { value: 'COST_PLUS_MARGIN', label: 'Cost Plus Margin' },
  { value: 'FIXED_PRICE', label: 'Fixed Price' },
  { value: 'DYNAMIC_MARGIN', label: 'Dynamic Margin' },
];

export default function CreateRuleModal({
  onClose,
  onRuleCreated,
}: CreateRuleModalProps) {
  const [formData, setFormData] = useState({
    name: '',
    type: 'COST_PLUS_MARGIN',
    description: '',
    priority: 1,
    minMarginPercent: '',
    maxMarginPercent: '',
    parameters: {} as Record<string, any>,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // D.2 — Dry-run simulator state. Calls /api/pricing-rules/simulate with
  // the in-progress form definition (no DB write). Renders a panel below
  // the form showing summary stats + per-row projected deltas so the
  // operator sees the impact before clicking Create.
  const [simulating, setSimulating] = useState(false);
  const [simulation, setSimulation] = useState<{
    summary: {
      scoped: number;
      evaluated: number;
      wouldClamp: number;
      priceUp: number;
      priceDown: number;
      avgDelta: number;
    };
    rows: Array<{
      sku: string;
      channel: string;
      marketplace: string;
      currency: string;
      currentPrice: number;
      currentSource: string;
      projectedPrice: number | null;
      delta: number | null;
      wouldClamp: boolean;
      reason: string;
    }>;
  } | null>(null);

  const handleParameterChange = (key: string, value: any) => {
    setFormData({
      ...formData,
      parameters: {
        ...formData.parameters,
        [key]: value,
      },
    });
    // Invalidate simulation when params change so the operator can't read
    // a stale preview against the new form values.
    setSimulation(null);
  };

  // Build the parameters payload the same way handleSubmit does, then call
  // the simulator endpoint. Doesn't touch the DB.
  const handleSimulate = async () => {
    setSimulating(true);
    setError(null);
    try {
      let parameters: Record<string, any> = {};
      switch (formData.type) {
        case 'PERCENTAGE_BELOW':
          parameters = { percentageBelow: parseFloat(formData.parameters.percentageBelow || '5') };
          break;
        case 'COST_PLUS_MARGIN':
          parameters = { marginPercent: parseFloat(formData.parameters.marginPercent || '20') };
          break;
        case 'FIXED_PRICE':
          parameters = { fixedPrice: parseFloat(formData.parameters.fixedPrice || '0') };
          break;
        case 'DYNAMIC_MARGIN':
          parameters = {
            baseMargin: parseFloat(formData.parameters.baseMargin || '15'),
            adjustmentFactor: parseFloat(formData.parameters.adjustmentFactor || '1'),
          };
          break;
      }
      const res = await fetch(`${getBackendUrl()}/api/pricing-rules/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: formData.type,
          parameters,
          minMarginPercent: formData.minMarginPercent
            ? parseFloat(formData.minMarginPercent)
            : null,
          limit: 100,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setSimulation(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to simulate rule');
    } finally {
      setSimulating(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setLoading(true);
      setError(null);

      if (!formData.name.trim()) {
        setError('Rule name is required');
        setLoading(false);
        return;
      }

      // Build parameters based on rule type
      let parameters: Record<string, any> = {};
      switch (formData.type) {
        case 'PERCENTAGE_BELOW':
          parameters = {
            percentageBelow: parseFloat(formData.parameters.percentageBelow || '5'),
          };
          break;
        case 'COST_PLUS_MARGIN':
          parameters = {
            marginPercent: parseFloat(formData.parameters.marginPercent || '20'),
          };
          break;
        case 'FIXED_PRICE':
          parameters = {
            fixedPrice: parseFloat(formData.parameters.fixedPrice || '0'),
          };
          break;
        case 'DYNAMIC_MARGIN':
          parameters = {
            baseMargin: parseFloat(formData.parameters.baseMargin || '15'),
            adjustmentFactor: parseFloat(formData.parameters.adjustmentFactor || '1'),
          };
          break;
        default:
          parameters = {};
      }

      await apiClient.createPricingRule({
        name: formData.name,
        type: formData.type as any,
        description: formData.description || undefined,
        priority: formData.priority,
        minMarginPercent: formData.minMarginPercent ? parseFloat(formData.minMarginPercent) : undefined,
        maxMarginPercent: formData.maxMarginPercent ? parseFloat(formData.maxMarginPercent) : undefined,
        parameters,
      });

      onRuleCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create rule');
      console.error('Error creating rule:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-gray-200 sticky top-0 bg-white">
          <h2 className="text-lg font-bold text-gray-900">Create New Pricing Rule</h2>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded">
              <p className="text-red-800 text-sm">{error}</p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Rule Name *
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) =>
                setFormData({ ...formData, name: e.target.value })
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g., Amazon Competitive Pricing"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Rule Type *
            </label>
            <select
              value={formData.type}
              onChange={(e) =>
                setFormData({ ...formData, type: e.target.value })
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {RULE_TYPES.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Description
            </label>
            <textarea
              value={formData.description}
              onChange={(e) =>
                setFormData({ ...formData, description: e.target.value })
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              rows={2}
              placeholder="Optional description of this rule"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Priority
            </label>
            <input
              type="number"
              value={formData.priority}
              onChange={(e) =>
                setFormData({ ...formData, priority: parseInt(e.target.value) })
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              min="1"
              required
            />
            <p className="text-xs text-gray-500 mt-1">Lower numbers = higher priority (applied first)</p>
          </div>

          {/* Rule Type Specific Parameters */}
          <div className="bg-gray-50 rounded-lg p-4 space-y-3">
            <p className="text-sm font-medium text-gray-700">Rule Parameters</p>

            {formData.type === 'PERCENTAGE_BELOW' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Percentage Below Competitor (%)
                </label>
                <input
                  type="number"
                  step="0.1"
                  value={formData.parameters.percentageBelow || '5'}
                  onChange={(e) =>
                    handleParameterChange('percentageBelow', e.target.value)
                  }
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}

            {formData.type === 'COST_PLUS_MARGIN' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Margin Percentage (%)
                </label>
                <input
                  type="number"
                  step="0.1"
                  value={formData.parameters.marginPercent || '20'}
                  onChange={(e) =>
                    handleParameterChange('marginPercent', e.target.value)
                  }
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}

            {formData.type === 'FIXED_PRICE' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Fixed Price ($)
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={formData.parameters.fixedPrice || '0'}
                  onChange={(e) =>
                    handleParameterChange('fixedPrice', e.target.value)
                  }
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}

            {formData.type === 'DYNAMIC_MARGIN' && (
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Base Margin (%)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.parameters.baseMargin || '15'}
                    onChange={(e) =>
                      handleParameterChange('baseMargin', e.target.value)
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Adjustment Factor
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.parameters.adjustmentFactor || '1'}
                    onChange={(e) =>
                      handleParameterChange('adjustmentFactor', e.target.value)
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Min Margin %
              </label>
              <input
                type="number"
                step="0.1"
                value={formData.minMarginPercent}
                onChange={(e) =>
                  setFormData({ ...formData, minMarginPercent: e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Optional"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Max Margin %
              </label>
              <input
                type="number"
                step="0.1"
                value={formData.maxMarginPercent}
                onChange={(e) =>
                  setFormData({ ...formData, maxMarginPercent: e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Optional"
              />
            </div>
          </div>

          {/* D.2 — Preview impact before commit */}
          {simulation && (
            <div className="border border-blue-200 bg-blue-50/40 rounded-lg p-3 space-y-2">
              <div className="text-sm uppercase tracking-wider text-blue-800 font-semibold">
                Dry-run preview · {simulation.summary.scoped} snapshot rows
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-sm">
                <Stat label="Evaluated" value={simulation.summary.evaluated} tone="slate" />
                <Stat label="Price ↑" value={simulation.summary.priceUp} tone="emerald" />
                <Stat label="Price ↓" value={simulation.summary.priceDown} tone="rose" />
                <Stat label="Would clamp" value={simulation.summary.wouldClamp} tone="amber" />
                <Stat
                  label="Avg Δ"
                  value={`${simulation.summary.avgDelta >= 0 ? '+' : ''}${simulation.summary.avgDelta.toFixed(2)}`}
                  tone="slate"
                />
              </div>
              {simulation.rows.length > 0 && (
                <div className="max-h-48 overflow-y-auto border border-blue-100 rounded">
                  <table className="w-full text-sm">
                    <thead className="bg-blue-100/40 text-blue-900 sticky top-0">
                      <tr>
                        <th className="px-2 py-1 text-left">SKU</th>
                        <th className="px-2 py-1 text-left">Where</th>
                        <th className="px-2 py-1 text-right">Current</th>
                        <th className="px-2 py-1 text-right">Projected</th>
                        <th className="px-2 py-1 text-right">Δ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {simulation.rows.slice(0, 50).map((r, i) => (
                        <tr key={i} className="border-t border-blue-50">
                          <td className="px-2 py-1 font-mono text-xs">{r.sku}</td>
                          <td className="px-2 py-1 text-xs">
                            {r.channel} · {r.marketplace}
                          </td>
                          <td className="px-2 py-1 text-right tabular-nums">
                            {r.currentPrice.toFixed(2)} {r.currency}
                          </td>
                          <td className="px-2 py-1 text-right tabular-nums">
                            {r.projectedPrice != null
                              ? `${r.projectedPrice.toFixed(2)} ${r.currency}`
                              : '—'}
                          </td>
                          <td
                            className={`px-2 py-1 text-right tabular-nums ${
                              r.delta == null
                                ? 'text-gray-400'
                                : r.delta > 0
                                ? 'text-emerald-700'
                                : r.delta < 0
                                ? 'text-rose-700'
                                : 'text-gray-500'
                            }`}
                          >
                            {r.delta == null
                              ? '—'
                              : `${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(2)}`}
                            {r.wouldClamp && (
                              <span className="ml-1 text-amber-700" title={r.reason}>
                                ⚠
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          <div className="flex gap-3 pt-4 border-t border-gray-200">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSimulate}
              disabled={simulating || !formData.name.trim()}
              className="flex-1 px-4 py-2 border border-blue-300 text-blue-700 rounded-lg hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors"
            >
              {simulating ? 'Simulating…' : 'Preview impact'}
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors"
            >
              {loading ? 'Creating...' : 'Create Rule'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone: 'slate' | 'emerald' | 'rose' | 'amber';
}) {
  const toneClasses = {
    slate: 'border-slate-200 bg-white text-slate-700',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    rose: 'border-rose-200 bg-rose-50 text-rose-800',
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
  }[tone];
  return (
    <div className={`border rounded px-2 py-1.5 ${toneClasses}`}>
      <div className="text-base font-semibold tabular-nums">{value}</div>
      <div className="text-xs">{label}</div>
    </div>
  );
}
