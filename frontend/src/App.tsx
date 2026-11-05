import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { Shell } from './components/Shell';
import { EmptyCard, Loading } from './components/ui';
import { useEffect, useState } from 'react';
import { api } from './api/client';
import { featureHref } from './lib/status';
import OverviewPage from './pages/Overview';
import NewFeaturePage from './pages/NewFeature';
import { CiList, LiveList, MergeList, PlansList, ReviewsList } from './pages/Lists';
import PlanPage from './pages/Plan';
import LivePage from './pages/Live';
import ReviewPage from './pages/Review';
import CIPage from './pages/CI';
import MergePage from './pages/Merge';
import SettingsPage from './pages/Settings';
import UsagePage from './pages/Usage';
import { Link } from 'react-router-dom';
import { useApp, useCrumbs } from './state/app';

/** /features/:id → the page that matches where the feature is in its lifecycle. */
function FeatureIndex() {
  const { id } = useParams();
  const { overview } = useApp();
  const [to, setTo] = useState<string | null>(null);
  const known = overview?.features.find((f) => f.id === Number(id));
  useEffect(() => {
    if (known) return;
    api.feature(Number(id), { silent: true }).then(
      (d) => setTo(featureHref(d.feature)),
      () => setTo(`/features/${id}/plan`),
    );
  }, [id, known]);
  const target = known ? featureHref(known) : to;
  return target ? <Navigate to={target} replace /> : <Loading />;
}

function NotFound() {
  useCrumbs([{ label: 'Not found' }]);
  return (
    <EmptyCard title="This page does not exist" action={<Link className="btn btn-primary" to="/">Back to overview</Link>}>
      The link may be old, or the feature was removed.
    </EmptyCard>
  );
}

export default function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/new" element={<NewFeaturePage />} />
        <Route path="/plans" element={<PlansList />} />
        <Route path="/live" element={<LiveList />} />
        <Route path="/reviews" element={<ReviewsList />} />
        <Route path="/ci" element={<CiList />} />
        <Route path="/merge" element={<MergeList />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/usage" element={<UsagePage />} />
        <Route path="/features/:id" element={<FeatureIndex />} />
        <Route path="/features/:id/plan" element={<PlanPage />} />
        <Route path="/features/:id/live" element={<LivePage />} />
        <Route path="/features/:id/review" element={<ReviewPage />} />
        <Route path="/features/:id/ci" element={<CIPage />} />
        <Route path="/features/:id/merge" element={<MergePage />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Shell>
  );
}
