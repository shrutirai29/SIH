/**
 * MANTRI stand-in for the walking skeleton.
 *
 * Zero dependencies, plain Node. It exists so the loop can run end-to-end today,
 * before vLLM and FastAPI are stood up (which need Python 3.12 + a GPU that this
 * project does not have yet). It returns a HARD-CODED plan - there is no model here
 * and it must never be shown to a judge as if there were (RULES.md D5).
 *
 * It does two useful things beyond echoing:
 *   1. It runs a coarse ingress PII sweep, so a client-side redaction bug is loud
 *      from day one rather than silent until Phase 3.
 *   2. It refuses unknown ssg_version majors, exercising the 409 path.
 *
 * Run:  node tools/mock-server/index.mjs        (defaults to :8080)
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8080);

/**
 * Coarse mirror of the client L1 pack. Deliberately NOT the full pack - the real
 * Python mirror plus its parity test is ticket F4. This is here to catch the obvious.
 */
const INGRESS_PATTERNS = [
  ['AADHAAR_SHAPE', /\b[2-9][0-9]{3}[\s-]?[0-9]{4}[\s-]?[0-9]{4}\b/],
  ['EMAIL', /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,24}\b/],
  ['PAN', /\b[A-Z]{5}[0-9]{4}[A-Z]\b/],
  ['CARD_SHAPE', /\b(?:[0-9][ -]?){13,19}\b/],
  ['PHONE_IN', /(?:\+?91[\s-]?)?\b[6-9][0-9]{9}\b/],
  ['GSTIN', /\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/],
  ['IFSC', /\b[A-Z]{4}0[A-Z0-9]{6}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ['PRIVATE_KEY', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
];

function ingressScan(raw) {
  for (const [name, re] of INGRESS_PATTERNS) {
    if (re.test(raw)) return name;
  }
  return null;
}

/** Finds a token of a given class anywhere in the SSG, the way a real planner would. */
function findToken(ssg, cls) {
  const re = new RegExp('⟦' + cls + '_\\d+⟧');
  const m = re.exec(JSON.stringify(ssg));
  return m === null ? null : m[0];
}

/** The element that carried a token, so the plan targets a legitimate sink. */
function elementHolding(ssg, token) {
  for (const el of ssg.elements ?? []) {
    if (JSON.stringify(el).includes(token)) return el.id;
  }
  return null;
}

/** The skeleton's fixed plan. Replaced by a real model in Phase 2/F3. */
function hardCodedPlan(ssg) {
  const step = typeof ssg?.step === 'number' ? ssg.step : 0;

  // Step 1 demonstrates the reverse channel. The server has a REFERENCE to the user's
  // Aadhaar and no idea what it contains; it asks the client to place it back into the
  // field it came from. Only the client can resolve it, and only into that field.
  if (step === 1) {
    const token = findToken(ssg, 'AADHAAR') ?? findToken(ssg, 'EMAIL');
    const target = token === null ? null : elementHolding(ssg, token);
    if (token !== null && target !== null) {
      return {
        plan_id: 'p_' + String(step),
        trace_id: ssg?.trace_id ?? 't_0',
        reasoning:
          'The identifier field is present. I will re-enter it from the reference ' +
          token + '. I do not know, and do not need, its value.',
        actions: [
          { op: 'type', target, value_ref: token, clear_first: true, risk: 'medium' },
        ],
        expect: { page_change: false },
        done: false,
        confidence: 0.9,
      };
    }
  }

  // Alternate scroll / done so the client's loop termination path gets exercised too.
  if (step >= 3) {
    return {
      plan_id: 'p_' + String(step),
      trace_id: ssg?.trace_id ?? 't_0',
      reasoning: 'Skeleton server: stopping after three steps.',
      actions: [{ op: 'done', summary: 'Walking skeleton reached its step limit.' }],
      done: true,
      confidence: 1,
    };
  }

  return {
    plan_id: 'p_' + String(step),
    trace_id: ssg?.trace_id ?? 't_0',
    reasoning: 'Skeleton server: always scrolls, to prove the loop closes.',
    actions: [{ op: 'scroll', direction: 'down', amount: 400, risk: 'safe' }],
    expect: { page_change: false },
    next_tier_hint: 1,
    need_visual: false,
    done: false,
    confidence: 1,
  };
}

function send(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-prahari-session, x-prahari-trace, x-ssg-version',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    ...extraHeaders,
  });
  res.end(payload);
}

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    send(res, 204, {});
    return;
  }

  if (req.method === 'GET' && req.url === '/v1/health') {
    send(res, 200, { status: 'ok', model: 'none (mock)', ssg_versions: ['1.0'] });
    return;
  }

  if (req.method === 'GET' && req.url === '/v1/models') {
    // Honest about being a mock. The real endpoint reports what vLLM has loaded.
    send(res, 200, { loaded: [], note: 'mock server - no model is running' });
    return;
  }

  if (req.method !== 'POST' || req.url !== '/v1/agent/step') {
    send(res, 404, { error: 'NOT_FOUND' });
    return;
  }

  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 4_000_000) {
      req.destroy();
    }
  });

  req.on('end', () => {
    let ssg;
    try {
      ssg = JSON.parse(raw);
    } catch {
      send(res, 400, { error: 'SSG_INVALID', detail: 'body is not JSON' });
      return;
    }

    if (ssg.ssg_version !== '1.0') {
      send(res, 409, { error: 'VERSION_MISMATCH', detail: 'unsupported ssg_version' });
      return;
    }

    const hit = ingressScan(raw);
    if (hit !== null) {
      // The client's redactor failed. Say so loudly; do not process the request.
      console.error('[ingress-guard] REDACTOR_FAILURE class=' + hit + ' trace=' + ssg.trace_id);
      send(res, 422, { error: 'REDACTOR_FAILURE', detail: 'class=' + hit });
      return;
    }

    const plan = hardCodedPlan(ssg);
    console.log(
      '[step] trace=' + ssg.trace_id +
      ' step=' + ssg.step +
      ' tier=' + ssg.tier +
      ' bytes=' + Buffer.byteLength(raw) +
      ' elements=' + (ssg.elements?.length ?? 0) +
      ' -> ' + plan.actions.map((a) => a.op).join(','),
    );
    send(res, 200, plan);
  });
});

server.listen(PORT, () => {
  console.log('PRAHARI mock server (MANTRI stand-in) on http://localhost:' + PORT);
  console.log('  POST /v1/agent/step   GET /v1/health   GET /v1/models');
  console.log('  NOTE: returns a hard-coded plan. No model is running.');
});
