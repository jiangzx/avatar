import { OverviewPage } from './pages/OverviewPage.tsx';
import { SessionsPage } from './pages/SessionsPage.tsx';
import { UserDetailPage } from './pages/UserDetailPage.tsx';
import { UsersPage } from './pages/UsersPage.tsx';
import { useRoute } from './router.ts';

function TitleOnly({ title }: { title: string }) {
  return <h1 className="page-title">{title}</h1>;
}

/** Route table. P2-T8 replaces the remaining TitleOnly entries. */
export function PageRoutes() {
  const route = useRoute();
  const [top, id] = route.segments;
  switch (top) {
    case 'users':
      return id ? <UserDetailPage oid={id} /> : <UsersPage />;
    case 'sessions':
      return <SessionsPage oid={route.query.get('oid') ?? undefined} />;
    case 'trace':
      return <TitleOnly title="排查" />;
    case 'audit':
      return <TitleOnly title="审计" />;
    default:
      return <OverviewPage />;
  }
}
