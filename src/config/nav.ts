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
  Boxes,
  Clock,
  Database,
  FileText,
  FolderTree,
  Globe,
  HardDrive,
  LayoutDashboard,
  PackagePlus,
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
    group: '容器',
    items: [
      {
        id: 'docker',
        label: 'Docker',
        description: '容器、镜像、数据卷与 Compose 项目的状态与操作。',
        icon: Boxes,
        primary: true,
        component: page(() => import('@/pages/docker')),
      },
      {
        id: 'install',
        label: '一键安装',
        description: '从模板部署常用应用，支持 Docker Hub 与国内镜像源。',
        icon: PackagePlus,
        primary: true,
        component: page(() => import('@/pages/install')),
      },
    ],
  },
  {
    group: '站点',
    items: [
      {
        id: 'sites',
        label: '网站',
        description: '反向代理与静态站点，含 SSL 证书签发与续期巡检。',
        icon: Globe,
        primary: true,
        component: page(() => import('@/pages/sites')),
      },
    ],
  },
  {
    group: '数据',
    items: [
      {
        id: 'databases',
        label: '数据库',
        description: '创建与删除 MySQL / PostgreSQL 数据库和账号。',
        icon: Database,
        component: page(() => import('@/pages/databases')),
      },
      {
        id: 'backups',
        label: '备份',
        description: '数据库逻辑备份与站点打包，带 SHA-256 校验。',
        icon: HardDrive,
        component: page(() => import('@/pages/backups')),
      },
      {
        id: 'jobs',
        label: '计划任务',
        description: '定时执行内置动作或白名单脚本，记录每次结果。',
        icon: Clock,
        component: page(() => import('@/pages/jobs')),
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
