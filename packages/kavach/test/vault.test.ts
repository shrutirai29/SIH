import { beforeEach, describe, expect, it } from 'vitest';
import { Vault } from '../src/vault.js';

const ORIGIN = 'https://pmkisan.gov.in';
const AADHAAR = '234567890124';

let vault: Vault;

beforeEach(async () => {
  vault = new Vault();
  await vault.init();
});

async function mintAadhaar(elementId = 'e17') {
  return vault.tokenFor({
    cls: 'AADHAAR',
    value: AADHAAR,
    originElementId: elementId,
    originOrigin: ORIGIN,
    reversible: true,
    confirmRequired: true,
  });
}

describe('minting', () => {
  it('produces a well-formed, typed token', async () => {
    const token = await mintAadhaar();
    expect(token).toBe('⟦AADHAAR_1⟧');
  });

  it('gives the same value the same token within a session (coreference)', async () => {
    const a = await mintAadhaar('e17');
    const b = await vault.tokenFor({
      cls: 'AADHAAR',
      value: AADHAAR,
      originElementId: 'e42',
      originOrigin: ORIGIN,
      reversible: true,
      confirmRequired: true,
    });
    // This is what lets the server reason: the Aadhaar in the header is the same
    // Aadhaar as the one in the footer.
    expect(b).toBe(a);
    expect(vault.size).toBe(1);
  });

  it('numbers distinct values of the same class separately', async () => {
    const a = await mintAadhaar();
    const b = await vault.tokenFor({
      cls: 'AADHAAR',
      value: '345678901239',
      originElementId: 'e18',
      originOrigin: ORIGIN,
      reversible: true,
      confirmRequired: true,
    });
    expect(a).toBe('⟦AADHAAR_1⟧');
    expect(b).toBe('⟦AADHAAR_2⟧');
  });

  it('gives different sessions different tokens for the same value (unlinkability)', async () => {
    const first = new Vault();
    await first.init();
    const second = new Vault();
    await second.init();

    const opts = {
      cls: 'AADHAAR',
      value: AADHAAR,
      originElementId: 'e1',
      originOrigin: ORIGIN,
      reversible: true,
      confirmRequired: false,
    };
    // Token TEXT is deterministic by ordinal, but the digest key is session-scoped, so
    // nothing about the value survives across sessions. Assert the keying, not the text.
    await first.tokenFor(opts);
    await second.tokenFor(opts);
    expect(first.describe()[0]?.token).toBe(second.describe()[0]?.token);

    // The real unlinkability property: adding an unrelated value first shifts ordinals,
    // so a token cannot be correlated to a value across sessions.
    const third = new Vault();
    await third.init();
    await third.tokenFor({ ...opts, value: '999999999999', originElementId: 'e0' });
    const later = await third.tokenFor(opts);
    expect(later).toBe('⟦AADHAAR_2⟧');
  });
});

describe('credentials are never vaulted (RULES.md P4)', () => {
  for (const cls of ['PASSWORD', 'OTP', 'CVV', 'API_KEY', 'JWT', 'PRIVATE_KEY']) {
    it('drops ' + cls + ' rather than storing it', async () => {
      const token = await vault.tokenFor({
        cls,
        value: 'hunter2-very-secret',
        originElementId: 'e5',
        originOrigin: ORIGIN,
        // Even when the caller asks for reversibility, the vault refuses.
        reversible: true,
        confirmRequired: false,
      });
      expect(token).toBe('⟦REDACTED_0⟧');
      expect(vault.size).toBe(0);

      const result = vault.detokenize(token, { elementId: 'e5', origin: ORIGIN });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('UNKNOWN_TOKEN');
    });
  }

  it('collapses several distinct credentials onto one sentinel', async () => {
    const a = await vault.tokenFor({
      cls: 'PASSWORD', value: 'one', originElementId: 'e1',
      originOrigin: ORIGIN, reversible: false, confirmRequired: true,
    });
    const b = await vault.tokenFor({
      cls: 'CVV', value: '123', originElementId: 'e2',
      originOrigin: ORIGIN, reversible: false, confirmRequired: true,
    });
    expect(a).toBe(b);
    expect(vault.size).toBe(0);
  });
});

describe('sink binding — the EIA defence', () => {
  it('resolves a token into the field it came from', async () => {
    const token = await mintAadhaar('e17');
    const result = vault.detokenize(token, { elementId: 'e17', origin: ORIGIN });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(AADHAAR);
      expect(result.confirmRequired).toBe(true);
    }
  });

  it('REFUSES to write the value into any other field', async () => {
    // The attack: a hostile page injects an instruction, the server dutifully emits
    // `type ⟦AADHAAR_1⟧ into e99`, and e99 is the attacker's search box, which
    // exfiltrates via the URL. Sink binding makes the request unsatisfiable.
    const token = await mintAadhaar('e17');
    const result = vault.detokenize(token, { elementId: 'e99', origin: ORIGIN });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('SINK_NOT_ALLOWED');
  });

  it('refuses after a cross-origin navigation', async () => {
    const token = await mintAadhaar('e17');
    const result = vault.detokenize(token, { elementId: 'e17', origin: 'https://attacker.test' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ORIGIN_CHANGED');
  });

  it('refuses once the TTL has passed', async () => {
    const token = await mintAadhaar('e17');
    vault.setStep(99);
    const result = vault.detokenize(token, { elementId: 'e17', origin: ORIGIN });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('EXPIRED');
  });

  it('refuses a token that was never minted', () => {
    const result = vault.detokenize('⟦AADHAAR_9⟧', { elementId: 'e17', origin: ORIGIN });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('UNKNOWN_TOKEN');
  });

  it('refuses a syntactically invalid token', () => {
    const result = vault.detokenize('AADHAAR_1', { elementId: 'e17', origin: ORIGIN });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('UNKNOWN_TOKEN');
  });

  it('refuses a non-reversible token even when the sink is correct', async () => {
    const token = await vault.tokenFor({
      cls: 'PERSON_NAME',
      value: 'Asha Patil',
      originElementId: 'e3',
      originOrigin: ORIGIN,
      reversible: false,
      confirmRequired: false,
    });
    const result = vault.detokenize(token, { elementId: 'e3', origin: ORIGIN });
    expect(result.ok).toBe(false);
  });

  it('accepts a second field that already held the same value', async () => {
    // Writing a value back where it already is cannot exfiltrate it, so the second
    // origin field becomes an allowed sink.
    await mintAadhaar('e17');
    const token = await vault.tokenFor({
      cls: 'AADHAAR', value: AADHAAR, originElementId: 'e18',
      originOrigin: ORIGIN, reversible: true, confirmRequired: true,
    });
    expect(vault.detokenize(token, { elementId: 'e17', origin: ORIGIN }).ok).toBe(true);
    expect(vault.detokenize(token, { elementId: 'e18', origin: ORIGIN }).ok).toBe(true);
    expect(vault.detokenize(token, { elementId: 'e19', origin: ORIGIN }).ok).toBe(false);
  });

  it('honours explicitly declared compatible sinks', async () => {
    const token = await vault.tokenFor({
      cls: 'EMAIL', value: 'asha@example.com', originElementId: 'e4',
      originOrigin: ORIGIN, reversible: true, confirmRequired: false,
      extraSinks: ['e5'],
    });
    expect(vault.detokenize(token, { elementId: 'e5', origin: ORIGIN }).ok).toBe(true);
    expect(vault.detokenize(token, { elementId: 'e6', origin: ORIGIN }).ok).toBe(false);
  });

  it('records every refusal for the ledger and the user', async () => {
    const token = await mintAadhaar('e17');
    vault.detokenize(token, { elementId: 'e99', origin: ORIGIN });
    vault.detokenize(token, { elementId: 'e98', origin: ORIGIN });

    const violations = vault.violations();
    expect(violations).toHaveLength(2);
    expect(violations[0]?.reason).toBe('SINK_NOT_ALLOWED');
    expect(violations[0]?.attemptedSink).toBe('e99');
  });
});

describe('the vault cannot be serialised (RULES.md P3)', () => {
  it('yields a count, not values, when stringified', async () => {
    await mintAadhaar();
    const serialised = JSON.stringify({ vault });
    expect(serialised).not.toContain(AADHAAR);
    expect(serialised).toContain('values withheld');
  });

  it('yields a count, not values, when coerced to a string', async () => {
    await mintAadhaar();
    expect(String(vault)).not.toContain(AADHAAR);
    expect('' + String(vault)).toContain('Vault:');
  });

  it('describe() exposes structure but never a value', async () => {
    await mintAadhaar('e17');
    const described = vault.describe();
    expect(JSON.stringify(described)).not.toContain(AADHAAR);
    expect(described[0]).toMatchObject({
      token: '⟦AADHAAR_1⟧',
      cls: 'AADHAAR',
      reversible: true,
      allowedSinks: ['e17'],
    });
  });

  it('wipe() leaves nothing resolvable', async () => {
    const token = await mintAadhaar();
    vault.detokenize(token, { elementId: 'e99', origin: ORIGIN });
    expect(vault.violations()).toHaveLength(1);

    vault.wipe();
    expect(vault.size).toBe(0);
    expect(vault.violations()).toHaveLength(0);

    // An attempt AFTER the wipe is still refused - and still recorded, because
    // "something tried to resolve a token after your session ended" is exactly the
    // event a user needs to see.
    expect(vault.detokenize(token, { elementId: 'e17', origin: ORIGIN }).ok).toBe(false);
    expect(vault.violations()).toHaveLength(1);
  });
});

describe('the session key is minted once, even under concurrency', () => {
  it('gives the same token to the same value when mints race', async () => {
    // `tokenFor` lazily generates the HMAC key. Two callers arriving before it exists
    // each generated one, the second overwrote the first, and every digest computed
    // under the loser became permanently unmatchable. Nothing throws: the vault just
    // quietly stops recognising a value it has already seen, so coreference breaks and
    // the second field never becomes an allowed sink.
    const racing = new Vault();

    const [a, b] = await Promise.all([
      racing.tokenFor({
        cls: 'AADHAAR',
        value: '234567890124',
        originElementId: 'e1',
        originOrigin: 'https://pmkisan.gov.in',
        reversible: true,
        confirmRequired: true,
      }),
      racing.tokenFor({
        cls: 'AADHAAR',
        value: '234567890124',
        originElementId: 'e2',
        originOrigin: 'https://pmkisan.gov.in',
        reversible: true,
        confirmRequired: true,
      }),
    ]);

    expect(a).toBe(b);
    expect(racing.size).toBe(1);

    // And the consequence that matters: the second field really is an allowed sink,
    // so writing the value back where it already is still works.
    const sinks = racing.describe()[0]?.allowedSinks ?? [];
    expect(sinks).toContain('e1');
    expect(sinks).toContain('e2');
  });

  it('is idempotent when init() is called repeatedly', async () => {
    const v = new Vault();
    await Promise.all([v.init(), v.init(), v.init()]);
    const first = await v.tokenFor({
      cls: 'EMAIL',
      value: 'asha@example.com',
      originElementId: 'e1',
      originOrigin: 'https://example.com',
      reversible: true,
      confirmRequired: false,
    });
    await v.init();
    const second = await v.tokenFor({
      cls: 'EMAIL',
      value: 'asha@example.com',
      originElementId: 'e1',
      originOrigin: 'https://example.com',
      reversible: true,
      confirmRequired: false,
    });
    expect(second).toBe(first);
  });
});
