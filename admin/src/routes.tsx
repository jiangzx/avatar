import { useRoute } from './router.ts';

function TitleOnly({ title }: { title: string }) {
  return <h1 className="page-title">{title}</h1>;
}

/** Route table. P2-T7/P2-T8 replace each TitleOnly with the real page. */
export function PageRoutes() {
  const route = useRoute();
  switch (route.segments[0]) {
    case 'users':
      return <TitleOnly title="用户" />;
    case 'sessions':
      return <TitleOnly title="通话" />;
    case 'trace':
      return <TitleOnly title="排查" />;
    case 'audit':
      return <TitleOnly title="审计" />;
    default:
      return <TitleOnly title="总览" />;
  }
}
