// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Skylar

/** Formatting helpers shared by the console pages. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Byte count with a sensible unit. `null`/`undefined` render as a dash. */
export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const index = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  // Drop the decimal for plain bytes; it is noise at that scale.
  return `${index === 0 ? Math.round(value) : value.toFixed(digits)} ${UNITS[index]}`;
}

/** Bytes per second, for network rates. */
export function formatRate(bytesPerSecond: number | null | undefined): string {
  return `${formatBytes(bytesPerSecond, 1)}/s`;
}

/** Compact duration such as `3天 4小时` / `12分 30秒`. */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}天 ${hours}小时`;
  if (hours > 0) return `${hours}小时 ${minutes}分`;
  return `${minutes}分 ${Math.floor(seconds % 60)}秒`;
}

/** Percentage with a single decimal, clamped for display. */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${Math.min(100, Math.max(0, value)).toFixed(1)}%`;
}

/** Absolute timestamp in the viewer's locale. */
export function formatTime(iso: string | number | null | undefined): string {
  if (iso === null || iso === undefined) return '—';
  const date = typeof iso === 'number' ? new Date(iso) : new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString('zh-CN', { hour12: false });
}

/**
 * Traffic-light tone for a 0-100 metric.
 *
 * Thresholds are the ones an operator actually acts on: past 75% you look,
 * past 90% you intervene.
 */
export function metricTone(percent: number): 'ok' | 'warn' | 'danger' {
  if (percent >= 90) return 'danger';
  if (percent >= 75) return 'warn';
  return 'ok';
}

/** Human-readable state label for a systemd unit. */
export function serviceStateLabel(active: string, sub: string): { text: string; tone: 'ok' | 'warn' | 'danger' | 'muted' } {
  if (active === 'active' && (sub === 'running' || sub === 'exited')) return { text: sub === 'exited' ? '已退出' : '运行中', tone: 'ok' };
  if (active === 'activating') return { text: '启动中', tone: 'warn' };
  if (active === 'deactivating') return { text: '停止中', tone: 'warn' };
  if (active === 'failed') return { text: '失败', tone: 'danger' };
  if (active === 'inactive') return { text: '未运行', tone: 'muted' };
  return { text: `${active}/${sub}`, tone: 'muted' };
}

/** Process state letter (from /proc/PID/stat) to something readable. */
export function processStateLabel(state: string): string {
  const map: Record<string, string> = {
    R: '运行中', S: '睡眠', D: '不可中断', Z: '僵尸', T: '已停止', t: '调试停止', I: '空闲', X: '已退出',
  };
  return map[state] ?? state;
}
