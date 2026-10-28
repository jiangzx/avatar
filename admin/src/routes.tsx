import { AuditPage } from './pages/AuditPage.tsx';
import { OverviewPage } from './pages/OverviewPage.tsx';
import { SessionsPage } from './pages/SessionsPage.tsx';
import { TracePage } from './pages/TracePage.tsx';
import { UserDetailPage } from './pages/UserDetailPage.tsx';
import { UsersPage } from './pages/UsersPage.tsx';
import { ConfigScenePage } from './config/ConfigScenePage.tsx';
import { ModelKeyPage } from './config/ModelKeyPage.tsx';
import { PacingRuler } from './config/PacingRuler.tsx';
import { PricingPage } from './config/PricingPage.tsx';
import { VersionsPage } from './config/VersionsPage.tsx';
import { useRoute } from './router.ts';

/** Route table. Plan 3 adds the 调设置 pages here. */
export function PageRoutes() {
  const route = useRoute();
  const [top, id] = route.segments;
  switch (top) {
    case 'users':
      return id ? <UserDetailPage oid={id} /> : <UsersPage />;
    case 'sessions':
      return <SessionsPage oid={route.query.get('oid') ?? undefined} />;
    case 'trace':
      return <TracePage sid={id} query={route.query} />;
    case 'audit':
      return <AuditPage />;
    case 'settings': {
      const scene = id ?? 'pacing';
      // key resets the draft when switching scenes.
      if (scene === 'pacing') return <ConfigScenePage key="pacing" scene="pacing" aside={(view) => <PacingRuler view={view} />} />;
      if (scene === 'model') return <ModelKeyPage key="model" />;
      if (scene === 'versions') return <VersionsPage />;
      return <ConfigScenePage key={scene} scene={scene} />;
    }
    case 'pricing':
      return <PricingPage />;
    default:
      return <OverviewPage />;
  }
}
