import { toast } from '../lib/toast';
import type {
  AgentKey,
  FeatureDetail,
  FeatureSummary,
  Event,
  Overview,
  Project,
  Settings,
} from './types';

export const MOCK = import.meta.env.VITE_MOCK === '1';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
interface Opts {
  /** do not show an error toast */
  silent?: boolean;
}

let mockModule: Promise<typeof import('./mock')> | null = null;
export function loadMock() {
  if (!mockModule) mockModule = import('./mock');
  return mockModule;
}

function detailText(detail: unknown): string {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => (d && typeof d === 'object' && 'msg' in d ? String((d as { msg: unknown }).msg) : JSON.stringify(d)))
      .join('; ');
  }
  return JSON.stringify(detail);
}

async function request<T>(method: Method, path: string, body?: unknown, opts: Opts = {}): Promise<T> {
  try {
    if (MOCK) {
      const m = await loadMock();
      return (await m.mockRequest(method, path, body)) as T;
    }
    let res: Response;
    try {
      res = await fetch('/api' + path, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, 'Cannot reach the CowCrew server. Is `cowcrew serve` running?');
    }
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const j = (await res.json()) as { detail?: unknown };
        if (j && j.detail !== undefined) msg = detailText(j.detail);
      } catch {
        /* not json */
      }
      throw new ApiError(res.status, msg);
    }
    return (await res.json()) as T;
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError(0, e instanceof Error ? e.message : String(e));
    if (!opts.silent) toast.error(err.message);
    throw err;
  }
}

function qs(params: Record<string, string | number | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const api = {
  health: () => request<{ ok: boolean; version: string }>('GET', '/health', undefined, { silent: true }),

  projects: () => request<Project[]>('GET', '/projects'),
  addProject: (b: { name: string; repo_path: string; github_repo?: string | null }) =>
    request<Project>('POST', '/projects', b),
  deleteProject: (id: number) => request<{ ok: boolean }>('DELETE', `/projects/${id}`),

  overview: (projectId?: number | null, opts?: Opts) =>
    request<Overview>('GET', `/overview${qs({ project_id: projectId })}`, undefined, opts),

  features: (params: { project_id?: number | null; status?: string } = {}) =>
    request<FeatureSummary[]>('GET', `/features${qs(params)}`),
  createFeature: (b: { project_id: number; title: string; spec: string }) =>
    request<FeatureSummary>('POST', '/features', b),
  feature: (id: number, opts?: Opts) => request<FeatureDetail>('GET', `/features/${id}`, undefined, opts),
  events: (id: number, params: { agent?: AgentKey; limit?: number; before_id?: number } = {}, opts?: Opts) =>
    request<Event[]>('GET', `/features/${id}/events${qs({ limit: 200, ...params })}`, undefined, opts),

  answer: (id: number, answers: { id: number; answer: string }[]) =>
    request<FeatureDetail>('POST', `/features/${id}/answers`, { answers }),
  approve: (id: number) => request<FeatureDetail>('POST', `/features/${id}/approve`),
  requestChanges: (id: number, note: string) => request<FeatureDetail>('POST', `/features/${id}/request-changes`, { note }),
  pause: (id: number) => request<FeatureDetail>('POST', `/features/${id}/pause`),
  resume: (id: number) => request<FeatureDetail>('POST', `/features/${id}/resume`),
  stop: (id: number) => request<FeatureDetail>('POST', `/features/${id}/stop`),
  merge: (id: number, b: { commit_message: string; delete_branch: boolean; follow_up_nits: boolean }) =>
    request<FeatureDetail>('POST', `/features/${id}/merge`, b),
  sendBack: (id: number, note: string) => request<FeatureDetail>('POST', `/features/${id}/send-back`, { note }),
  message: (id: number, agent: AgentKey, text: string) =>
    request<{ ok: boolean }>('POST', `/features/${id}/message`, { agent, text }),

  settings: () => request<Settings>('GET', '/settings'),
  saveSettings: (b: Partial<Pick<Settings, 'budget_usd_week' | 'max_attempts' | 'models'>>) =>
    request<Settings>('PUT', '/settings', b),
};
