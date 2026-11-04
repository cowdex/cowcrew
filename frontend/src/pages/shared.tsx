import { useCallback, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { FeatureDetail } from '../api/types';
import { useCrumbs, type Crumb } from '../state/app';
import { useFeatureDetail } from '../state/hooks';

export function useFeaturePage(section: Crumb) {
  const { id } = useParams();
  const fid = Number(id);
  const state = useFeatureDetail(fid);
  useCrumbs([section, { label: state.detail?.feature.title ?? `Feature ${fid}` }]);
  return { id: fid, ...state };
}

/** Runs an API action that returns FeatureDetail; tracks busy state and stores the result. */
export function useAction(setDetail: (d: FeatureDetail) => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async (key: string, fn: () => Promise<FeatureDetail | unknown>): Promise<boolean> => {
      setBusy(key);
      try {
        const r = await fn();
        if (r && typeof r === 'object' && 'feature' in r) setDetail(r as FeatureDetail);
        return true;
      } catch {
        return false;
      } finally {
        setBusy(null);
      }
    },
    [setDetail],
  );
  return { busy, run };
}

export function splitSpec(spec: string): { lead: string; rest: string } {
  const s = spec.trim();
  const m = s.match(/^(.+?[.!?])(\s+|$)([\s\S]*)$/);
  if (!m) return { lead: s, rest: '' };
  return { lead: m[1], rest: m[3].trim() };
}
