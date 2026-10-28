import type { ReactNode } from 'react';
import { Button, Layout, Menu, Switch } from 'antd';
import { useAuth } from '../auth/AuthContext.tsx';
import { href, navigate, useRoute } from '../router.ts';
import { useViewOptions } from './ViewOptions.tsx';

export interface NavItem { path: string; label: string }
export interface NavGroup { title: string; items: NavItem[] }

/** Grouped by task (spec「布局」). Plan 3 inserts 调设置 between the two groups. */
export const NAV_GROUPS: NavGroup[] = [
  { title: '看情况', items: [{ path: '/overview', label: '总览' }, { path: '/users', label: '用户' }, { path: '/sessions', label: '通话' }] },
  {
    title: '调设置',
    items: [
      { path: '/settings/pacing', label: '对话节奏' },
      { path: '/settings/affect', label: '情绪与关怀' },
      { path: '/settings/memory', label: '记忆' },
      { path: '/settings/characters', label: '角色' },
      { path: '/settings/copy', label: '文案' },
      { path: '/settings/model', label: '模型与 Key' },
      { path: '/pricing', label: '价格表' },
      { path: '/settings/versions', label: '配置版本' },
    ],
  },
  { title: '查问题', items: [{ path: '/trace', label: '排查' }, { path: '/audit', label: '审计' }] },
];

export function AppLayout({ children }: { children: ReactNode }) {
  const route = useRoute();
  const { logout } = useAuth();
  const { includeMock, setIncludeMock } = useViewOptions();
  const allPaths = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.path));
  const top = allPaths.includes(route.path) ? route.path : `/${route.segments[0] ?? 'overview'}`;

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider width={208} theme="light" style={{ borderRight: '1px solid #DCE3E1' }}>
        <div style={{ padding: '24px 24px 16px', fontSize: 17, fontWeight: 600 }}>陪伴值班台</div>
        <Menu
          mode="inline"
          selectedKeys={[top]}
          onClick={({ key }) => navigate(String(key))}
          items={NAV_GROUPS.map((group) => ({
            type: 'group' as const,
            key: group.title,
            label: group.title,
            children: group.items.map((item) => ({ key: item.path, label: <a href={href(item.path)}>{item.label}</a> })),
          }))}
        />
      </Layout.Sider>
      <Layout>
        <Layout.Header style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 24, padding: '0 40px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Switch size="small" checked={includeMock} onChange={setIncludeMock} aria-label="显示模拟数据" />
            <span className="caption">显示模拟数据</span>
          </label>
          <Button onClick={() => void logout()}>退出登录</Button>
        </Layout.Header>
        <Layout.Content>
          <div className="content">{children}</div>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
