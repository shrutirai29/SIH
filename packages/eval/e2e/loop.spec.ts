/**
 * The browser test that would have caught bug #5 (ticket H5).
 *
 * Everything here is asserted about the built artefact running in a real Chromium with
 * the real manifest and the real CSP. Nothing is mocked.
 */

import {
  assertNoFatalErrors,
  DEMO_PORTAL_URL,
  expect,
  test,
} from './fixtures.js';

const SESSION = 'eph_aabbccdd1122';

/** The synthetic identifiers planted in the demo portal. None may reach a payload. */
const PLANTED = {
  aadhaar: '2345 6789 0124',
  aadhaarCompact: '234567890124',
  pan: 'ABCPE1234F',
  phone: '9876543210',
  email: 'asha.patil@example.com',
  ifsc: 'HDFC0001234',
  password: 'hunter2-not-real',
  otp: '482915',
};

test.describe('extension boots in a real browser', () => {
  test('the service worker starts and the manifest is accepted', async ({
    serviceWorker,
    extensionId,
    workerErrors,
  }) => {
    expect(extensionId).toMatch(/^[a-p]{32}$/);
    expect(serviceWorker.url()).toContain('background.js');

    const manifest = await serviceWorker.evaluate(() =>
      chrome.runtime.getManifest(),
    );

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe('PRAHARI');

    // RULES.md P10: exactly one network host permission, ever.
    expect(manifest.host_permissions).toHaveLength(1);

    // S7: no eval, no remote script.
    const csp = manifest.content_security_policy?.extension_pages ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-eval');

    assertNoFatalErrors(workerErrors);
  });

  test('the side panel renders without a CSP violation', async ({
    context,
    extensionId,
    workerErrors,
  }) => {
    const panel = await context.newPage();
    const pageErrors: string[] = [];

    panel.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push(m.text());
    });

    panel.on('pageerror', (e) => pageErrors.push(e.message));

    await panel.goto(
      'chrome-extension://' + extensionId + '/sidepanel.html',
    );

    await expect(
      panel.getByRole('heading', { name: 'PRAHARI' }),
    ).toBeVisible();

    await expect(
      panel.getByRole('button', { name: 'Run', exact: true }),
    ).toBeVisible();

    assertNoFatalErrors(pageErrors);
    assertNoFatalErrors(workerErrors);
  });
});

test.describe('extraction and redaction on a real page', () => {
  test('redacts every planted identifier before anything leaves the tab', async ({
    context,
    serviceWorker,
    workerErrors,
  }) => {
    const portal = await context.newPage();

    await portal.goto(DEMO_PORTAL_URL);

    await expect(
      portal.getByLabel('Aadhaar number'),
    ).toHaveValue(PLANTED.aadhaar);

    const result = await serviceWorker.evaluate(async (sessionId) => {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (tab?.id === undefined) {
        throw new Error('no active tab');
      }

      return (await chrome.tabs.sendMessage(tab.id, {
        kind: 'EXTRACT_SCREEN',
        goal: 'Apply for the scheme using my saved profile',
        step: 0,
        traceId: 't_0',
        sessionId,
      })) as {
        ssg: unknown;
        redactions: Record<string, number>;
      };
    }, SESSION);

    const payload = JSON.stringify(result.ssg);

    for (const [name, value] of Object.entries(PLANTED)) {
      expect(
        payload,
        name + ' reached the payload',
      ).not.toContain(value);
    }

    expect(payload).toContain('Aadhaar');
    expect(payload).toContain('Account number');
    expect(payload).toMatch(/⟦AADHAAR_\d+⟧/);

    expect(payload).not.toContain('Users');
    expect(payload).not.toContain('Downloads');
    expect(payload).toContain('"path_shape":"/(local)"');
    expect(payload).toContain('"origin_class":"file"');

    expect(result.redactions['AADHAAR']).toBe(1);
    expect(result.redactions['PAN']).toBe(1);
    expect(result.redactions['EMAIL']).toBe(1);

    expect(payload).toContain('⟦REDACTED_0⟧');
    expect(result.redactions['PASSWORD']).toBeGreaterThanOrEqual(1);

    assertNoFatalErrors(workerErrors);
  });

  test('sees only what is near the viewport, then more after a scroll', async ({
    context,
    serviceWorker,
  }) => {
    const portal = await context.newPage();

    await portal.goto(DEMO_PORTAL_URL);

    const extract = async (): Promise<{
      elements: {
        name?: string;
        client_risk?: string;
      }[];
      page: {
        sensitivity: string;
      };
    }> =>
      serviceWorker.evaluate(async (sessionId) => {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });

        if (tab?.id === undefined) {
          throw new Error('no active tab');
        }

        const r = (await chrome.tabs.sendMessage(tab.id, {
          kind: 'EXTRACT_SCREEN',
          goal: 'test',
          step: 0,
          traceId: 't_0',
          sessionId,
        })) as {
          ssg: {
            elements: {
              name?: string;
              client_risk?: string;
            }[];
            page: {
              sensitivity: string;
            };
          };
        };

        return r.ssg;
      }, SESSION);

    const before = await extract();

    expect(
      before.elements.find((e) => e.name?.includes('Submit')),
    ).toBeUndefined();

    expect(before.page.sensitivity).toBe('credential');

    await portal.evaluate(() => {
      window.scrollTo(
        0,
        document.documentElement.scrollHeight,
      );
    });

    await portal.waitForTimeout(200);

    const after = await extract();

    const submit = after.elements.find((e) =>
      e.name?.includes('Submit'),
    );

    expect(
      submit,
      'submit button should appear once scrolled into range',
    ).toBeDefined();

    expect(submit?.client_risk).toBe('high');
  });
});

test.describe('the guard runs under the real CSP', () => {
  test('a full step completes: guard passes, ledger records the hash', async ({
    context,
    extensionId,
    serviceWorker,
    workerErrors,
  }) => {
    const panel = await context.newPage();

    await panel.goto(
      'chrome-extension://' + extensionId + '/sidepanel.html',
    );

    const portal = await context.newPage();

    await portal.goto(DEMO_PORTAL_URL);

    await panel.evaluate(() => {
      const box = document.querySelector('textarea');

      if (box !== null) {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value',
        )?.set;

        setter?.call(
          box,
          'Apply for the scheme using my saved profile',
        );

        box.dispatchEvent(
          new Event('input', { bubbles: true }),
        );
      }

      const run = [...document.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'Run',
      );

      run?.click();
    });

    await expect
      .poll(
        async () =>
          serviceWorker.evaluate(async () => {
            const bag = await chrome.storage.local.get(
              'prahari.lekha.v1',
            );

            const entries = (
              bag['prahari.lekha.v1'] ?? []
            ) as {
              outcome: string;
            }[];

            return entries.length;
          }),
        {
          timeout: 20_000,
          message: 'no ledger entry was ever written',
        },
      )
      .toBeGreaterThan(0);

    const entries = await serviceWorker.evaluate(async () => {
      const bag = await chrome.storage.local.get(
        'prahari.lekha.v1',
      );

      return (
        bag['prahari.lekha.v1'] ?? []
      ) as {
        outcome: string;
        blocked_reason?: string;
        payload_sha256: string;
        byte_len: number;
      }[];
    });

    const first = entries[0];

    expect(first).toBeDefined();

    expect(
      first?.blocked_reason,
      'the guard refused its own payload: ' +
        String(first?.blocked_reason),
    ).toBeUndefined();

    expect(first?.outcome).toBe('attempted');
    expect(first?.payload_sha256).toMatch(
      /^[0-9a-f]{64}$/,
    );

    expect(first?.byte_len).toBeGreaterThan(0);

    await expect
      .poll(
        async () =>
          serviceWorker.evaluate(async () => {
            const bag = await chrome.storage.local.get(
              'prahari.lekha.v1',
            );

            const rows = (
              bag['prahari.lekha.v1'] ?? []
            ) as {
              outcome: string;
            }[];

            return rows.map((r) => r.outcome);
          }),
        {
          timeout: 20_000,
          message: 'the attempted row was never resolved',
        },
      )
      .toContain('sent');

    const resolved = await serviceWorker.evaluate(async () => {
      const bag = await chrome.storage.local.get(
        'prahari.lekha.v1',
      );

      return (
        bag['prahari.lekha.v1'] ?? []
      ) as {
        outcome: string;
        payload_sha256: string;
      }[];
    });

    const sent = resolved.find(
      (e) => e.outcome === 'sent',
    );

    expect(sent?.payload_sha256).toBe(
      first?.payload_sha256,
    );

    assertNoFatalErrors(workerErrors);
  });
});

test.describe('the diff viewer shows what actually left (D16)', () => {
  test(
    'renders the exact bytes, masked previews, and no recoverable value',
    async ({
      context,
      extensionId,
      serviceWorker,
      workerErrors,
    }) => {
      const panel = await context.newPage();

      await panel.goto(
        'chrome-extension://' +
          extensionId +
          '/sidepanel.html',
      );

      // IMPORTANT:
      // Make sure the side panel itself has fully rendered before
      // starting the asynchronous agent loop.
      await expect(
        panel.getByRole('heading', {
          name: 'PRAHARI',
        }),
      ).toBeVisible();

      await expect(
        panel.getByRole('button', {
          name: 'Run',
          exact: true,
        }),
      ).toBeVisible();

      const portal = await context.newPage();

      await portal.goto(DEMO_PORTAL_URL);

      await panel.evaluate(() => {
        const box = document.querySelector('textarea');

        if (box !== null) {
          const setter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            'value',
          )?.set;

          setter?.call(
            box,
            'Apply for the scheme using my saved profile',
          );

          box.dispatchEvent(
            new Event('input', { bubbles: true }),
          );
        }

        [...document.querySelectorAll('button')]
          .find(
            (b) => b.textContent?.trim() === 'Run',
          )
          ?.click();
      });

      // Wait for an actual ledger entry.
      await expect
        .poll(
          async () =>
            serviceWorker.evaluate(async () => {
              const bag = await chrome.storage.local.get(
                'prahari.lekha.v1',
              );

              return (
                (
                  bag['prahari.lekha.v1'] ?? []
                ) as unknown[]
              ).length;
            }),
          {
            timeout: 20_000,
            message:
              'no ledger entry was written for the diff viewer',
          },
        )
        .toBeGreaterThan(0);

      // The panel might have been left in a transient React render
      // state while the loop was running. Verify it is still alive
      // before looking for the Ledger tab.
      await expect(
        panel.getByRole('heading', {
          name: 'PRAHARI',
        }),
      ).toBeVisible();

      // App.tsx explicitly renders these as role="tab", so target
      // the real semantic role instead of a generic button.
      const ledgerTab = panel.getByRole('tab', {
        name: /^Ledger/,
      });

      await expect(
        ledgerTab,
        'Ledger tab never rendered in the side panel',
      ).toBeVisible({
        timeout: 10_000,
      });

      await ledgerTab.click();

      // The Ledger tab performs an async GET_LEDGER refresh.
      await expect(
        panel.getByRole('heading', {
          name: 'Privacy ledger (LEKHA)',
        }),
      ).toBeVisible({
        timeout: 10_000,
      });

      const inspectButtons = panel.getByRole('button', {
        name: /What the server saw/,
      });

      await expect(
        inspectButtons.first(),
        'ledger rendered but no diff viewer button was available',
      ).toBeVisible({
        timeout: 10_000,
      });

      // The newest entry is rendered first because App.tsx reverses
      // the stored ledger before rendering.
      await inspectButtons.first().click();

      await expect(
        panel.getByRole('heading', {
          name: 'The exact bytes that left',
        }),
      ).toBeVisible({
        timeout: 10_000,
      });

      const shown = await panel.evaluate(
        () => document.body.innerText,
      );

      // Everything the audience can read on this screen,
      // and none of it is a secret.
      for (const [name, value] of Object.entries(PLANTED)) {
        expect(
          shown,
          name + ' was displayed in the viewer',
        ).not.toContain(value);
      }

      // The payload pane really is the payload.
      expect(shown).toMatch(/⟦AADHAAR_\d+⟧/);

      expect(shown).toContain(
        'SHA-256 of the exact bytes',
      );

      // Masked previews are shown.
      expect(shown).toContain('••');

      // Conventional last four of Aadhaar.
      expect(shown).toContain('0124');

      // Credentials have no recoverable preview.
      expect(shown).toContain('never stored');

      assertNoFatalErrors(workerErrors);
    },
  );

  test('the diff row label is redacted too, not just the preview', async ({
    context,
    serviceWorker,
    workerErrors,
  }) => {
    const portal = await context.newPage();

    await portal.goto(DEMO_PORTAL_URL);

    await portal.evaluate((planted) => {
      const field = document.querySelector('input');

      if (field === null) {
        throw new Error('no input on the demo portal');
      }

      field.setAttribute(
        'aria-label',
        'Delete Aadhaar ' + planted.aadhaar,
      );

      field.setAttribute(
        'title',
        'Registered to ' + planted.email,
      );
    }, PLANTED);

    const rows = await serviceWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (tab?.id === undefined) {
        throw new Error('no active tab');
      }

      const reply = (await chrome.tabs.sendMessage(tab.id, {
        kind: 'EXTRACT_SCREEN',
        goal: 'test',
        step: 0,
        traceId: 't_0',
        sessionId: 'eph_ddeeff001122',
      })) as {
        diff: {
          label: string;
          preview: string | null;
          token: string;
        }[];
      };

      return reply.diff;
    });

    expect(rows.length).toBeGreaterThan(0);

    const crossed = JSON.stringify(rows);

    for (const [name, value] of Object.entries(PLANTED)) {
      expect(
        crossed,
        name + ' crossed the message boundary on a diff row',
      ).not.toContain(value);
    }

    const labelled = rows.find(
      (r) => r.label.length > 0,
    );

    expect(
      labelled,
      'every diff row lost its label',
    ).toBeDefined();

    expect(labelled?.label).toMatch(
      /⟦[A-Z][A-Z0-9_]*_\d+⟧|Aadhaar|Delete|Full name/,
    );

    assertNoFatalErrors(workerErrors);
  });
});

test.describe('the glass-box overlay (D15)', () => {
  test('boxes the redacted fields and never becomes clickable content', async ({
    context,
    serviceWorker,
  }) => {
    const portal = await context.newPage();

    await portal.goto(DEMO_PORTAL_URL);

    await serviceWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (tab?.id === undefined) {
        throw new Error('no active tab');
      }

      await chrome.tabs.sendMessage(tab.id, {
        kind: 'SET_OVERLAY',
        enabled: true,
      });

      await chrome.tabs.sendMessage(tab.id, {
        kind: 'EXTRACT_SCREEN',
        goal: 'test',
        step: 0,
        traceId: 't_0',
        sessionId: 'eph_aabbccdd1122',
      });
    });

    await expect
      .poll(
        async () =>
          portal.evaluate(() => {
            const el =
              document.getElementById('prahari-glassbox');

            return (
              el?.shadowRoot?.querySelectorAll('.box')
                .length ?? 0
            );
          }),
        {
          timeout: 5_000,
          message: 'the overlay never painted a box',
        },
      )
      .toBeGreaterThan(3);

    const pointerEvents = await portal.evaluate(() => {
      const host = document.getElementById(
        'prahari-glassbox',
      );

      return host === null
        ? ''
        : getComputedStyle(host).pointerEvents;
    });

    expect(pointerEvents).toBe('none');

    const ssg = await serviceWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (tab?.id === undefined) {
        throw new Error('no active tab');
      }

      const r = (await chrome.tabs.sendMessage(tab.id, {
        kind: 'EXTRACT_SCREEN',
        goal: 'test',
        step: 1,
        traceId: 't_1',
        sessionId: 'eph_aabbccdd1122',
      })) as {
        ssg: unknown;
      };

      return JSON.stringify(r.ssg);
    });

    expect(ssg).not.toContain('prahari-glassbox');
    expect(ssg).not.toContain('not stored');

    await serviceWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (tab?.id === undefined) {
        throw new Error('no active tab');
      }

      await chrome.tabs.sendMessage(tab.id, {
        kind: 'SET_OVERLAY',
        enabled: false,
      });
    });

    expect(
      await portal.evaluate(
        () =>
          document.getElementById(
            'prahari-glassbox',
          ) !== null,
      ),
    ).toBe(false);
  });
});

test.describe('the live canary audit (D17)', () => {
  test('reports 0 leaked, reports what was observed, and restores the page', async ({
    context,
    extensionId,
    workerErrors,
  }) => {
    const panel = await context.newPage();

    await panel.goto(
      'chrome-extension://' + extensionId + '/sidepanel.html',
    );

    const portal = await context.newPage();

    await portal.goto(DEMO_PORTAL_URL);

    const htmlBefore = await portal.evaluate(
      () => document.body.innerHTML,
    );

    const audit = (await panel.evaluate(async () => {
      const browserApi = (
        globalThis as unknown as {
          chrome: typeof chrome;
        }
      ).chrome;

      return (await browserApi.runtime.sendMessage({
        kind: 'RUN_CANARY_AUDIT',
      })) as unknown;
    })) as {
      total: number;
      observed: number;
      leaked: number;
      piiTotal: number;
      requiredTotal: number;
      requiredObserved: number;
      guardBlocked: boolean;
      surfaces: {
        surface: string;
        observed: number;
        planted: number;
        required: boolean;
      }[];
    };

    expect(audit.total).toBe(60);
    expect(audit.leaked).toBe(0);

    expect(audit.guardBlocked).toBe(true);

    expect(audit.requiredObserved).toBe(
      audit.requiredTotal,
    );

    expect(audit.requiredTotal).toBeGreaterThan(0);

    for (const surface of [
      'input_value',
      'placeholder',
      'alt',
      'title',
      'aria_label',
    ]) {
      const row = audit.surfaces.find(
        (s) => s.surface === surface,
      );

      expect(
        row,
        surface + ' missing from the report',
      ).toBeDefined();

      expect(
        row?.observed,
        surface + ' was never read by the harvester',
      ).toBeGreaterThan(0);
    }

    for (const surface of [
      'canvas_pixels',
      'css_content',
      'same_origin_iframe',
    ]) {
      const row = audit.surfaces.find(
        (s) => s.surface === surface,
      );

      expect(
        row?.required,
        surface + ' should not be a required surface yet',
      ).toBe(false);

      expect(
        row?.observed,
        surface + ' claims to be read, but nothing reads it',
      ).toBe(0);
    }

    const htmlAfter = await portal.evaluate(
      () => document.body.innerHTML,
    );

    expect(htmlAfter).toBe(htmlBefore);

    expect(htmlAfter).not.toContain(
      'PRAHARICANARY',
    );

    assertNoFatalErrors(workerErrors);
  });
});