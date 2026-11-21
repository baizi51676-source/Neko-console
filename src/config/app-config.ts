// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Skylar

/**
 * App configuration — the values a template user is expected to change.
 *
 * Keep everything brand-specific in this file so "rebrand the template" is one
 * edit instead of a search across the codebase.
 */

export const APP_CONFIG = {
  /** Product name, used in the sidebar, login panel and document title. */
  name: 'Neko-console',
  subtitle: 'Server Console',
  /** Short line shown under the name on the login screen. */
  tagline: '面向 Linux 服务器的轻量监控与管理控制台',

  /**
   * Demo login. This template ships a UI-only auth gate: any non-empty
   * username/password passes, and the session is remembered in localStorage.
   * Replace `authenticate` below with a real call when wiring a backend.
   */
  demoAuth: true as boolean,

  /** Accent palettes offered on the appearance page. */
  accentPresets: [
    '#0ea5e9',
    '#0284c7',
    '#2563eb',
    '#6366f1',
    '#8b5cf6',
    '#a855f7',
    '#ec4899',
    '#ef4444',
    '#f59e0b',
    '#10b981',
    '#14b8a6',
  ],
};

export type AppConfig = typeof APP_CONFIG;
