'use client';

import { useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { getBackendUrl } from '@/lib/backend-url';
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useTranslations } from '@/lib/i18n/use-translations';

interface CreateRuleModalProps {
  onClose: () => void;
  onRuleCreated: () => void;
}

const RULE_TYPES = [
  'MATCH_LOW',
  'PERCENTAGE_BELOW',
  'COST_PLUS_MARGIN',
  'FIXED_PRICE',
  'DYNAMIC_MARGIN',
] as const;

export default function CreateRuleModal({
  onClose,
  onRuleCreated,
}: CreateRuleModalProps) {
  const { t } = useTranslations();
  const [formData, setFormData] = useState({
    name: '',
    type: 'COST_PLUS_MARGIN' as (typeof RULE_TYPES)[number],
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
    setSimulation(null);
  };

  const buildParameters = (): Record<string, any> => {
    switch (formData.type) {
      case 'PERCENTAGE_BELOW':
        return {
          percentageBelow: parseFloat(formData.parameters.percentageBelow || '5'),
        };
      case 'COST_PLUS_MARGIN':
        return {
          marginPercent: parseFloat(formData.parameters.marginPercent || '20'),
        };
      case 'FIXED_PRICE':
        return {
          fixedPrice: parseFloat(formData.parameters.fixedPrice || '0'),
        };
      case 'DYNAMIC_MARGIN':
        return {
          baseMargin: parseFloat(formData.parameters.baseMargin || '15'),
          adjustmentFactor: parseFloat(formData.parameters.adjustmentFactor || '1'),
        };
      default:
        return {};
    }
  };

  const handleSimulate = async () => {
    setSimulating(true);
    setError(null);
    try {
      const res = await fetch(`${getBackendUrl()}/api/pricing-rules/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: formData.type,
          parameters: buildParameters(),
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
      setError(
        err instanceof Error
          ? err.message
          : t('pricing.rules.modal.errors.simulateFailed'),
      );
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
        setError(t('pricing.rules.modal.errors.nameRequired'));
        setLoading(false);
        return;
      }

      await apiClient.createPricingRule({
        name: formData.name,
        type: formData.type,
        description: formData.description || undefined,
        priority: formData.priority,
        minMarginPercent: formData.minMarginPercent
          ? parseFloat(formData.minMarginPercent)
          : undefined,
        maxMarginPercent: formData.maxMarginPercent
          ? parseFloat(formData.maxMarginPercent)
          : undefined,
        parameters: buildParameters(),
      });

      onRuleCreated();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('pricing.rules.modal.errors.createFailed'),
      );
      console.error('Error creating rule:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('pricing.rules.modal.createTitle')}
      size="2xl"
    >
      <form onSubmit={handleSubmit}>
        <ModalBody className="space-y-3">
          {error && (
            <div className="px-3 py-2 bg-rose-50 border border-rose-200 rounded-md inline-flex items-start gap-2 text-base text-rose-700">
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              {t('pricing.rules.modal.name')}
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) =>
                setFormData({ ...formData, name: e.target.value })
              }
              className="w-full h-9 px-3 border border-slate-300 rounded-md text-base focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              placeholder={t('pricing.rules.modal.namePlaceholder')}
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              {t('pricing.rules.modal.type')}
            </label>
            <select
              value={formData.type}
              onChange={(e) => {
                setFormData({
                  ...formData,
                  type: e.target.value as (typeof RULE_TYPES)[number],
                });
                setSimulation(null);
              }}
              className="w-full h-9 px-2 border border-slate-300 rounded-md text-base bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            >
              {RULE_TYPES.map((tp) => (
                <option key={tp} value={tp}>
                  {t(`pricing.rules.type.${tp}`)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              {t('pricing.rules.modal.description')}
            </label>
            <textarea
              value={formData.description}
              onChange={(e) =>
                setFormData({ ...formData, description: e.target.value })
              }
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-base focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              rows={2}
              placeholder={t('pricing.rules.modal.descriptionPlaceholder')}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              {t('pricing.rules.modal.priority')}
            </label>
            <input
              type="number"
              value={formData.priority}
              onChange={(e) =>
                setFormData({ ...formData, priority: parseInt(e.target.value) })
              }
              className="w-full h-9 px-3 border border-slate-300 rounded-md text-base tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              min="1"
              required
            />
            <p className="text-sm text-slate-500 mt-1">
              {t('pricing.rules.modal.priorityHint')}
            </p>
          </div>

          {/* Rule Type Specific Parameters */}
          <div className="bg-slate-50 border border-slate-200 rounded-md p-3 space-y-2">
            <p className="text-sm uppercase tracking-wider text-slate-500 font-semibold">
              {t('pricing.rules.modal.parameters')}
            </p>

            {formData.type === 'PERCENTAGE_BELOW' && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  {t('pricing.rules.modal.percentBelow')}
                </label>
                <input
                  type="number"
                  step="0.1"
                  value={formData.parameters.percentageBelow || '5'}
                  onChange={(e) =>
                    handleParameterChange('percentageBelow', e.target.value)
                  }
                  className="w-full h-9 px-3 border border-slate-300 rounded-md text-base tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                />
              </div>
            )}

            {formData.type === 'COST_PLUS_MARGIN' && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  {t('pricing.rules.modal.marginPercent')}
                </label>
                <input
                  type="number"
                  step="0.1"
                  value={formData.parameters.marginPercent || '20'}
                  onChange={(e) =>
                    handleParameterChange('marginPercent', e.target.value)
                  }
                  className="w-full h-9 px-3 border border-slate-300 rounded-md text-base tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                />
              </div>
            )}

            {formData.type === 'FIXED_PRICE' && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  {t('pricing.rules.modal.fixedPrice')}
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={formData.parameters.fixedPrice || '0'}
                  onChange={(e) =>
                    handleParameterChange('fixedPrice', e.target.value)
                  }
                  className="w-full h-9 px-3 border border-slate-300 rounded-md text-base tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                />
              </div>
            )}

            {formData.type === 'DYNAMIC_MARGIN' && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    {t('pricing.rules.modal.baseMargin')}
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.parameters.baseMargin || '15'}
                    onChange={(e) =>
                      handleParameterChange('baseMargin', e.target.value)
                    }
                    className="w-full h-9 px-3 border border-slate-300 rounded-md text-base tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    {t('pricing.rules.modal.adjustmentFactor')}
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.parameters.adjustmentFactor || '1'}
                    onChange={(e) =>
                      handleParameterChange('adjustmentFactor', e.target.value)
                    }
                    className="w-full h-9 px-3 border border-slate-300 rounded-md text-base tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                {t('pricing.rules.modal.minMarginLabel')}
              </label>
              <input
                type="number"
                step="0.1"
                value={formData.minMarginPercent}
                onChange={(e) =>
                  setFormData({ ...formData, minMarginPercent: e.target.value })
                }
                className="w-full h-9 px-3 border border-slate-300 rounded-md text-base tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                placeholder={t('pricing.rules.modal.optional')}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                {t('pricing.rules.modal.maxMarginLabel')}
              </label>
              <input
                type="number"
                step="0.1"
                value={formData.maxMarginPercent}
                onChange={(e) =>
                  setFormData({ ...formData, maxMarginPercent: e.target.value })
                }
                className="w-full h-9 px-3 border border-slate-300 rounded-md text-base tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                placeholder={t('pricing.rules.modal.optional')}
              />
            </div>
          </div>

          {/* D.2 — Preview impact before commit */}
          {simulation && (
            <div className="border border-blue-200 bg-blue-50/40 rounded-md p-3 space-y-2">
              <div className="text-sm uppercase tracking-wider text-blue-800 font-semibold">
                {t('pricing.rules.modal.preview.title', {
                  n: simulation.summary.scoped,
                })}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-sm">
                <Stat
                  label={t('pricing.rules.modal.preview.evaluated')}
                  value={simulation.summary.evaluated}
                  tone="slate"
                />
                <Stat
                  label={t('pricing.rules.modal.preview.priceUp')}
                  value={simulation.summary.priceUp}
                  tone="emerald"
                />
                <Stat
                  label={t('pricing.rules.modal.preview.priceDown')}
                  value={simulation.summary.priceDown}
                  tone="rose"
                />
                <Stat
                  label={t('pricing.rules.modal.preview.wouldClamp')}
                  value={simulation.summary.wouldClamp}
                  tone="amber"
                />
                <Stat
                  label={t('pricing.rules.modal.preview.avgDelta')}
                  value={`${simulation.summary.avgDelta >= 0 ? '+' : ''}${simulation.summary.avgDelta.toFixed(2)}`}
                  tone="slate"
                />
              </div>
              {simulation.rows.length > 0 && (
                <div className="max-h-48 overflow-y-auto border border-blue-100 rounded">
                  <table className="w-full text-sm">
                    <thead className="bg-blue-100/40 text-blue-900 sticky top-0">
                      <tr>
                        <th
                          scope="col"
                          className="px-2 py-1 text-left font-semibold"
                        >
                          {t('pricing.rules.modal.preview.colSku')}
                        </th>
                        <th
                          scope="col"
                          className="px-2 py-1 text-left font-semibold"
                        >
                          {t('pricing.rules.modal.preview.colWhere')}
                        </th>
                        <th
                          scope="col"
                          className="px-2 py-1 text-right font-semibold"
                        >
                          {t('pricing.rules.modal.preview.colCurrent')}
                        </th>
                        <th
                          scope="col"
                          className="px-2 py-1 text-right font-semibold"
                        >
                          {t('pricing.rules.modal.preview.colProjected')}
                        </th>
                        <th
                          scope="col"
                          className="px-2 py-1 text-right font-semibold"
                        >
                          {t('pricing.rules.modal.preview.colDelta')}
                        </th>
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
                                ? 'text-slate-400'
                                : r.delta > 0
                                  ? 'text-emerald-700'
                                  : r.delta < 0
                                    ? 'text-rose-700'
                                    : 'text-slate-500'
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
        </ModalBody>

        <ModalFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('pricing.rules.modal.cancel')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={handleSimulate}
            loading={simulating}
            disabled={simulating || !formData.name.trim()}
            className="border border-blue-300 text-blue-700 hover:bg-blue-50"
          >
            {simulating
              ? t('pricing.rules.modal.previewing')
              : t('pricing.rules.modal.preview')}
          </Button>
          <Button type="submit" variant="primary" loading={loading} disabled={loading}>
            {loading
              ? t('pricing.rules.modal.creating')
              : t('pricing.rules.modal.create')}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
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
