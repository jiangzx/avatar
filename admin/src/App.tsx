import { Spin } from 'antd';
import { useAuth } from './auth/AuthContext.tsx';
import { LoginPage } from './auth/LoginPage.tsx';
import { AppLayout } from './layout/AppLayout.tsx';
import { PageRoutes } from './routes.tsx';

export function App() {
  const { state } = useAuth();
  if (state.status === 'loading') return <Spin style={{ margin: 48 }} />;
  if (state.status === 'anonymous') return <LoginPage />;
  return (
    <AppLayout>
      <PageRoutes />
    </AppLayout>
  );
}
