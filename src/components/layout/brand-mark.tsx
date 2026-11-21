// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Skylar

/**
 * Brand mark — a placeholder logo you are meant to replace.
 *
 * It is inlined as SVG so it costs no extra request, is sizeable by the caller,
 * and stays crisp at any zoom. Swap the paths (or use an <img src="/logo.png">)
 * when branding the template.
 */
export function BrandMark({ size = 30, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="512" height="512" rx="112" fill="#0f172a" />
      <rect x="64" y="64" width="384" height="384" rx="72" fill="#ffffff" />
      <path d="M64 136h384" fill="none" stroke="#dbeafe" strokeWidth="16" />
      <circle cx="112" cy="100" r="10" fill="#38bdf8" />
      <circle cx="144" cy="100" r="10" fill="#7dd3fc" />
      <circle cx="176" cy="100" r="10" fill="#bae6fd" />
      <rect x="150" y="196" width="212" height="136" rx="26" fill="#38bdf8" />
      <path
        d="M196 246l44 26-44 26z"
        fill="#0f172a"
        stroke="#0f172a"
        strokeWidth="8"
        strokeLinejoin="round"
      />
      <path d="M262 236h72M262 278h72" stroke="#0f172a" strokeWidth="16" strokeLinecap="round" />
    </svg>
  );
}
