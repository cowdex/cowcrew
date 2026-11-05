import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../api/client';
import type { Settings, WorkerAgentKey } from '../api/types';
import { Chip, Loading, Modal } from '../components/ui';
import { relTime } from '../lib/format';
import { AGENT_NAME, WORKER_AGENTS } from '../lib/status';
import { toast } from '../lib/toast';
import { useApp, useCrumbs } from '../state/app';

const MODEL_SUGGESTIONS = ['fable', 'opus', 'sonnet', 'haiku'];

export default function SettingsPage() {
  useCrumbs([{ label: 'Settings' }]);
  const { settings, setSettings } = useApp();
  const loc = useLocation();
  const projRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (loc.hash === '#projects') {
      projRef.current?.scrollIntoView({ block: 'start' });
      projRef.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    }
  }, [loc.hash]);

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h1 className="title" style={{ fontSize: 28 }}>
          Settings
        </h1>
        <p style={{ margin: 0, fontSize: 14, color: '#74717A' }}>Projects, budget and which model each agent uses. Everything stays on this computer.</p>
      </div>
      <div className="row" style={{ gap: 24 }}>
        <div className="col-main">
          <Projects sectionRef={projRef} />
          {settings ? <RunSettings settings={settings} onSaved={setSettings} /> : <Loading />}
        </div>
        <aside className="col-side" aria-label="Status">
          <StatusCard settings={settings} />
        </aside>
      </div>
    </>
  );
}

function Projects({ sectionRef }: { sectionRef: RefObject<HTMLElement> }) {
  const { projects, reloadProjects, setProjectId, projectId } = useApp();
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [gh, setGh] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState<number | null>(null);
  const pathOk = path === '' || path.startsWith('/') || /^[A-Za-z]:\\/.test(path);
  const ghOk = gh === '' || /^[\w.-]+\/[\w.-]+$/.test(gh);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!pathOk || !ghOk) return;
    setBusy(true);
    try {
      const p = await api.addProject({ name: name.trim() || path.split(/[\\/]/).filter(Boolean).pop() || 'project', repo_path: path.trim(), github_repo: gh.trim() || null });
      toast.success(`Added ${p.name} (${p.default_branch}).`);
      setName('');
      setPath('');
      setGh('');
      await reloadProjects();
      setProjectId(p.id);
    } catch {
      /* toast shown */
    } finally {
      setBusy(false);
    }
  };

  const del = projects?.find((p) => p.id === confirmDel);

  return (
    <section ref={sectionRef} id="projects" aria-labelledby="proj-h" className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 4, scrollMarginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 12, borderBottom: '1px solid #E4E3E7' }}>
        <h2 id="proj-h" className="h2">
          Projects
        </h2>
        <span className="label">{projects ? `${projects.length} connected` : ''}</span>
      </div>
      {projects?.length === 0 && <p style={{ margin: '14px 0', fontSize: 14, color: '#45424D' }}>No projects yet. Add a git repository on this computer below.</p>}
      {projects?.map((p) => (
        <div key={p.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, alignItems: 'center', padding: '14px 0', borderBottom: '1px solid #EFEEF1' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>{p.name}</span>
              {p.id === projectId && <Chip kind="done">Current</Chip>}
            </span>
            <span className="mono" style={{ fontSize: 12, color: '#74717A', wordBreak: 'break-all' }}>
              {p.repo_path} · {p.default_branch}
              {p.github_repo ? ` · github.com/${p.github_repo}` : ' · no GitHub remote (CI skipped)'} · added {relTime(p.created_at)} ago
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {p.id !== projectId && (
              <button type="button" className="btn" style={{ minHeight: 36, padding: '0 12px', fontSize: 13 }} onClick={() => setProjectId(p.id)}>
                Switch to
              </button>
            )}
            <button type="button" className="btn btn-danger" style={{ minHeight: 36, padding: '0 12px', fontSize: 13 }} onClick={() => setConfirmDel(p.id)} aria-label={`Remove ${p.name}`}>
              Remove
            </button>
          </div>
        </div>
      ))}
      <form onSubmit={add} style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 18 }} aria-labelledby="add-h">
        <h3 id="add-h" className="label" style={{ color: '#45424D' }}>
          Add project
        </h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, alignItems: 'start' }}>
          <label className="field">
            Name
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="orbit-api" />
          </label>
          <label className="field">
            <span style={{ whiteSpace: 'nowrap' }}>
              GitHub owner/repo <span style={{ fontWeight: 400, color: '#74717A' }}>(optional)</span>
            </span>
            <input className="input mono" value={gh} onChange={(e) => setGh(e.target.value)} placeholder="acme/orbit-api" aria-invalid={!ghOk} />
            {!ghOk && <span style={{ color: '#E24329', fontWeight: 400 }}>Use the form owner/repo</span>}
          </label>
        </div>
        <label className="field">
          Absolute repo path
          <input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/you/code/orbit-api" required aria-invalid={!pathOk} aria-describedby="path-help" />
          <span id="path-help" style={{ fontWeight: 400, color: pathOk ? '#74717A' : '#E24329' }}>
            {pathOk ? 'Must be a git repository. CowCrew detects the default branch.' : 'Use an absolute path, starting with /'}
          </span>
        </label>
        <div>
          <button type="submit" className="btn btn-primary" disabled={busy || !path.trim() || !pathOk || !ghOk}>
            {busy ? 'Adding…' : 'Add project'}
          </button>
        </div>
      </form>
      {del && (
        <Modal title={`Remove ${del.name}?`} onClose={() => setConfirmDel(null)}>
          <p>CowCrew forgets this project and its features. Your repository on disk is not touched.</p>
          <div className="actions">
            <button type="button" className="btn" onClick={() => setConfirmDel(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={async () => {
                try {
                  await api.deleteProject(del.id);
                  toast.info(`Removed ${del.name}.`);
                  await reloadProjects();
                } catch {
                  /* toast shown */
                }
                setConfirmDel(null);
              }}
            >
              Remove project
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function RunSettings({ settings, onSaved }: { settings: Settings; onSaved: (s: Settings) => void }) {
  const tk = settings.billing === 'subscription';
  const storedBudget = tk ? settings.budget_tokens_week ?? 0 : settings.budget_usd_week;
  const [budget, setBudget] = useState(String(storedBudget));
  const [attempts, setAttempts] = useState(String(settings.max_attempts));
  const [models, setModels] = useState<Record<WorkerAgentKey, string>>(settings.models);
  const [busy, setBusy] = useState(false);
  const dirty = Number(budget) !== storedBudget || Number(attempts) !== settings.max_attempts || WORKER_AGENTS.some((a) => models[a] !== settings.models[a]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const s = await api.saveSettings({ ...(tk ? { budget_tokens_week: Number(budget) } : { budget_usd_week: Number(budget) }), max_attempts: Number(attempts), models });
      onSaved(s);
      toast.success('Settings saved.');
    } catch {
      /* toast shown */
    } finally {
      setBusy(false);
    }
  };

  return (
    <form aria-labelledby="run-h" className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 16 }} onSubmit={save}>
      <div style={{ paddingBottom: 12, borderBottom: '1px solid #E4E3E7' }}>
        <h2 id="run-h" className="h2">
          Runs and models
        </h2>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
        <label className="field">
          {tk ? 'Weekly budget (tokens)' : 'Weekly budget (USD)'}
          <input className="input mono" type="number" min={0} step={tk ? 1_000_000 : 1} value={budget} onChange={(e) => setBudget(e.target.value)} required />
          <span style={{ fontWeight: 400, color: '#74717A' }}>
            {tk ? 'You’re on a Claude plan: usage is counted in tokens. Runs pause when the week reaches this.' : 'Runs pause when agent spend this week reaches this.'}
          </span>
        </label>
        <label className="field">
          Max attempts per task
          <input className="input mono" type="number" min={1} max={10} step={1} value={attempts} onChange={(e) => setAttempts(e.target.value)} required />
          <span style={{ fontWeight: 400, color: '#74717A' }}>SWE ⇄ Tester loops before a task fails.</span>
        </label>
      </div>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <legend className="label" style={{ marginBottom: 10, color: '#45424D' }}>
          Model per agent
        </legend>
        <datalist id="models">
          {MODEL_SUGGESTIONS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        {WORKER_AGENTS.map((a) => (
          <label key={a} style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 200px) 1fr', gap: 12, alignItems: 'center', fontSize: 14 }}>
            <span style={{ fontWeight: 500 }}>{AGENT_NAME[a]}</span>
            <input className="input mono" list="models" value={models[a]} onChange={(e) => setModels((m) => ({ ...m, [a]: e.target.value }))} required style={{ height: 38 }} />
          </label>
        ))}
      </fieldset>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
        <button
          type="button"
          className="btn"
          disabled={!dirty || busy}
          onClick={() => {
            setBudget(String(storedBudget));
            setAttempts(String(settings.max_attempts));
            setModels(settings.models);
          }}
        >
          Reset
        </button>
        <button type="submit" className="btn btn-primary" disabled={!dirty || busy}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </form>
  );
}

function StatusCard({ settings }: { settings: Settings | null }) {
  const [version, setVersion] = useState<string | null>(null);
  const { connected } = useApp();
  useEffect(() => {
    api.health().then((h) => setVersion(h.version), () => setVersion(null));
  }, []);
  const rows: [string, boolean | null, string, string][] = settings
    ? [
        ['Agents', !settings.simulate, 'Real agents', 'Simulation mode'],
        ['Anthropic credentials', settings.has_credentials, 'Found', 'Missing'],
        ['Billing', true, settings.billing === 'subscription' ? 'Claude plan · tokens' : 'API · dollars', ''],
        ['GitHub CLI (gh)', settings.gh_available, 'Signed in', 'Not available'],
        ['Live updates', connected, 'Connected', 'Reconnecting'],
      ]
    : [];
  return (
    <section aria-labelledby="status-h" className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <h2 id="status-h" className="label">
        Status · read-only
      </h2>
      {!settings && <span className="muted">Loading…</span>}
      {rows.map(([label, ok, yes, no]) => (
        <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, fontSize: 14 }}>
          <span>{label}</span>
          <Chip kind={ok ? 'done' : label === 'Agents' ? 'wait' : 'fail'}>{ok ? yes : no}</Chip>
        </div>
      ))}
      {settings?.simulate && (
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: '#45424D', padding: '12px 14px', background: '#FDF1DD', borderRadius: 8 }}>
          Set <span className="mono">ANTHROPIC_API_KEY</span> (or sign in to Claude Code) and restart <span className="mono">cowcrew serve</span> to run real agents.
          <span className="mono"> COWCREW_SIMULATE=1</span> forces simulation.
        </p>
      )}
      {settings && !settings.gh_available && (
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: '#45424D' }}>
          Without <span className="mono">gh</span>, CowCrew skips push, PR and CI, and goes straight to the merge gate.
        </p>
      )}
      <span className="label">Server {version ?? 'unreachable'}</span>
    </section>
  );
}
