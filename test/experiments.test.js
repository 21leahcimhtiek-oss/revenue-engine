/**
 * Aurora Revenue Engine — EXPERIMENT HARNESS SELF-TEST (entry point).
 *
 * Run by `node --test test/*.test.js` (the package suite) and by
 * `node --test experiments/*.test.js` (the experiment suite).
 *
 * It drives the harness itself, so the assertions are always made against a
 * FRESH run, never against a stale artefact.
 */
import { defineSelfTests } from '../experiments/revenue-engine/self-test.mjs';

defineSelfTests();
