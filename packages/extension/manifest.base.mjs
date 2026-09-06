/**
 * Single source of truth for both manifests (RULES.md X2).
 *
 * Hand-editing a generated `manifest.json` under any `dist-` directory is a CI failure
 * once the contract job exists. Change this file instead.
 *
 * The Chrome/Firefox divergence is deliberately confined here and to `src/platform/`:
 *   - Chrome MV3 background is a service worker: no DOM, no WebGPU, killed when idle.
 *     Inference therefore needs an offscreen document.
 *   - Firefox MV3 keeps event pages, which ARE documents, so the same code runs in the
 *     background directly and the `offscreen` permission does not exist there.
 *   - Side panel API differs in name (`sidePanel` vs `sidebar_action`).
 *
 * NOTE: named `.mjs` rather than `.ts` so `scripts/build.mjs` can import it with no
 * transpile step. See docs/adr/0001-walking-skeleton.md.
 */

const NAME = 'PRAHARI';
const DESCRIPTION =
  'Privacy-preserving browser vision agent. The server sees the shape of your screen, never its secrets.';

/**
 * @param {{ target: 'chrome' | 'firefox', version: string, serverOrigin: string }} opts
 */
export function buildManifest({ target, version, serverOrigin }) {
  // RULES.md P10: exactly one network host permission, ever.
  const hostPermission = new URL(serverOrigin).origin + '/*';

  /** @type {Record<string, unknown>} */
  const base = {
    manifest_version: 3,
    name: NAME,
    version,
    description: DESCRIPTION,
    permissions: ['storage', 'activeTab', 'scripting', 'tabs'],
    host_permissions: [hostPermission],
    content_scripts: [
      {
        // TODO(ticket A5): PRD.md ships default-deny with per-site grant. The skeleton
        // injects broadly so the loop can be exercised; narrow this before any release.
        matches: ['<all_urls>'],
        js: ['content.js'],
        run_at: 'document_idle',
        all_frames: false,
      },
    ],
    icons: { 128: 'icon128.png' },
    content_security_policy: {
      // S7: no remote code, no eval. MV3 requires this and it is also just correct.
      extension_pages: "script-src 'self'; object-src 'self';",
    },
  };

  if (target === 'chrome') {
    return {
      ...base,
      permissions: [...base.permissions, 'offscreen', 'sidePanel'],
      background: { service_worker: 'background.js', type: 'module' },
      side_panel: { default_path: 'sidepanel.html' },
      action: { default_title: NAME },
    };
  }

  return {
    ...base,
    // Firefox event page: a real document, so it hosts inference itself.
    background: { scripts: ['background.js'], type: 'module' },
    sidebar_action: {
      default_panel: 'sidepanel.html',
      default_title: NAME,
      open_at_install: false,
    },
    action: { default_title: NAME },
    browser_specific_settings: {
      gecko: {
        id: 'prahari@sih2026.dev',
        // WebGPU lands in Firefox 141 (Windows) / 145 (macOS); the WASM path covers
        // older builds, so the floor here is only about MV3 event-page support.
        strict_min_version: '128.0',
      },
    },
  };
}
