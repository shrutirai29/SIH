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

    const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
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

    await panel.goto('chrome-extension://' + extensionId + '/sidepanel.html');
    await expect(panel.getByRole('heading', { name: 'PRAHARI' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Run', exact: true })).toBeVisible();

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
    await expect(portal.getByLabel('Aadhaar number')).toHaveValue(PLANTED.aadhaar);

    // Drive the content script through the extension's own message API - the same path
    // the agent loop uses, so this exercises injection, extraction, KAVACH and the
    // vault under the real CSP.
    const result = await serviceWorker.evaluate(async (sessionId) => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) throw new Error('no active tab');
      return (await chrome.tabs.sendMessage(tab.id, {
        kind: 'EXTRACT_SCREEN',
        goal: 'Apply for the scheme using my saved profile',
        step: 0,
        traceId: 't_0',
        sessionId,
      })) as { ssg: unknown; redactions: Record<string, number> };
    }, SESSION);

    const payload = JSON.stringify(result.ssg);

    // ---- the actual privacy assertion -------------------------------------
    for (const [name, value] of Object.entries(PLANTED)) {
      expect(payload, name + ' reached the payload').not.toContain(value);
    }

    // ---- and the utility assertion: structure survived --------------------
    // Redaction is an encoding, not a deletion. If the labels vanished too, the server
    // could not plan and the whole design would be pointless.
    expect(payload).toContain('Aadhaar');
    expect(payload).toContain('Account number');
    expect(payload).toMatch(/⟦AADHAAR_\d+⟧/);

    // ---- and the privacy assertion nobody thinks to make -------------------
    // The page URL is never sent. On a file: page the path is the user's home
    // directory, which contains their real name (TODO.md bug #7).
    expect(payload).not.toContain('Users');
    expect(payload).not.toContain('Downloads');
    expect(payload).toContain('"path_shape":"/(local)"');
    expect(payload).toContain('"origin_class":"file"');

    // ---- the manifest must describe the screen accurately ------------------
    // One Aadhaar on the page means one in the manifest. Over-counting is a lie the
    // planner acts on (TODO.md bug #8).
    expect(result.redactions['AADHAAR']).toBe(1);
    expect(result.redactions['PAN']).toBe(1);
    expect(result.redactions['EMAIL']).toBe(1);

    // Credentials collapse onto the irreversible sentinel rather than a numbered token.
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
      elements: { name?: string; client_risk?: string }[];
      page: { sensitivity: string };
    }> =>
      serviceWorker.evaluate(async (sessionId) => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id === undefined) throw new Error('no active tab');
        const r = (await chrome.tabs.sendMessage(tab.id, {
          kind: 'EXTRACT_SCREEN',
          goal: 'test',
          step: 0,
          traceId: 't_0',
          sessionId,
        })) as {
          ssg: {
            elements: { name?: string; client_risk?: string }[];
            page: { sensitivity: string };
          };
        };
        return r.ssg;
      }, SESSION);

    // The submit button sits below a tall spacer, further than a screen and a half
    // away. Not extracting it is correct: the agent must scroll and re-observe, which
    // is exactly the loop the tier ladder is built around.
    const before = await extract();
    expect(before.elements.find((e) => e.name?.includes('Submit'))).toBeUndefined();

    // The password field marks the whole page credential-class from the first look.
    expect(before.page.sensitivity).toBe('credential');

    await portal.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    await portal.waitForTimeout(200);

    const after = await extract();
    const submit = after.elements.find((e) => e.name?.includes('Submit'));
    expect(submit, 'submit button should appear once scrolled into range').toBeDefined();

    // RULES.md S2: risk is the client's call. The server may raise it, never lower it.
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
    // The panel goes in first so the PORTAL stays the active tab; the agent loop
    // targets the active tab, which is what happens in real use where the side panel
    // is not a tab at all.
    const panel = await context.newPage();
    await panel.goto('chrome-extension://' + extensionId + '/sidepanel.html');

    const portal = await context.newPage();
    await portal.goto(DEMO_PORTAL_URL);

    // Click without focusing, so the portal remains the active tab.
    await panel.evaluate(() => {
      const box = document.querySelector('textarea');
      if (box !== null) {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value',
        )?.set;
        setter?.call(box, 'Apply for the scheme using my saved profile');
        box.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const run = [...document.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'Run',
      );
      run?.click();
    });

    // The loop is asynchronous; wait for the ledger to show the step rather than
    // sleeping for an arbitrary interval.
    await expect
      .poll(
        async () =>
          serviceWorker.evaluate(async () => {
            const bag = await chrome.storage.local.get('prahari.lekha.v1');
            const entries = (bag['prahari.lekha.v1'] ?? []) as { outcome: string }[];
            return entries.length;
          }),
        { timeout: 20_000, message: 'no ledger entry was ever written' },
      )
      .toBeGreaterThan(0);

    const entries = await serviceWorker.evaluate(async () => {
      const bag = await chrome.storage.local.get('prahari.lekha.v1');
      return (bag['prahari.lekha.v1'] ?? []) as {
        outcome: string;
        blocked_reason?: string;
        payload_sha256: string;
        byte_len: number;
      }[];
    });

    const first = entries[0];
    expect(first).toBeDefined();

    // What must NOT happen is the guard refusing its own payload - that would mean
    // redaction produced something the guard considers unsafe.
    expect(
      first?.blocked_reason,
      'the guard refused its own payload: ' + String(first?.blocked_reason),
    ).toBeUndefined();

    // An egress is TWO rows. The guard opens `attempted` before the bytes meet the
    // network, because a record written afterwards could be lost to a crash; the
    // network layer closes it once the request resolves. Recording `sent` up front
    // (as this test used to assert) made the ledger claim an egress that never
    // happened every single time the server was unreachable.
    expect(first?.outcome).toBe('attempted');
    expect(first?.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first?.byte_len).toBeGreaterThan(0);

    // The server IS running (playwright.config.ts starts it), so the pair closes as
    // `sent` and both halves name the same bytes.
    await expect
      .poll(
        async () =>
          serviceWorker.evaluate(async () => {
            const bag = await chrome.storage.local.get('prahari.lekha.v1');
            const rows = (bag['prahari.lekha.v1'] ?? []) as { outcome: string }[];
            return rows.map((r) => r.outcome);
          }),
        { timeout: 20_000, message: 'the attempted row was never resolved' },
      )
      .toContain('sent');

    const resolved = await serviceWorker.evaluate(async () => {
      const bag = await chrome.storage.local.get('prahari.lekha.v1');
      return (bag['prahari.lekha.v1'] ?? []) as {
        outcome: string;
        payload_sha256: string;
      }[];
    });
    const sent = resolved.find((e) => e.outcome === 'sent');
    expect(sent?.payload_sha256).toBe(first?.payload_sha256);

    // Bug #5 in one line: if Ajv ever compiles at runtime again, this fails.
    assertNoFatalErrors(workerErrors);
  });
});

test.describe('the diff viewer shows what actually left (D16)', () => {
  test('renders the exact bytes, masked previews, and no recoverable value', async ({
    context,
    extensionId,
    serviceWorker,
    workerErrors,
  }) => {
    const panel = await context.newPage();
    await panel.goto('chrome-extension://' + extensionId + '/sidepanel.html');

    const portal = await context.newPage();
    await portal.goto(DEMO_PORTAL_URL);

    await panel.evaluate(() => {
      const box = document.querySelector('textarea');
      if (box !== null) {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value',
        )?.set;
        setter?.call(box, 'Apply for the scheme using my saved profile');
        box.dispatchEvent(new Event('input', { bubbles: true }));
      }
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent?.trim() === 'Run')
        ?.click();
    });

    // Wait for the step to be recorded, then open its diff through the real UI.
    await expect
      .poll(
        async () =>
          serviceWorker.evaluate(async () => {
            const bag = await chrome.storage.local.get('prahari.lekha.v1');
            return ((bag['prahari.lekha.v1'] ?? []) as unknown[]).length;
          }),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);

    await panel.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent?.includes('Ledger'))
        ?.click();
    });
    await panel.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent?.includes('What the server saw'))
        ?.click();
    });

    await expect(panel.getByText('The exact bytes that left')).toBeVisible();

    const shown = (await panel.evaluate(() => document.body.innerText)) as string;

    // ---- the claim the viewer exists to make ------------------------------
    // Everything the audience can read on this screen, and none of it is a secret.
    for (const [name, value] of Object.entries(PLANTED)) {
      expect(shown, name + ' was displayed in the viewer').not.toContain(value);
    }

    // The payload pane really is the payload: tokens are present and highlighted.
    expect(shown).toMatch(/⟦AADHAAR_\d+⟧/);
    expect(shown).toContain('SHA-256 of the exact bytes');

    // Masked previews are shown, so the user can recognise their own data...
    expect(shown).toContain('••');
    // ...including the conventional last four of their Aadhaar, which is not identity.
    expect(shown).toContain('0124');

    // A credential has no preview at all, because nothing was ever stored.
    expect(shown).toContain('never stored');

    assertNoFatalErrors(workerErrors);
  });

  /**
   * The row's LABEL, not just its preview.
   *
   * `DiffRow` documents itself as carrying "no recoverable value, so it is safe to send
   * to the side panel", and the preview is carefully masked. The label beside it was
   * the RAW accessible name — so on a page whose label is itself identifying, the real
   * string crossed the message boundary and rendered next to the mask of the same data.
   *
   * The demo portal's labels are generic ("Full name", "Aadhaar number"), which is
   * exactly why the test above never noticed. This one plants an identifying label on
   * purpose, which is the only way to ask the question.
   */
  test('the diff row label is redacted too, not just the preview', async ({
    context,
    serviceWorker,
    workerErrors,
  }) => {
    const portal = await context.newPage();
    await portal.goto(DEMO_PORTAL_URL);

    // Labels of the shape real applications actually produce: an action button naming
    // the record it acts on, and a tooltip naming the account it belongs to.
    await portal.evaluate((planted) => {
      const field = document.querySelector('input');
      if (field === null) throw new Error('no input on the demo portal');
      field.setAttribute('aria-label', 'Delete Aadhaar ' + planted.aadhaar);
      field.setAttribute('title', 'Registered to ' + planted.email);
    }, PLANTED);

    const rows = await serviceWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) throw new Error('no active tab');
      const reply = (await chrome.tabs.sendMessage(tab.id, {
        kind: 'EXTRACT_SCREEN',
        goal: 'test',
        step: 0,
        traceId: 't_0',
        sessionId: 'eph_ddeeff001122',
      })) as { diff: { label: string; preview: string | null; token: string }[] };
      return reply.diff;
    });

    expect(rows.length).toBeGreaterThan(0);

    // Nothing crossing the boundary may carry the value, in ANY field of the row.
    const crossed = JSON.stringify(rows);
    for (const [name, value] of Object.entries(PLANTED)) {
      expect(crossed, name + ' crossed the message boundary on a diff row').not.toContain(
        value,
      );
    }

    // And the label is genuinely the redacted text rather than an empty string, so the
    // row is still legible to the user who has to read it.
    const labelled = rows.find((r) => r.label.length > 0);
    expect(labelled, 'every diff row lost its label').toBeDefined();
    expect(labelled?.label).toMatch(/⟦[A-Z][A-Z0-9_]*_\d+⟧|Aadhaar|Delete|Full name/);

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
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) throw new Error('no active tab');
      await chrome.tabs.sendMessage(tab.id, { kind: 'SET_OVERLAY', enabled: true });
      await chrome.tabs.sendMessage(tab.id, {
        kind: 'EXTRACT_SCREEN',
        goal: 'test',
        step: 0,
        traceId: 't_0',
        sessionId: 'eph_aabbccdd1122',
      });
    });

    // Boxes live in a shadow root so the page cannot style or read them.
    //
    // Polled, not read once: `setMarks` paints on the next `requestAnimationFrame`, so
    // reading immediately after the extract call is a race the test happened to win
    // while extraction was fast enough. It stopped winning the moment extraction did
    // one more `await`, which is a bad reason for a privacy test to go red.
    await expect
      .poll(
        async () =>
          portal.evaluate(() => {
            const el = document.getElementById('prahari-glassbox');
            return el?.shadowRoot?.querySelectorAll('.box').length ?? 0;
          }),
        { timeout: 5_000, message: 'the overlay never painted a box' },
      )
      .toBeGreaterThan(3);

    // It must not intercept clicks, or the agent (and the user) cannot use the page.
    const pointerEvents = await portal.evaluate(() => {
      const host = document.getElementById('prahari-glassbox');
      return host === null ? '' : getComputedStyle(host).pointerEvents;
    });
    expect(pointerEvents).toBe('none');

    // ---- the mistake this feature could make ------------------------------
    // The overlay adds elements to the page. If extraction then walked them, the agent
    // would see its own markers as clickable targets and could act on them.
    const ssg = await serviceWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) throw new Error('no active tab');
      const r = (await chrome.tabs.sendMessage(tab.id, {
        kind: 'EXTRACT_SCREEN',
        goal: 'test',
        step: 1,
        traceId: 't_1',
        sessionId: 'eph_aabbccdd1122',
      })) as { ssg: unknown };
      return JSON.stringify(r.ssg);
    });
    expect(ssg).not.toContain('prahari-glassbox');
    expect(ssg).not.toContain('not stored');

    // Turning it off removes the host entirely rather than hiding it.
    await serviceWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) throw new Error('no active tab');
      await chrome.tabs.sendMessage(tab.id, { kind: 'SET_OVERLAY', enabled: false });
    });
    expect(
      await portal.evaluate(() => document.getElementById('prahari-glassbox') !== null),
    ).toBe(false);
  });
});

test.describe('the live canary audit (D17)', () => {
  test('reports 0 leaked, reports what was observed, and restores the page', async ({
    context,
    extensionId,
    workerErrors,
  }) => {
    // Driven from the side panel rather than the service worker, because a worker's
    // own `runtime.sendMessage` is not delivered to its own listener. Going through
    // the real UI is the better test regardless: it is the path a user takes.
    const panel = await context.newPage();
    await panel.goto('chrome-extension://' + extensionId + '/sidepanel.html');

    // Portal opened second so it stays the active tab, which is what the audit targets.
    const portal = await context.newPage();
    await portal.goto(DEMO_PORTAL_URL);

    const htmlBefore = await portal.evaluate(() => document.body.innerHTML);

    const audit = (await panel.evaluate(async () => {
      const browserApi = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      return (await browserApi.runtime.sendMessage({ kind: 'RUN_CANARY_AUDIT' })) as unknown;
    })) as {
      total: number;
      observed: number;
      leaked: number;
      piiTotal: number;
      requiredTotal: number;
      requiredObserved: number;
      guardBlocked: boolean;
      surfaces: { surface: string; observed: number; planted: number; required: boolean }[];
    };

    // The headline claim. `leaked` now comes from running the REAL extractor over the
    // planted page and searching the bytes it produced - not from offering synthetic
    // payloads to the guard, which would report a clean 0/60 with the redactor deleted.
    expect(audit.total).toBe(60);
    expect(audit.leaked).toBe(0);

    // The independent backstop, asked as a separate question.
    expect(audit.guardBlocked).toBe(true);

    // And the half that stops the headline being vacuous: the reader must actually
    // read every surface it is expected to read. A zero here would mean nothing looked.
    expect(audit.requiredObserved).toBe(audit.requiredTotal);
    expect(audit.requiredTotal).toBeGreaterThan(0);
    for (const surface of ['input_value', 'placeholder', 'alt', 'title', 'aria_label']) {
      const row = audit.surfaces.find((s) => s.surface === surface);
      expect(row, surface + ' missing from the report').toBeDefined();
      expect(row?.observed, surface + ' was never read by the harvester').toBeGreaterThan(0);
    }

    // Surfaces nothing reads yet are reported honestly as unread rather than being
    // planted somewhere convenient so they look covered. Canvas needs Tier 2; CSS
    // generated content and cross-frame text need B4/B5.
    for (const surface of ['canvas_pixels', 'css_content', 'same_origin_iframe']) {
      const row = audit.surfaces.find((s) => s.surface === surface);
      expect(row?.required, surface + ' should not be a required surface yet').toBe(false);
      expect(row?.observed, surface + ' claims to be read, but nothing reads it').toBe(0);
    }

    // The audit writes into the live page. It must leave nothing behind.
    const htmlAfter = await portal.evaluate(() => document.body.innerHTML);
    expect(htmlAfter).toBe(htmlBefore);
    expect(htmlAfter).not.toContain('PRAHARICANARY');

    assertNoFatalErrors(workerErrors);
  });
});
