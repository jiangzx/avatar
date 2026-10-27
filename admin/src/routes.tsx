import { AuditPage } from './pages/AuditPage.tsx';
import { OverviewPage } from './pages/OverviewPage.tsx';
import { SessionsPage } from './pages/SessionsPage.tsx';
import { TracePage } from './pages/TracePage.tsx';
import { UserDetailPage } from './pages/UserDetailPage.tsx';
import { UsersPage } from './pages/UsersPage.tsx';
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
    default:
      return <OverviewPage />;
  }
}
