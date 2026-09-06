/**
 * Per-tab KAVACH session state.
 *
 * The vault lives HERE, in the content script, not in the background. See ADR-0002:
 * redaction happens in this context, and so does execution, so a value never has to
 * cross a message boundary in either direction. RULES.md P3 becomes true by
 * construction rather than by discipline.
 *
 * The cost is that the vault does not survive navigation — which is correct anyway,
 * since SSG element ids are page-instance scoped and a navigated page's `e17` is not
 * the `e17` a token was bound to.
 */

import { Vault, sitePackFor, type PolicyContext } from '@prahari/kavach';
import { CONFIG } from '../shared/config.js';

let vault: Vault | null = null;
let sessionId = '';

function policyForThisPage(): PolicyContext {
  return {
    sitePack: sitePackFor(location.hostname),
    // Read from CONFIG rather than hard-coded. It was pinned to 'balanced' here while
    // `CONFIG.privacyMode` existed and was documented as the thing that selects it, so
    // `strict` — the strongest honest claim the system can make, and the mode
    // START-HERE.md says to show a judge first — was unreachable from configuration.
    privacyMode: CONFIG.privacyMode,
    // TODO(D18): per-site/per-class user overrides come from the policy editor UI.
  };
}

export interface KavachSession {
  readonly vault: Vault;
  readonly policy: PolicyContext;
  readonly origin: string;
}

/**
 * Returns the session for `id`, wiping and re-minting if the task changed.
 * A new task means new tokens, which is what makes them unlinkable across tasks.
 */
export async function getSession(id: string, step: number): Promise<KavachSession> {
  if (vault === null || sessionId !== id) {
    vault?.wipe();
    vault = new Vault();
    await vault.init();
    sessionId = id;
  }
  vault.setStep(step);

  return { vault, origin: location.origin, policy: policyForThisPage() };
}

/**
 * A session that shares the page's policy but none of its state.
 *
 * The canary audit runs the real extractor over the live page, and it must not do that
 * through the task's vault: minting audit tokens there would renumber the ordinals a
 * running plan refers to, and taking the `getSession` path with a different id would
 * WIPE the vault mid-task, so the next `value_ref` the server sent back would be
 * refused as an unknown token. A throwaway vault keeps the measurement real and the
 * task intact.
 */
export async function createEphemeralSession(step: number): Promise<KavachSession> {
  const scratch = new Vault();
  await scratch.init();
  scratch.setStep(step);
  return { vault: scratch, origin: location.origin, policy: policyForThisPage() };
}

/** The current session's vault, if a task is running. Used by the executor. */
export function currentVault(): Vault | null {
  return vault;
}

/** Kill switch, task end, tab hidden. */
export function wipeSession(): void {
  vault?.wipe();
  vault = null;
  sessionId = '';
}

// A closed tab must not leave a resolvable vault behind in a bfcache entry.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', wipeSession);
}
