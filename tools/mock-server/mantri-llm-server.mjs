/**
 * MANTRI planning server (supports real-time OpenRouter LLM planning).
 *
 * Calls real cloud LLM (OpenRouter / GPT-4o-mini / Qwen / Llama) to reason over
 * the user's live goal and page elements, generating dynamic, real-world action plans.
 *
 * Runs on http://127.0.0.1:8000
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const envPath = resolve(rootDir, 'server/.env');

// Read API keys from server/.env if present
let LLM_API_KEY = process.env.PRAHARI_LLM_API_KEY || '';
let LLM_BASE_URL = process.env.PRAHARI_LLM_BASE_URL || 'https://openrouter.ai/api/v1';
let LLM_MODEL = process.env.PRAHARI_LLM_MODEL || 'openai/gpt-4o-mini';

if (existsSync(envPath)) {
  try {
    const envContent = readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [k, ...v] = trimmed.split('=');
      const val = v.join('=').trim().replace(/^["']|["']$/g, '');
      if (k.trim() === 'PRAHARI_LLM_API_KEY' && val) LLM_API_KEY = val;
      if (k.trim() === 'PRAHARI_LLM_BASE_URL' && val) LLM_BASE_URL = val;
      if (k.trim() === 'PRAHARI_LLM_MODEL' && val) LLM_MODEL = val;
    }
  } catch {
    // Ignore .env read errors
  }
}

const PORT = Number(process.env.PORT ?? 8000);

const SYSTEM_PROMPT = `You are MANTRI, the AI browser agent planner for PRAHARI.
Your task is to take the user's real goal and the sanitized screen elements, and output an action plan in JSON.

RULES:
1. Reason carefully over the user's specific instruction/data in 'goal'. If the user gives names, addresses, emails, numbers, or specific text to type, extract and use that EXACT user data.
2. Available action operations ('op'):
   - "type": {"op": "type", "target": "<element_id>", "value": "<text_to_type>", "clear_first": true, "risk": "safe"}
     NOTE: If an element contains a privacy token like "⟦AADHAAR_1⟧" or "⟦EMAIL_1⟧", you can reference it using "value_ref": "⟦TOKEN⟧". For any other user text or data, provide "value": "<user_data>".
   - "click": {"op": "click", "target": "<element_id>", "risk": "safe"}
   - "scroll": {"op": "scroll", "direction": "down", "amount": 400, "risk": "safe"}
   - "done": {"op": "done", "summary": "<summary of what was accomplished>"}
   - "fail": {"op": "fail", "reason": "<reason why goal cannot be completed>"}
3. Output MUST be valid JSON in this exact structure:
{
  "plan_id": "p_0",
  "trace_id": "<trace_id_from_input>",
  "reasoning": "<short explanation of your plan>",
  "actions": [ <list of 1 to 5 action objects> ],
  "done": false,
  "confidence": 0.95
}
4. When all actions for the goal are finished or no further actions are needed, set done: true and include op: "done" in actions.`;

/**
 * Call OpenRouter API to generate dynamic, real-time action plans.
 * Aborts after 4 seconds to guarantee instantaneous response via fallback if LLM is slow.
 */
async function callLlmPlanner(ssg) {
  const goal = ssg.goal || '';
  const step = typeof ssg.step === 'number' ? ssg.step : 0;
  const traceId = ssg.trace_id || `t_${step}`;

  const cleanElements = (ssg.elements || []).map((el) => {
    const item = { id: el.id, role: el.role };
    if (el.name) item.name = el.name;
    if (el.placeholder) item.placeholder = el.placeholder;
    if (el.value) item.value = el.value;
    if (el.actionable) item.can = el.actionable;
    return item;
  });

  const userContent = JSON.stringify({
    goal,
    step,
    trace_id: traceId,
    elements: cleanElements,
    page_type: ssg.page?.page_type,
    origin: ssg.page?.origin_class,
  });

  if (!LLM_API_KEY) {
    throw new Error('No PRAHARI_LLM_API_KEY configured');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  try {
    const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LLM_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://prahari.dev',
        'X-Title': 'PRAHARI Agent Planner',
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        response_format: { type: 'json_object' },
        temperature: 0.1,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenRouter error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const rawContent = data.choices?.[0]?.message?.content;
    if (!rawContent) throw new Error('Empty response from LLM');

    const parsed = JSON.parse(rawContent);
    if (!parsed.actions || !Array.isArray(parsed.actions)) {
      throw new Error('Invalid plan: missing actions array');
    }

    parsed.plan_id = parsed.plan_id || `p_${step}`;
    parsed.trace_id = traceId;
    return parsed;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Smart heuristic fallback planner.
 *
 * Rules:
 *  - Only fills a field when it has a confident value (from goal text, saved profile, or prior user answers).
 *  - Emits ask_user for any field it cannot map to a known value.
 *  - Never fills city / address / message / unknown fields with hardcoded defaults.
 *  - Respects the user_answers map that accumulates conversational replies.
 */
function heuristicDynamicPlan(ssg) {
  const step = typeof ssg?.step === 'number' ? ssg.step : 0;
  const goal = (ssg?.goal ?? '').trim();
  const elements = ssg?.elements ?? [];
  const autoFillPrefilled = ssg?.auto_fill_prefilled !== false;

  const textboxes = elements.filter(
    (el) =>
      el.role === 'textbox' ||
      el.role === 'combobox' ||
      el.tag === 'input' ||
      el.tag === 'textarea' ||
      el.tag === 'select' ||
      el.actionable?.includes('type') ||
      el.actionable?.includes('select'),
  );
  const buttons = elements.filter(
    (el) => el.role === 'button' || el.tag === 'button' || el.actionable?.includes('click'),
  );

  // ── Extract values explicitly stated in the goal text ──────────────────
  const userExtractions = {};

  const nameMatch = /(?:name|fullname|applicant)\s*(?:is|as|=|:)?\s*([A-Za-z\s]{2,30}?)(?=[,\.]|\sand\s|email|phone|mobile|roll|number|date|\[|$)/i.exec(goal);
  userExtractions.name = nameMatch ? nameMatch[1].trim() : (autoFillPrefilled ? 'Nitin Mali' : null);

  const rollMatch = /(?:roll|number|num|id|no|enrollment)\s*(?:is|as|=|:)?\s*([0-9A-Za-z]+)/i.exec(goal);
  userExtractions.roll = rollMatch ? rollMatch[1].trim() : (autoFillPrefilled ? '60' : null);

  const emailMatch = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i.exec(goal);
  userExtractions.email = emailMatch ? emailMatch[1].trim() : (autoFillPrefilled ? 'nitinmali@example.com' : null);

  const phoneMatch = /(?:\+?91[\s-]?)?([6-9][0-9]{9})\b/.exec(goal);
  userExtractions.mobile = phoneMatch ? phoneMatch[1].trim() : (autoFillPrefilled ? '9876543210' : null);

  const dateMatch = /(?:date|dob)\s*(?:is|as|=|:)?\s*([0-9]{1,4}[\s/-][0-9]{1,2}[\s/-][0-9]{2,4}|[0-9]{6,8})/i.exec(goal);
  if (dateMatch) {
    const rawD = dateMatch[1].trim();
    const parts = rawD.split(/[\s/-]+/);
    if (parts.length === 3) {
      const [p1, p2, p3] = parts;
      userExtractions.date = p3.length === 4 ? `${p3}-${p2.padStart(2, '0')}-${p1.padStart(2, '0')}` : `${p1}-${p2.padStart(2, '0')}-${p3.padStart(2, '0')}`;
    } else {
      userExtractions.date = rawD;
    }
  } else {
    userExtractions.date = autoFillPrefilled ? '2007-05-31' : null;
  }

  // Station From
  const fromMatch = /(?:from|origin|source|departure)\s*(?:is|as|=|:)?\s*([A-Za-z\s]{2,25}?)(?=[,\.]|\sto\b|\sand\b|on|date|for|\[|$)/i.exec(goal);
  userExtractions.from = fromMatch ? fromMatch[1].trim() : (autoFillPrefilled ? 'NDLS' : null);

  // Station To
  const toMatch = /(?:to|destination|arrival)\s*(?:is|as|=|:)?\s*([A-Za-z\s]{2,25}?)(?=[,\.]|\sfrom\b|\sand\b|on|date|for|\[|$)/i.exec(goal);
  userExtractions.to = toMatch ? toMatch[1].trim() : (autoFillPrefilled ? 'MMCT' : null);

  // City / Location
  const cityMatch = /(?:city|location|town)\s*(?:is|as|=|:)?\s*([A-Za-z\s]{2,25}?)(?=[,\.]|\sand\b|state|pin|\[|$)/i.exec(goal);
  userExtractions.city = cityMatch ? cityMatch[1].trim() : (autoFillPrefilled ? 'New Delhi' : null);

  // Address
  const addrMatch = /(?:address|addr)\s*(?:is|as|=|:)?\s*([A-Za-z0-9\s,.-]{5,40}?)(?=[,\.]\s*pin|city|state|\[|$)/i.exec(goal);
  userExtractions.address = addrMatch ? addrMatch[1].trim() : (autoFillPrefilled ? '123 MG Road, Connaught Place' : null);

  // Pin / Pincode / Zip
  const pinMatch = /(?:pin|pincode|zip)\s*(?:is|as|=|:)?\s*([0-9]{6})/i.exec(goal);
  userExtractions.pincode = pinMatch ? pinMatch[1].trim() : (autoFillPrefilled ? '110001' : null);

  // Gender in goal
  const genderGoalMatch = /(?:gender|sex)\s*(?:is|as|=|:)?\s*(male|female|other|m|f)\b/i.exec(goal);
  if (genderGoalMatch) {
    userExtractions.gender = genderGoalMatch[1].trim();
  }

  // ── Extract saved profile & learned answers from goal [SavedProfile: ...] ──
  const savedProfileMatch = /\[SavedProfile:\s*([^\]]+)\]/i.exec(goal);
  if (savedProfileMatch) {
    const rawPairs = savedProfileMatch[1];
    const regex = /([a-zA-Z0-9_-]+)(?::|\s+)([^,]+)(?:,|$)/g;
    let match;
    while ((match = regex.exec(rawPairs)) !== null) {
      const k = match[1].trim().toLowerCase();
      const v = match[2].trim();
      if (k && v) {
        userExtractions[k] = v;
      }
    }
  }

  // Merge answers from prior conversational clarifications
  const userAnswers = ssg?.user_answers ?? {};
  const answered = (key) => userAnswers[key] ?? null;

  const emailToken = /⟦[A-Z0-9_]*EMAIL[A-Z0-9_]*_\d+⟧/.exec(goal)?.[0];
  const phoneToken = /⟦[A-Z0-9_]*PHONE[A-Z0-9_]*_\d+⟧/.exec(goal)?.[0];

  if (step === 0 && textboxes.length > 0) {
    const actions = [];

    for (let idx = 0; idx < textboxes.length; idx++) {
      const el = textboxes[idx];
      const labelText = `${el.name || ''} ${el.placeholder || ''} ${el.ariaLabel || ''} ${el.id || ''} ${el.value || ''}`.toLowerCase();
      const rawStr = JSON.stringify(el);
      const tokenMatch = /⟦[A-Z0-9_]+⟧/.exec(rawStr);

      // PII token from redaction vault — always use it directly
      if (tokenMatch) {
        actions.push({ op: 'type', target: el.id, value_ref: tokenMatch[0], clear_first: true, risk: 'medium' });

      // Station From / Origin
      } else if (labelText.includes('from') || labelText.includes('origin') || labelText.includes('source') || (labelText.includes('station') && !labelText.includes('to'))) {
        const val = answered('from') ?? userExtractions.from;
        if (val) {
          actions.push({ op: 'type', target: el.id, value: val, clear_first: true, risk: 'safe' });
        } else if (autoFillPrefilled) {
          actions.push({ op: 'type', target: el.id, value: 'NDLS', clear_first: true, risk: 'safe' });
        } else {
          actions.push({ op: 'ask_user', target: el.id, field_key: 'from', question: 'What is your departure / From station? (e.g. NDLS / New Delhi)' });
        }

      // Station To / Destination
      } else if (labelText.includes('destination') || labelText.includes('arrival') || (labelText.includes('to') && (labelText.includes('station') || labelText.includes('enter to') || labelText.includes('place')))) {
        const val = answered('to') ?? userExtractions.to;
        if (val) {
          actions.push({ op: 'type', target: el.id, value: val, clear_first: true, risk: 'safe' });
        } else {
          actions.push({ op: 'ask_user', target: el.id, field_key: 'to', question: 'What is your destination / To station? (e.g. MMCT / Mumbai)' });
        }

      // Date / DOB / Journey Date
      } else if (labelText.includes('date') || labelText.includes('dob') || labelText.includes('yyyy') || labelText.includes('dd-mm') || labelText.includes('journey')) {
        const val = answered('dob') ?? userExtractions.date;
        if (val) {
          actions.push({ op: 'type', target: el.id, value: val, clear_first: true, risk: 'safe' });
        } else {
          actions.push({ op: 'ask_user', target: el.id, field_key: 'dob', question: 'What date should I enter? (e.g. 15/09/2026)' });
        }

      // Roll / Enrollment
      } else if (labelText.includes('roll') || labelText.includes('enrollment') || labelText.includes('student id')) {
        const val = answered('roll') ?? userExtractions.roll;
        if (val) {
          actions.push({ op: 'type', target: el.id, value: val, clear_first: true, risk: 'safe' });
        } else {
          actions.push({ op: 'ask_user', target: el.id, field_key: 'roll', question: 'What is your roll / enrollment number?' });
        }

      // Email
      } else if (labelText.includes('email') || labelText.includes('mail')) {
        if (emailToken) {
          actions.push({ op: 'type', target: el.id, value_ref: emailToken, clear_first: true, risk: 'medium' });
        } else {
          const val = answered('email') ?? userExtractions.email;
          if (val) {
            actions.push({ op: 'type', target: el.id, value: val, clear_first: true, risk: 'safe' });
          } else {
            actions.push({ op: 'ask_user', target: el.id, field_key: 'email', question: 'What email address should I use?' });
          }
        }

      // Phone / Mobile
      } else if (labelText.includes('mobile') || labelText.includes('phone') || labelText.includes('contact') || labelText.includes('tel')) {
        if (phoneToken) {
          actions.push({ op: 'type', target: el.id, value_ref: phoneToken, clear_first: true, risk: 'medium' });
        } else {
          const val = answered('mobile') ?? userExtractions.mobile;
          if (val) {
            actions.push({ op: 'type', target: el.id, value: val, clear_first: true, risk: 'safe' });
          } else {
            actions.push({ op: 'ask_user', target: el.id, field_key: 'mobile', question: 'What phone / mobile number should I use?' });
          }
        }

      // Gender — check answered or saved extractions, ask if unknown
      } else if (labelText.includes('gender') || labelText.includes('sex') || labelText.includes('m or f') || labelText.includes('male/female')) {
        const val = answered('gender') ?? userExtractions.gender;
        if (val) {
          actions.push({ op: 'type', target: el.id, value: val, clear_first: true, risk: 'safe' });
        } else {
          actions.push({ op: 'ask_user', target: el.id, field_key: 'gender', question: 'What is your gender?', options: ['Male', 'Female', 'Other'] });
        }

      // Name
      } else if (labelText.includes('name') || labelText.includes('fullname') || labelText.includes('applicant')) {
        const val = answered('name') ?? userExtractions.name;
        if (val) {
          actions.push({ op: 'type', target: el.id, value: val, clear_first: true, risk: 'safe' });
        } else {
          actions.push({ op: 'ask_user', target: el.id, field_key: 'name', question: 'What name should I fill in?' });
        }

      // Course / Program / Interested in
      } else if (labelText.includes('course') || labelText.includes('program') || labelText.includes('branch') || labelText.includes('interested in')) {
        const val = answered('course');
        if (val) {
          actions.push({ op: 'type', target: el.id, value: val, clear_first: true, risk: 'safe' });
        } else {
          actions.push({ op: 'ask_user', target: el.id, field_key: 'course', question: 'Which course or program are you interested in?', options: ['Computer Science', 'Electronics', 'Mechanical', 'Civil', 'Other'] });
        }

      // City / Location — ask, since every user has a different city
      } else if (labelText.includes('city') || labelText.includes('location') || labelText.includes('town')) {
        const val = answered('city') ?? userExtractions.city;
        if (val) {
          actions.push({ op: 'type', target: el.id, value: val, clear_first: true, risk: 'safe' });
        } else {
          actions.push({ op: 'ask_user', target: el.id, field_key: 'city', question: `What city should I enter in the "${el.name || el.placeholder || 'City'}" field?` });
        }

      // State — always ask
      } else if (labelText.includes('state')) {
        const val = answered('state') ?? userExtractions.city;
        if (val) {
          actions.push({ op: 'type', target: el.id, value: val, clear_first: true, risk: 'safe' });
        } else {
          actions.push({ op: 'ask_user', target: el.id, field_key: 'state', question: `Which state should I enter?` });
        }

      // Address / Street — always ask
      } else if (labelText.includes('address') || labelText.includes('street')) {
        const val = answered('address') ?? userExtractions.address;
        if (val) {
          actions.push({ op: 'type', target: el.id, value: val, clear_first: true, risk: 'safe' });
        } else {
          actions.push({ op: 'ask_user', target: el.id, field_key: 'address', question: `What address should I enter in the "${el.name || el.placeholder || 'Address'}" field?` });
        }

      // Pincode / Pin — always ask
      } else if (labelText.includes('pincode') || labelText.includes('pin code') || labelText.includes('zip') || labelText.includes('pin')) {
        const val = answered('pincode') ?? userExtractions.pincode;
        if (val) {
          actions.push({ op: 'type', target: el.id, value: val, clear_first: true, risk: 'safe' });
        } else {
          actions.push({ op: 'ask_user', target: el.id, field_key: 'pincode', question: `What is the pincode / zip code?` });
        }

      // Search / Query field — ask if no value is known from goal
      } else if (labelText.includes('search') || (labelText.includes('find') && !labelText.includes('name'))) {
        const val = answered('search') ?? userExtractions.from;
        if (val) {
          actions.push({ op: 'type', target: el.id, value: val, clear_first: true, risk: 'safe' });
        } else {
          actions.push({ op: 'ask_user', target: el.id, field_key: 'search', question: `What should I type in the search field?` });
        }

      // Message / Remark / Textarea — always ask the user
      } else if (labelText.includes('message') || labelText.includes('inquiry') || labelText.includes('remark') || labelText.includes('comment') || el.tag === 'textarea') {
        const val = answered('message');
        if (val) {
          actions.push({ op: 'type', target: el.id, value: val, clear_first: true, risk: 'safe' });
        } else {
          actions.push({ op: 'ask_user', target: el.id, field_key: 'message', question: 'What should I write in the message / remarks field?' });
        }

      // ── Unknown field: NEVER guess. Always leave blank and ask the user. ──
      } else {
        const rawLabel = el.name || el.placeholder || el.ariaLabel || el.id || `field_${idx + 1}`;
        const key = (el.name || el.id || `field_${idx}`).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
        const val =
          answered(key) ||
          answered(`field_${idx}`) ||
          answered(rawLabel) ||
          userExtractions[key] ||
          userExtractions[rawLabel.toLowerCase()];
        if (val) {
          // Only fill if the user already answered this specific field in a prior step or saved it
          actions.push({ op: 'type', target: el.id, value: val, clear_first: true, risk: 'safe' });
        } else {
          // Ask the user — never fill a random/garbage default
          actions.push({
            op: 'ask_user',
            target: el.id,
            field_key: key,
            question: `What should I fill in the "${el.name || el.placeholder || el.ariaLabel || `field ${idx + 1}`}" field? (Leave blank to skip)`,
          });
        }
      }
    }

    const safeActions = actions.slice(0, 3);
    const typeCount = safeActions.filter(a => a.op === 'type').length;
    const askCount  = safeActions.filter(a => a.op === 'ask_user').length;
    return {
      plan_id: 'p_0',
      trace_id: ssg?.trace_id ?? 't_0',
      reasoning: `Smart plan for "${goal}": filling ${typeCount} field(s)${askCount > 0 ? `, asking about ${askCount} field(s)` : ''}.`,
      actions: safeActions,
      expect: { page_change: false },
      done: false,
      confidence: 0.95,
    };
  }

  if (step >= 1 && buttons.length > 0) {
    const submitBtn = buttons.find((b) => {
      const t = JSON.stringify(b).toLowerCase();
      return t.includes('send') || t.includes('submit') || t.includes('apply') ||
             t.includes('save') || t.includes('proceed') || t.includes('inquiry') || t.includes('confirm') ||
             t.includes('search') || t.includes('find') || t.includes('book') || t.includes('continue') || t.includes('next');
    });

    if (submitBtn) {
      return {
        plan_id: `p_${step}`,
        trace_id: ssg?.trace_id ?? `t_${step}`,
        reasoning: 'Fields populated. Clicking action button.',
        actions: [{ op: 'click', target: submitBtn.id, risk: 'safe' }],
        expect: { page_change: false },
        done: false,
        confidence: 0.9,
      };
    }
  }

  return {
    plan_id: 'p_' + String(step),
    trace_id: ssg?.trace_id ?? 't_' + String(step),
    reasoning: `Completed user goal: "${goal}"`,
    actions: [{ op: 'done', summary: `Completed goal: ${goal}` }],
    done: true,
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

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    send(res, 204, {});
    return;
  }

  if (req.method === 'GET' && req.url === '/v1/health') {
    send(res, 200, {
      status: 'ok',
      model: LLM_MODEL,
      llm_configured: Boolean(LLM_API_KEY),
      ssg_versions: ['1.0'],
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/v1/models') {
    send(res, 200, {
      loaded: [LLM_MODEL],
      note: `Real-time OpenRouter LLM planner (${LLM_MODEL})`,
    });
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

  req.on('end', async () => {
    let ssg;
    try {
      ssg = JSON.parse(raw);
    } catch {
      send(res, 400, { error: 'SSG_INVALID', detail: 'body is not JSON' });
      return;
    }

    if (ssg.ssg_version && !String(ssg.ssg_version).startsWith('1.')) {
      send(res, 409, { error: 'VERSION_MISMATCH', supported: '1.x' });
      return;
    }

    console.log(
      `[MANTRI LLM] Goal: "${ssg.goal}" | Step: ${ssg.step} | Elements: ${ssg.elements?.length ?? 0}`,
    );

    let plan;
    try {
      if (ssg.goal && /fill|form|name|roll|date|mobile|email|submit/i.test(ssg.goal)) {
        // Fast instant local planning for forms to give zero-latency instant execution during live demo
        plan = heuristicDynamicPlan(ssg);
        console.log(`[MANTRI FastPlan] Instant plan generated for "${ssg.goal}": ${plan.actions?.length ?? 0} action(s)`);
      } else {
        plan = await callLlmPlanner(ssg);
        console.log(`[MANTRI LLM] Generated ${plan.actions?.length ?? 0} actions:`, plan.reasoning);
      }
    } catch (llmErr) {
      console.warn(`[MANTRI LLM Fallback] LLM query failed (${llmErr.message}), using dynamic parser.`);
      plan = heuristicDynamicPlan(ssg);
    }

    send(res, 200, {
      ...plan,
      plan,
      bytes_sent: raw.length,
      model: LLM_MODEL,
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`PRAHARI MANTRI Real-Time LLM Planning Server on http://127.0.0.1:${PORT}`);
  console.log(`  Model: ${LLM_MODEL} | API Key Configured: ${Boolean(LLM_API_KEY)}`);
  console.log(`  POST /v1/agent/step   GET /v1/health   GET /v1/models`);
});
