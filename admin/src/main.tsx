import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import './styles.css';
import { App } from './App.tsx';
import { AuthProvider } from './auth/AuthContext.tsx';
import { ViewOptionsProvider } from './layout/ViewOptions.tsx';
import { adminTheme } from './theme.ts';

// Ant Design motion follows the OS setting (spec: 尊重 prefers-reduced-motion).
// autoInsertSpace off: two-character labels stay 「登录」, not 「登 录」.
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

createRoot(root).render(
  <StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{ ...adminTheme, token: { ...adminTheme.token, motion: !reducedMotion } }}
      button={{ autoInsertSpace: false }}
    >
      <AntApp>
        <AuthProvider>
          <ViewOptionsProvider>
            <App />
          </ViewOptionsProvider>
        </AuthProvider>
      </AntApp>
    </ConfigProvider>
  </StrictMode>,
);
