// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Skylar

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './app';

const host = document.getElementById('root');
if (!host) throw new Error('#root element is missing');

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
