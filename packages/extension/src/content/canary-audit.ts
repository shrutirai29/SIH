/**
 * The live canary audit (ticket D17).
 *
 * Plants unique strings across every surface a value can hide in, runs the real
 * extraction pipeline over the real page, and reports two numbers:
 *
 *   OBSERVED — how many canaries the harvester actually *saw*. This is the half
 *              everyone forgets. If extraction never reads `data-*`, a canary planted
 *              there is absent from the payload because nothing looked, not because
 *              redaction worked. A leak count alone can be passed by a broken reader.
 *
 *   LEAKED   — how many reached a payload the guard was willing to send. This is the
 *              number on the slide, and it must be zero.
 *
 * Only both together mean anything (see `canary.ts` in @prahari/kavach).
 *
 * ## Why it mutates the live page
 *
 * Because a test against a synthetic page proves things about the synthetic page. The
 * audit writes canaries into the actual DOM the user is looking at, runs the pipeline,
 * and restores every mutation in a `finally`. Nothing is left behind, and the plants
 * are `data-` attributes and off-screen nodes, so the page's own behaviour is untouched.
 */

import {
  generateCanaries,
  generatePiiCanaries,
  HARVEST_REQUIRED_SURFACES,
  type Canary,
  type CanarySurface,
  type PiiCanary,
} from '@prahari/kavach';
import { extractScreen, harvestSurfaces } from './extract.js';

const PLANT_ID = 'prahari-canary-plant';
const PLANT_STYLE_ID = 'prahari-canary-style';

interface Restore {
  undo(): void;
}

/**
 * Writes canaries into the page.
 *
 * Surfaces that exist on any page get their own off-screen host. Surfaces that only
 * mean something on *real* elements — `data-*`, `title`, `aria-label` — are written
 * onto existing visible inputs, because those are the elements extraction actually
 * walks. Planting only into a synthetic node would let a broken harvester pass.
 */
function plant(canaries: readonly (Canary | PiiCanary)[]): Restore {
  const undos: (() => void)[] = [];
  const bySurface = new Map<CanarySurface, (Canary | PiiCanary)[]>();
  for (const c of canaries) {
    const list = bySurface.get(c.surface) ?? [];
    list.push(c);
    bySurface.set(c.surface, list);
  }

  /**
   * CONSUMES the canaries for a surface. It used to return the list without removing
   * it, and `data_attribute` is taken twice — once for the synthetic host and once for
   * the real page fields — so both plants got the SAME five values. The second plant
   * could then never fail independently: the first satisfied it. Consuming makes the
   * two plants disjoint, which is what makes the "does the extractor read attributes
   * on elements it actually walks?" question answerable.
   */
  const take = (s: CanarySurface): (Canary | PiiCanary)[] => {
    const list = bySurface.get(s) ?? [];
    bySurface.set(s, []);
    return list;
  };

  // --- synthetic host, positioned off-screen but genuinely rendered ------------
  // `display:none` would be skipped by extraction, which would make the whole audit
  // vacuous. It has to be laid out and visible to the same rules as any other element.
  const host = document.createElement('div');
  host.id = PLANT_ID;
  host.style.cssText =
    'position:absolute;left:0;top:0;width:320px;height:auto;opacity:0.01;' +
    'pointer-events:none;z-index:-1';

  const addInput = (value: string, attrs: Record<string, string> = {}): void => {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    for (const [k, v] of Object.entries(attrs)) input.setAttribute(k, v);
    host.appendChild(input);
  };

  for (const c of take('input_value')) addInput(c.value);
  for (const c of take('placeholder')) addInput('', { placeholder: c.value });
  for (const c of take('aria_label')) addInput('', { 'aria-label': c.value });
  for (const c of take('title')) addInput('', { title: c.value });

  // Split, not duplicated: half onto the synthetic host, half onto real page fields
  // further down. Two independent questions, two disjoint sets of canaries.
  const dataCanaries = take('data_attribute');
  const dataOnHost = dataCanaries.slice(0, Math.ceil(dataCanaries.length / 2));
  const dataOnRealFields = dataCanaries.slice(dataOnHost.length);
  for (const c of dataOnHost) addInput('', { 'data-canary': c.value });

  for (const c of take('hidden_input')) {
    // A hidden input is not extracted as an element, but its value is exactly the
    // sort of thing that ends up serialised elsewhere, so the harvester must read it.
    const input = document.createElement('input');
    input.type = 'hidden';
    input.value = c.value;
    input.setAttribute('data-canary-hidden', c.value);
    host.appendChild(input);
  }

  for (const c of take('alt')) {
    const img = document.createElement('img');
    // 1x1 transparent GIF: no network request, still a real <img> with an alt.
    img.src =
      'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    img.alt = c.value;
    img.width = 8;
    img.height = 8;
    host.appendChild(img);
  }

  for (const c of take('option_text')) {
    const select = document.createElement('select');
    const option = document.createElement('option');
    option.textContent = c.value;
    select.appendChild(option);
    host.appendChild(select);
  }

  for (const c of take('dom_text')) {
    const p = document.createElement('p');
    p.textContent = c.value;
    host.appendChild(p);
  }

  // CSS ::after content is invisible to textContent and is a known hiding place.
  //
  // This used to be planted as a `data-css-canary` attribute, which the harvester
  // reads — so the report showed css_content 5/5 observed while no CSS was involved
  // and the surface was never actually tested. It is now real generated content, and
  // it is expected to come back UNOBSERVED: nothing reads computed styles yet. That
  // honest zero is worth more than a five that measured a different surface.
  const cssCanaries = take('css_content');
  if (cssCanaries.length > 0) {
    const style = document.createElement('style');
    style.id = PLANT_STYLE_ID;
    const rules: string[] = [];
    cssCanaries.forEach((c, i) => {
      const span = document.createElement('span');
      span.className = 'prahari-css-canary-' + String(i);
      host.appendChild(span);
      rules.push('.prahari-css-canary-' + String(i) + '::after{content:"' + c.value + '"}');
    });
    style.textContent = rules.join('\n');
    document.head.appendChild(style);
    undos.push(() => {
      style.remove();
    });
  }

  // A genuine same-origin iframe, for the same reason: it used to be a `<span>`, which
  // the harvester reads trivially. The manifest sets `all_frames: false`, so this is
  // also expected to be unobserved until B4 stitches frames — which is precisely the
  // gap the audit should be reporting rather than papering over.
  for (const c of take('same_origin_iframe')) {
    const frame = document.createElement('iframe');
    frame.width = '120';
    frame.height = '20';
    frame.setAttribute('title', 'prahari canary frame');
    frame.srcdoc = '<p>' + c.value + '</p>';
    host.appendChild(frame);
  }

  for (const c of take('canvas_pixels')) {
    // Nothing reads pixels yet (Tier 2 does not exist), so this canary is expected to
    // be UNOBSERVED. The audit reports that honestly rather than hiding it.
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 24;
    const ctx = canvas.getContext('2d');
    if (ctx !== null) {
      ctx.font = '12px monospace';
      ctx.fillText(c.value, 2, 16);
    }
    host.appendChild(canvas);
  }

  document.body.appendChild(host);
  undos.push(() => {
    host.remove();
  });

  // --- plants on REAL elements the extractor already walks --------------------
  const realFields = [...document.querySelectorAll('input:not([type=hidden]), textarea')]
    .filter((el) => !host.contains(el))
    .slice(0, 6);

  realFields.forEach((el, i) => {
    const canary = dataOnRealFields[i];
    if (canary === undefined) return;
    const had = el.getAttribute('data-prahari-audit');
    el.setAttribute('data-prahari-audit', canary.value);
    undos.push(() => {
      if (had === null) el.removeAttribute('data-prahari-audit');
      else el.setAttribute('data-prahari-audit', had);
    });
  });

  return {
    undo(): void {
      // Reverse order, so nested restorations unwind correctly.
      for (let i = undos.length - 1; i >= 0; i--) undos[i]?.();
    },
  };
}

export interface SurfaceResult {
  readonly surface: string;
  readonly planted: number;
  readonly observed: number;
  readonly leaked: number;
  /** True when the harvester is expected to read this surface today. */
  readonly required: boolean;
}

export interface AuditReport {
  readonly total: number;
  readonly observed: number;
  /** PII canaries that survived into the payload. Must be zero. */
  readonly leaked: number;
  readonly piiTotal: number;
  /** Canaries on surfaces the harvester MUST read (`HARVEST_REQUIRED_SURFACES`). */
  readonly requiredTotal: number;
  readonly requiredObserved: number;
  readonly surfaces: SurfaceResult[];
  /** Canary values, so the background can configure the guard for this run. */
  readonly values: string[];
  /** The real payload the real extractor produced over the planted page. */
  readonly payload: string;
  readonly ranAt: number;
}

const REQUIRED: ReadonlySet<string> = new Set(HARVEST_REQUIRED_SURFACES);

/**
 * Plants, runs the REAL pipeline, and reports. Restoration happens in a `finally` so a
 * throw part-way through cannot leave canaries in the user's page.
 *
 * ## Why this calls `extractScreen` rather than checking a synthetic payload
 *
 * The number on the slide is "0 / 60 leaked", and it is only worth saying if it is a
 * statement about the redactor. An earlier version scored the audit by handing each
 * canary to the egress guard inside a hand-built SSG the extractor had never touched —
 * so it measured the guard's `serialised.includes(canary)` string search, on payloads
 * the pipeline never produced, and would have reported a clean 0/60 with the redactor
 * removed entirely.
 *
 * So the audit now runs the actual extractor over the actual planted page and searches
 * the actual bytes. The guard is still exercised afterwards, in the background, as a
 * SECOND and independent question — but the headline number is now about the component
 * whose name is on it.
 */
export async function runCanaryAudit(perSurface = 5): Promise<AuditReport> {
  const canaries = generateCanaries(perSurface);
  // Planted on the same surfaces, and scored separately. See `PiiCanary` in
  // @prahari/kavach for why one set cannot answer both questions.
  const piiCanaries = generatePiiCanaries(1);
  const planted = plant([...canaries, ...piiCanaries]);

  try {
    // 1. OBSERVED — harvest through exactly the code extraction uses. If this misses a
    //    surface, the real pipeline misses it too, which is the point of measuring.
    const seen = new Set<string>();
    const collect = (text: string): void => {
      for (const c of canaries) {
        if (text.includes(c.value)) seen.add(c.value);
      }
    };

    for (const el of document.querySelectorAll('*')) {
      for (const surface of harvestSurfaces(el)) collect(surface);
    }
    collect(document.body.innerText);

    // 2. LEAKED — the real extractor, over the real page, against a throwaway vault so
    //    a task in flight keeps its tokens and its element ids.
    const { ssg } = await extractScreen({
      goal: 'canary audit',
      step: 0,
      traceId: 't_0',
      sessionId: 'eph_ca4a2b3c4d5e',
      ephemeral: true,
    });
    const payload = JSON.stringify(ssg);

    // A LEAK is a PII canary that survived into the payload. The conspicuous canaries
    // are not scored here on purpose: they are not personal data, no detector claims
    // them, and a Tier-1 payload legitimately carries page text — so one of those in
    // the payload is correct behaviour, not a leak. Counting them as leaks (or, worse,
    // scoring the audit on synthetic probes the pipeline never touched) is how this
    // number stops meaning anything.
    const leakedPii = piiCanaries.filter((c) => payload.includes(c.value));
    const leakedIds = new Set(leakedPii.map((c) => c.id));

    const bySurface = new Map<string, { planted: number; observed: number; leaked: number }>();
    const bucketFor = (surface: string) => {
      const b = bySurface.get(surface) ?? { planted: 0, observed: 0, leaked: 0 };
      bySurface.set(surface, b);
      return b;
    };
    for (const c of canaries) {
      const bucket = bucketFor(c.surface);
      bucket.planted++;
      if (seen.has(c.value)) bucket.observed++;
    }
    for (const c of piiCanaries) {
      if (leakedIds.has(c.id)) bucketFor(c.surface).leaked++;
    }

    const required = canaries.filter((c) => REQUIRED.has(c.surface));

    return {
      total: canaries.length,
      observed: seen.size,
      leaked: leakedPii.length,
      piiTotal: piiCanaries.length,
      requiredTotal: required.length,
      requiredObserved: required.filter((c) => seen.has(c.value)).length,
      surfaces: [...bySurface.entries()].map(([surface, b]) => ({
        surface,
        planted: b.planted,
        observed: b.observed,
        leaked: b.leaked,
        required: REQUIRED.has(surface),
      })),
      values: canaries.map((c) => c.value),
      payload,
      ranAt: Date.now(),
    };
  } finally {
    planted.undo();
  }
}
