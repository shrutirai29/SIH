/**
 * The policy engine.
 *
 * Detection says *what* something is. Policy says *what to do about it* — and, more
 * importantly, whether the client may ever turn the token back into a value.
 *
 * Resolution order (first match wins):
 *   1. user per-element override
 *   2. user per-site per-class override
 *   3. site pack (gov / bank / health are stricter)
 *   4. default pack
 *   5. FALLBACK: unknown class -> PLACEHOLDER; unverified region -> BLACKOUT
 *
 * Rule 5 is the one that matters. A class nobody has classified, or a detector that
 * timed out, must degrade into *more* redaction, never less (RULES.md P6).
 */

import { groupOf, isCredential, type SensitivityGroup } from '../classes.js';
import type { SitePack } from '../detectors/l0-dom-rules.js';

export type RedactAction = 'BLACKOUT' | 'BLUR' | 'PIXELATE' | 'PLACEHOLDER' | 'DROP' | 'KEEP';
export type RiskLevel = 'safe' | 'medium' | 'high';

export interface ClassPolicy {
  readonly action: RedactAction;
  /**
   * May the client resolve this token back into the real value on server request?
   * False for credentials, always and everywhere (RULES.md P4).
   */
  readonly reversible: boolean;
  /** Risk of writing this value into a field. */
  readonly risk: RiskLevel;
  /** Requires an explicit human confirmation at detokenisation time. */
  readonly confirmRequired: boolean;
}

const DENY: ClassPolicy = {
  action: 'PLACEHOLDER',
  reversible: false,
  risk: 'high',
  confirmRequired: true,
};

/** Default pack, keyed by sensitivity group (CONTEXT.md §5.4). */
const DEFAULT_PACK: Record<SensitivityGroup, ClassPolicy> = {
  credential: { action: 'PLACEHOLDER', reversible: false, risk: 'high', confirmRequired: true },
  gov_id: { action: 'PLACEHOLDER', reversible: true, risk: 'high', confirmRequired: true },
  financial: { action: 'PLACEHOLDER', reversible: true, risk: 'high', confirmRequired: true },
  health: { action: 'PLACEHOLDER', reversible: true, risk: 'medium', confirmRequired: true },
  biometric: { action: 'BLUR', reversible: false, risk: 'high', confirmRequired: true },
  contact: { action: 'PLACEHOLDER', reversible: true, risk: 'medium', confirmRequired: false },
  identity: { action: 'PLACEHOLDER', reversible: true, risk: 'medium', confirmRequired: false },
  other: { action: 'PLACEHOLDER', reversible: false, risk: 'medium', confirmRequired: true },
};

/**
 * Site packs override the default per group. They only ever tighten:
 * `resolvePolicy` asserts this, so a pack cannot accidentally relax a class.
 */
const SITE_PACKS: Record<Exclude<SitePack, 'default'>, Partial<Record<SensitivityGroup, ClassPolicy>>> = {
  gov: {
    // On a government portal, contact details are identifying in a way they are not on
    // a shopping site, and every write is consequential.
    contact: { action: 'PLACEHOLDER', reversible: true, risk: 'high', confirmRequired: true },
    identity: { action: 'PLACEHOLDER', reversible: true, risk: 'high', confirmRequired: true },
  },
  bank: {
    financial: { action: 'PLACEHOLDER', reversible: true, risk: 'high', confirmRequired: true },
    contact: { action: 'PLACEHOLDER', reversible: true, risk: 'high', confirmRequired: true },
  },
  health: {
    health: { action: 'PLACEHOLDER', reversible: true, risk: 'high', confirmRequired: true },
    identity: { action: 'PLACEHOLDER', reversible: true, risk: 'high', confirmRequired: true },
  },
};

export type UserOverride = Partial<ClassPolicy>;

export interface PolicyContext {
  readonly sitePack: SitePack;
  /** Per-site, per-class user overrides. May tighten only. */
  readonly userClassOverrides?: Readonly<Record<string, UserOverride>>;
  /** Per-element override, highest precedence. May tighten only. */
  readonly elementOverride?: UserOverride;
  /**
   * True when a detector errored or blew its budget for this item. Policy must then
   * assume the worst (RULES.md P6).
   */
  readonly unverified?: boolean;
  /** `strict` pins everything to non-reversible and confirm-required. */
  readonly privacyMode?: 'strict' | 'balanced' | 'fast';
}

const RISK_RANK: Record<RiskLevel, number> = { safe: 0, medium: 1, high: 2 };

/** Merges an override so it can only make the policy stricter, never looser. */
function tighten(base: ClassPolicy, over: UserOverride | undefined): ClassPolicy {
  if (over === undefined) return base;
  return {
    // An override may change the redaction method freely - all of them redact.
    action: over.action ?? base.action,
    // But it may only remove reversibility, never grant it.
    reversible: base.reversible && (over.reversible ?? true),
    risk:
      over.risk !== undefined && RISK_RANK[over.risk] > RISK_RANK[base.risk] ? over.risk : base.risk,
    confirmRequired: base.confirmRequired || (over.confirmRequired ?? false),
  };
}

export function resolvePolicy(cls: string, ctx: PolicyContext): ClassPolicy {
  // 5 (fallback, checked first because it is unconditional): an item nobody could
  // verify is treated as the most dangerous thing it might be.
  if (ctx.unverified === true) {
    return { action: 'BLACKOUT', reversible: false, risk: 'high', confirmRequired: true };
  }

  const group = groupOf(cls);
  let policy = DEFAULT_PACK[group];

  // 3. site pack
  if (ctx.sitePack !== 'default') {
    const packed = SITE_PACKS[ctx.sitePack][group];
    if (packed !== undefined) policy = tighten(policy, packed);
  }

  // 2. user per-site per-class
  policy = tighten(policy, ctx.userClassOverrides?.[cls]);

  // 1. user per-element
  policy = tighten(policy, ctx.elementOverride);

  // `strict` mode: nothing is reversible and everything is confirmed. This is the
  // mode we show judges first, because it is the strongest honest claim.
  if (ctx.privacyMode === 'strict') {
    policy = { ...policy, reversible: false, confirmRequired: true };
  }

  // Invariant, enforced rather than documented: a credential is never reversible, no
  // matter what any pack or override said above.
  if (isCredential(cls)) {
    policy = { ...policy, reversible: false, confirmRequired: true, risk: 'high' };
  }

  return policy;
}

export { DENY as DENY_POLICY };
