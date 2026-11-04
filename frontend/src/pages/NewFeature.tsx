import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { EmptyCard, NumBox } from '../components/ui';
import { toast } from '../lib/toast';
import { useApp, useCrumbs } from '../state/app';

export default function NewFeaturePage() {
  useCrumbs([{ label: 'Plans', to: '/plans' }, { label: 'New feature spec' }]);
  const { projects, projectId, settings } = useApp();
  const nav = useNavigate();
  const [title, setTitle] = useState('');
  const [spec, setSpec] = useState('');
  const [pid, setPid] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (pid === '' && projectId) setPid(projectId);
  }, [projectId, pid]);

  if (projects && projects.length === 0)
    return (
      <EmptyCard title="Add a project first" action={<Link className="btn btn-primary" to="/settings#projects">Open settings</Link>}>
        A feature spec runs against a git repository on this computer.
      </EmptyCard>
    );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pid) return;
    setBusy(true);
    try {
      const f = await api.createFeature({ project_id: Number(pid), title: title.trim(), spec: spec.trim() });
      toast.success('Spec submitted. The Product Architect is reading it.');
      nav(`/features/${f.id}/plan`);
    } catch {
      setBusy(false);
    }
  };

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="mono" style={{ fontSize: 12, color: '#FC6D26' }}>
          01 · Plan
        </span>
        <h1 className="title">New feature spec</h1>
        <p style={{ margin: 0, fontSize: 14, color: '#74717A' }}>Describe the outcome in plain words. The Product Architect will grill you on anything unclear before it plans.</p>
      </div>
      <div className="row" style={{ gap: 24 }}>
        <form className="card col-main" style={{ padding: 22, gap: 18 }} onSubmit={submit}>
          <label className="field">
            Project
            <select className="select input" value={pid} onChange={(e) => setPid(Number(e.target.value))} required>
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.default_branch}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Title
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. SSO with Google Workspace" required maxLength={120} />
          </label>
          <label className="field">
            Spec
            <textarea
              className="textarea"
              rows={10}
              value={spec}
              onChange={(e) => setSpec(e.target.value)}
              placeholder="Let users sign in with their Google Workspace account. Admins can require SSO for their whole organization. Keep email and password for everyone else."
              required
            />
            <span style={{ fontWeight: 400, color: '#74717A' }}>Who is it for, what should they be able to do, and what must not break.</span>
          </label>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <Link to="/plans" className="btn">
              Cancel
            </Link>
            <button type="submit" className="btn btn-primary" disabled={busy || !title.trim() || !spec.trim() || !pid}>
              {busy ? 'Submitting…' : 'Start planning'}
            </button>
          </div>
        </form>
        <aside className="col-side" aria-label="What happens next">
          <section className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <h2 className="label">What happens next</h2>
            {[
              ['#FC6D26', 'Grilling', `Product Architect (${settings?.models.product_architect ?? 'fable'}) asks a few questions if the spec has gaps.`],
              ['#E24329', 'Gate 1 · plan approval', 'You approve numbered tasks with acceptance criteria.'],
              ['#A989F5', 'Build, verify, CI', 'SWE ⇄ Tester per task, then acceptance, PR review and CI.'],
              ['#5943B6', 'Gate 2 · merge', 'You get one summary and make the final call.'],
            ].map(([c, t, s], i) => (
              <div key={t} style={{ display: 'grid', gridTemplateColumns: '30px 1fr', gap: 12, alignItems: 'start' }}>
                <NumBox n={i + 1} color={c} size="sm" />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{t}</span>
                  <span style={{ fontSize: 13, color: '#74717A' }}>{s}</span>
                </span>
              </div>
            ))}
          </section>
        </aside>
      </div>
    </>
  );
}
