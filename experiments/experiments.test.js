/**
 * Aurora Revenue Engine — EXPERIMENT HARNESS SELF-TEST (entry point).
 *
 * This is the file `npm run test:experiments` picks up
 * (`node --test experiments/*.test.js`).
 */
import { defineSelfTests } from './revenue-engine/self-test.mjs';

defineSelfTests();
