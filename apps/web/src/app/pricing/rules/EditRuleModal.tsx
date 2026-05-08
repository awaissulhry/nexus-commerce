'use client';

import { useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { PricingRule, apiClient } from '@/lib/api-client';
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useTranslations } from '@/lib/i18n/use-translations';

interface EditRuleModalProps {
  rule: PricingRule;
  onClose: () => void;
  onRuleUpdated: () => void;
}

export default function EditRuleModal({
  rule,
  onClose,
  onRuleUpdated,
}: EditRuleModalProps) {
  const { t } = useTranslations();
  const [formData, setFormData] = useState({
    name: rule.name,
    description: rule.description || '',
    priority: rule.priority,
    minMarginPercent: rule.minMarginPercent || '',
    maxMarginPercent: rule.maxMarginPercent || '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setLoading(true);
      setError(null);

      await apiClient.updatePricingRule(rule.id, {
        name: formData.name,
        description: formData.description || undefined,
        priority: formData.priority,
        minMarginPercent: formData.minMarginPercent
          ? parseFloat(formData.minMarginPercent as string)
          : undefined,
        maxMarginPercent: formData.maxMarginPercent
          ? parseFloat(formData.maxMarginPercent as string)
          : undefined,
      });

      onRuleUpdated();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('pricing.rules.modal.errors.updateFailed'),
      );
      console.error('Error updating rule:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={t('pricing.rules.modal.editTitle')} size="md">
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
              required
            />
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
              rows={3}
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
              required
            />
            <p className="text-sm text-slate-500 mt-1">
              {t('pricing.rules.modal.priorityHint')}
            </p>
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
        </ModalBody>

        <ModalFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('pricing.rules.modal.cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={loading} disabled={loading}>
            {loading
              ? t('pricing.rules.modal.saving')
              : t('pricing.rules.modal.save')}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
