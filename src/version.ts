/**
 * Build-time app metadata.
 *
 * `__APP_VERSION__` and `__BUILD_TIME__` are injected by Vite (see the
 * `define` block in vite.config.ts). The `typeof` guards keep this module
 * safe if it is ever evaluated outside a Vite build (e.g. a bare test run),
 * where those identifiers would be undefined and would otherwise throw a
 * ReferenceError at import time.
 */
declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;

export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0-dev';

export const BUILD_TIME: string =
  typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '';
