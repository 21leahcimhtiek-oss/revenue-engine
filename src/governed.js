// ─────────────────────────────────────────────────────────────────────────────
// Aurora Revenue Engine — GOVERNED EXECUTION INTEGRATION (thin adapter)
//
// A thin adapter around the FROZEN Aurora Governed Execution package at
//   C:\Users\keith\aurora\runtime\packages\aurora-governed-execution
// The package is READ-ONLY and MUST NOT be modified.
//
// TWO MODES, BOTH SUPPORTED
//   (a) RUNTIME       — the published entry (src/index.ts) can be dynamically
//                       imported by the current runtime (e.g. under tsx).
//   (b) CONTRACT-ONLY — plain node cannot import a .ts file. The adapter then
//                       DEGRADES GRACEFULLY: the governed-action allowlist,
//                       the money-movement refusal and the evidence trail are
//                       ALL still enforced; only delegation is missing.
//
// INVARIANTS THAT HOLD IN BOTH MODES
//   * An action outside the allowlist is refused.
//   * An action that would MOVE MONEY (refund / charge / payout / live price
//     or product change / live subscription cancel) is REFUSED with the typed
//     error `governed.money_movement_requires_authorisation`, and is NOT
//     performed.
//   * Every action that could not be governed is recorded in evidence with
//     `governed: false` and a reason. The adapter NEVER pretends to govern.
//
// No secret value is read, printed or stored here.
// ─────────────────────────────────────────────────────────────────────────────

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { recordEvidence } from './events.js';

/** Default location of the frozen Aurora Governed Execution package. */
export const DEFAULT_GOVERNED_EXECUTION_PATH =
  'C:\\Users\\keith\\aurora\\runtime\\packages\\aurora-governed-execution';

/** The ONLY way to locate the package: the env var, with the frozen default. */
export function governedExecutionPath() {
  return process.env.GOVERNED_EXECUTION_PATH || DEFAULT_GOVERNED_EXECUTION_PATH;
}

/** The modelled governed actions (the allowlist). */
export const GOVERNED_ACTIONS = Object.freeze([
  'license.issue',
  'license.revoke',
  'entitlement.activate',
  'entitlement.suspend',
  'fulfillment.execute',
  'customer.access.update',
]);

/** The list of modelled actions. */
export function governedActions() {
  return [...GOVERNED_ACTIONS];
}

/** Typed error for every governed refusal. */
export class GovernedError extends Error {
  constructor(code, message, details = {}) {
    super(message || code);
    this.name = 'GovernedError';
    this.code = code;
    this.status = 403;
    this.details = details;
  }
}

/**
 * Action name fragments meaning "this initiates or reverses MONEY MOVEMENT".
 * These are refused regardless of who asked.
 */
const MONEY_MOVEMENT_PATTERNS = [
  'refund',
  'charge',
  'payout',
  'transfer',
  'payment',
  'invoice.create',
  'invoice.void',
  'invoice.send',
  'invoice.pay',
  'invoice.finalize',
  'price.update',
  'price.set',
  'product.update',
  'product.create',
  'subscription.create',
  'subscription.cancel',
  'subscription.delete',
  'subscription.update',
  'checkout.session.create',
];

/**
 * Refuse any action that would initiate or reverse money movement.
 * Exported so ADMIN handlers can call it directly: even when the admin
 * authorisation guard passes, a money-movement action is still blocked.
 * @throws {GovernedError} code `governed.money_movement_requires_authorisation`
 */
export function assertNoMoneyMovement(action) {
  const name = String(action ?? '').trim().toLowerCase();
  if (!name) {
    throw new GovernedError('governed.action_missing', 'an action name is required');
  }
  for (const pattern of MONEY_MOVEMENT_PATTERNS) {
    if (name.includes(pattern)) {
      throw new GovernedError(
        'governed.money_movement_requires_authorisation',
        `refusing "${name}": money movement requires explicit operator authorisation`,
        { action: name, matched: pattern },
      );
    }
  }
  return true;
}

/** Is this action inside the modelled allowlist? */
export function isGovernedAction(action) {
  return GOVERNED_ACTIONS.includes(String(action ?? '').trim());
}

// ── loading ──────────────────────────────────────────────────────────────────

let loadState = null; // { available, mode, module, reason, path }

/**
 * Attempt to load the frozen package. Never throws.
 * @returns {Promise<{available:boolean,mode:string,module:any,reason:string|null,path:string}>}
 */
export async function loadGoverned() {
  if (loadState) return loadState;
  const base = governedExecutionPath();
  const descriptor = {
    available: false,
    mode: 'contract-only',
    module: null,
    reason: null,
    path: base,
    entry: null,
    source: null,
  };

  // Candidate entries, in preference order:
  //  1. the published source entry (src/index.ts) — importable when the
  //     consumer runtime can load TypeScript (e.g. tsx / a registered loader).
  //  2. the package's own compiled `main` (dist/index.js) — importable by
  //     PLAIN node. This is the frozen package's own build artefact; it is
  //     read, never modified.
  const candidates = [
    { entry: path.join(base, 'src', 'index.ts'), source: 'src-typescript' },
    { entry: path.join(base, 'dist', 'index.js'), source: 'dist-javascript' },
  ];

  const failures = [];
  for (const candidate of candidates) {
    try {
      const mod = await import(pathToFileURL(candidate.entry).href);
      loadState = {
        ...descriptor,
        available: true,
        mode: 'runtime',
        module: mod,
        entry: candidate.entry,
        source: candidate.source,
        reason: null,
      };
      return loadState;
    } catch (err) {
      failures.push(`${candidate.source}: ${err?.message ?? err}`);
    }
  }

  loadState = {
    ...descriptor,
    available: false,
    mode: 'contract-only',
    reason: `governed package not importable in this runtime (${failures.join(' | ')})`,
  };
  return loadState;
}

/** Alias with an explicit async name. */
export async function ensureGovernedLoaded() {
  return loadGoverned();
}

/**
 * Is the real governed runtime available? MUST NOT throw.
 * @returns {boolean}
 */
export function isGovernedAvailable() {
  return !!loadState?.available;
}

/** The current load descriptor (mode + reason). Never throws. */
export function governedStatus() {
  if (!loadState) {
    return {
      available: false,
      mode: 'contract-only',
      reason: 'governed package not loaded yet',
      path: governedExecutionPath(),
    };
  }
  return {
    available: !!loadState.available,
    mode: loadState.mode,
    reason: loadState.reason,
    path: loadState.path,
    entry: loadState.entry ?? null,
    source: loadState.source ?? null,
  };
}

/** Reset the cached load state (used by tests). */
export function resetGovernedLoadState() {
  loadState = null;
}

// ── running an action ────────────────────────────────────────────────────────

/**
 * A disposable root for the governed runtime's own state directory.
 * The frozen package writes `<root>/.aurora/...`; we never point it at the
 * revenue-engine repo unless the operator asks for it explicitly.
 */
export function defaultRuntimeRoot() {
  const dir = path.join(os.tmpdir(), 'aurora-governed-runtime');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* the runtime will report the failure itself */
  }
  return dir;
}

function recordGovernedEvidence(db, payload) {
  if (!db) return null;
  try {
    return recordEvidence(
      db,
      payload.kind ?? 'governed.action',
      payload.subject_id ?? null,
      payload,
      payload.source_fingerprint ?? null,
    );
  } catch {
    return null; // evidence must never crash the request path
  }
}

/**
 * Run one governed action.
 *
 * @param {string} action one of `governedActions()`
 * @param {object} opts
 *   taskId    {string} stable task id (covered by the task hash)
 *   resource  {string} the target resource (required by the runtime)
 *   objective {string} human objective
 *   params    {object} action parameters
 *   db        {object} optional db handle — evidence is recorded when present
 *   issuer    {string} optional issuer (default: a local non-secret issuer)
 *
 * In CONTRACT-ONLY mode the result is clearly labelled `governed: false` with
 * a reason, and the action is NOT performed.
 */
export async function runGovernedAction(action, opts = {}) {
  const name = String(action ?? '').trim();
  const taskId = opts.taskId ?? null;
  const resource = opts.resource ?? null;

  // 1. Money movement is refused FIRST — before any allowlist or loading work.
  assertNoMoneyMovement(name);

  // 2. Allowlist.
  if (!isGovernedAction(name)) {
    throw new GovernedError(
      'governed.action_not_allowed',
      `"${name}" is not a modelled governed action`,
      { action: name, allowed: GOVERNED_ACTIONS },
    );
  }

  const state = await ensureGovernedLoaded();

  if (!state.available) {
    const reason = state.reason ?? 'governed runtime unavailable';
    const payload = {
      kind: 'governed.action.unavailable',
      subject_id: taskId,
      governed: false,
      mode: 'contract-only',
      action: name,
      resource,
      objective: opts.objective ?? null,
      reason,
      recorded_at: new Date().toISOString(),
    };
    recordGovernedEvidence(opts.db, payload);
    return {
      governed: false,
      available: false,
      mode: 'contract-only',
      action: name,
      task_id: taskId,
      resource,
      reason,
      refusal: { code: 'governed.unavailable', reason },
      performed: false,
    };
  }

  // 3. RUNTIME mode: delegate to the real governed runtime.
  const mod = state.module ?? {};
  try {
    // The governed runtime persists state under <root>/.aurora. Default to a
    // disposable directory so the revenue-engine repo is never written to.
    const root = opts.root || process.env.GOVERNED_EXECUTION_ROOT || defaultRuntimeRoot();
    const runtime = mod.createGovernedRuntime ? mod.createGovernedRuntime({ root }) : null;
    if (!runtime || typeof runtime.run !== 'function') {
      throw new Error('governed package does not expose a usable runtime');
    }
    const request = {
      task_id: taskId || `task_${name.replace(/[^a-z0-9]+/gi, '_')}`,
      issuer: opts.issuer || 'aurora-revenue-engine',
      action: name,
      resource: resource || name,
      params: opts.params ?? {},
      objective: opts.objective ?? null,
    };
    const outcome = await runtime.run(request);
    const refused = outcome?.refusal ?? null;
    const payload = {
      kind: 'governed.action',
      subject_id: request.task_id,
      governed: !refused,
      mode: 'runtime',
      action: name,
      resource: request.resource,
      state: outcome?.state ?? null,
      refusal: refused,
      recorded_at: new Date().toISOString(),
    };
    recordGovernedEvidence(opts.db, payload);
    return {
      governed: !refused,
      available: true,
      mode: 'runtime',
      action: name,
      task_id: request.task_id,
      resource: request.resource,
      state: outcome?.state ?? null,
      refusal: refused,
      performed: !refused,
    };
  } catch (err) {
    const reason = `governed runtime error: ${err?.message ?? err}`;
    const payload = {
      kind: 'governed.action.failed',
      subject_id: taskId,
      governed: false,
      mode: 'runtime',
      action: name,
      resource,
      reason,
      recorded_at: new Date().toISOString(),
    };
    recordGovernedEvidence(opts.db, payload);
    return {
      governed: false,
      available: true,
      mode: 'runtime',
      action: name,
      task_id: taskId,
      resource,
      reason,
      performed: false,
    };
  }
}

export default {
  GOVERNED_ACTIONS,
  governedActions,
  GovernedError,
  assertNoMoneyMovement,
  isGovernedAction,
  isGovernedAvailable,
  governedStatus,
  governedExecutionPath,
  loadGoverned,
  ensureGovernedLoaded,
  resetGovernedLoadState,
  runGovernedAction,
};
