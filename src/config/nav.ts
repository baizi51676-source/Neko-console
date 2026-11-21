// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Skylar

/**
 * Navigation config — the one place pages are registered.
 *
 * The shell renders this list, the appearance page reads it for the visibility
 * toggles, and the router resolves ids against it. Each entry carries the page
 * description because the shell renders the title bar from here, so pages do not
 * repeat their own heading.
 *
 * Every page is code-split: only the section being opened is downloaded.
 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import {
  Activity,
  FileText,
  FolderTree,
  LayoutDashboard,
  Settings2,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  id: string;
  label: string;
  /** One line under the title in the shell header. */
  description?: string;
  icon: LucideIcon;
  /** Shown in the mobile bottom bar when true (keep this to ~5 items). */
  primary?: boolean;
  component: LazyExoticComponent<ComponentType<Record<string, never>>>;
}

export interface NavGroup {
  group: string;
  items: NavItem[];
}

function page(loader: () => Promise<{ default: ComponentType<Record<string, never>> }>) {
  return lazy(loader);
}

export const NAV: NavGroup[] = [
  {
    group: '监控',
    items: [
      {
        id: 'dashboard',
        label: '总览',
        description: 'CPU、内存、磁盘、网络与负载的实时状态。',
        icon: LayoutDashboard,
        primary: true,
        component: page(() => import('@/pages/dashboard')),
      },
      {
        id: 'processes',
        label: '进程',
        description: '按 CPU 或内存排序的进程列表，可查看详情。',
        icon: Activity,
        primary: true,
        component: page(() => import('@/pages/processes')),
      },
    ],
  },
  {
    group: '管理',
    items: [
      {
        id: 'services',
        label: '服务',
        description: 'systemd 单元的启停与状态，含 unit 日志。',
        icon: SlidersHorizontal,
        primary: true,
        component: page(() => import('@/pages/services')),
      },
      {
        id: 'logs',
        label: '日志',
        description: 'journald 与系统日志文件，支持级别过滤。',
        icon: FileText,
        primary: true,
        component: page(() => import('@/pages/logs')),
      },
      {
        id: 'files',
        label: '文件',
        description: '浏览、编辑、上传与下载服务器文件。',
        icon: FolderTree,
        primary: true,
        component: page(() => import('@/pages/files')),
      },
    ],
  },
  {
    group: '系统',
    items: [
      {
        id: 'appearance',
        label: '外观',
        description: '主题、配色、字体与动效，本地即时生效。',
        icon: Settings2,
        component: page(() => import('@/pages/appearance')),
      },
    ],
  },
];

/** Flat list of every navigation item. */
export const NAV_ITEMS: NavItem[] = NAV.flatMap((group) => group.items);

/** Items pinned to the mobile bottom bar. */
export const PRIMARY_ITEMS: NavItem[] = NAV_ITEMS.filter((item) => item.primary);

export const DEFAULT_PAGE = NAV_ITEMS[0]?.id ?? 'dashboard';

export function findNavItem(id: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => item.id === id);
}
