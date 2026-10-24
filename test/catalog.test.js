import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadCatalog,
  listProducts,
  getProduct,
  resolveProductByPrice,
  assertProductEnabled,
  configuredPriceId,
  CatalogError,
  CATALOG_PATH,
} from '../src/catalog.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_FILE = path.join(REPO_ROOT, 'catalog', 'products.json');

// Env map used by the tests. Values are FAKE price ids, never real ones.
const FULL_ENV = {
  PRICE_STARTER: 'price_TEST_starter',
  PRICE_SKILL_PACK_LITE: 'price_TEST_lite',
  PRICE_SKILL_PACK_STD: 'price_TEST_std',
  PRICE_SKILL_PACK_ELITE: 'price_TEST_elite',
  PRICE_PRO_ANNUAL: 'price_TEST_pro',
  PRICE_MCP_SUITE: 'price_TEST_mcp',
};

test('catalog loads the six baseline products', () => {
  const products = listProducts();
  const ids = products.map((p) => p.product_id);
  for (const id of ['starter', 'skill_pack_lite', 'skill_pack_std', 'skill_pack_elite', 'pro_annual', 'mcp_suite']) {
    assert.ok(ids.includes(id), `missing product ${id}`);
  }
  const catalog = loadCatalog();
  assert.ok(Array.isArray(catalog.products));
});

test('catalog file contains no price ids and no secrets', () => {
  const raw = fs.readFileSync(CATALOG_FILE, 'utf8');
  // No JSON string VALUE may look like a literal price id ("price_reference" is
  // a field NAME and is expected).
  const strings = [];
  (function walk(node) {
    if (typeof node === 'string') strings.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  })(JSON.parse(raw));
  for (const s of strings) {
    assert.ok(!/^price_[A-Za-z0-9]{6,}$/.test(s), `literal price id found in catalog file: ${s}`);
  }
  const scrubbed = raw.replace(/price_reference/g, '');
  assert.ok(!/price_[A-Za-z0-9]/.test(scrubbed), 'literal price token found in catalog file');
  for (const secretish of ['sk_live', 'sk_test', 'whsec_', 'RESEND_API_KEY=', 'STRIPE_SECRET_KEY=', 'SMTP_PASS=']) {
    assert.ok(!raw.includes(secretish), `secret-like token ${secretish} found in catalog file`);
  }
  // every price_reference is an env var NAME
  for (const p of loadCatalog().products) {
    assert.match(p.price_reference, /^[A-Z][A-Z0-9_]*$/);
  }
});

test('resolveProductByPrice returns null for an unknown price id', () => {
  assert.equal(resolveProductByPrice('price_TEST_does_not_exist', { env: FULL_ENV }), null);
  assert.equal(resolveProductByPrice('', { env: FULL_ENV }), null);
  assert.equal(resolveProductByPrice(null, { env: FULL_ENV }), null);
});

test('resolveProductByPrice resolves a known price id to its product', () => {
  const p = resolveProductByPrice('price_TEST_lite', { env: FULL_ENV });
  assert.ok(p);
  assert.equal(p.product_id, 'skill_pack_lite');
  assert.equal(p.price_reference, 'PRICE_SKILL_PACK_LITE');
});

test('duplicate price mapping throws catalog.duplicate_price_mapping', () => {
  // two products pointing at the SAME configured price id
  const dupEnv = { ...FULL_ENV, PRICE_SKILL_PACK_STD: 'price_TEST_lite' };
  assert.throws(
    () => resolveProductByPrice('price_TEST_lite', { env: dupEnv }),
    (err) => err instanceof CatalogError && err.code === 'catalog.duplicate_price_mapping',
  );

  // two products sharing the same price_reference (env var name)
  const dupRefFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-cat-')), 'dup.json');
  const raw = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  raw.products[2].price_reference = 'PRICE_SKILL_PACK_LITE';
  fs.writeFileSync(dupRefFile, JSON.stringify(raw));
  assert.throws(
    () => loadCatalog({ filePath: dupRefFile, env: FULL_ENV }),
    (err) => err instanceof CatalogError && err.code === 'catalog.duplicate_price_mapping',
  );
});

test('a disabled product throws catalog.product_disabled and never resolves', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-cat-'));
  const file = path.join(dir, 'disabled.json');
  const raw = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  raw.products.find((p) => p.product_id === 'skill_pack_std').status = 'disabled';
  fs.writeFileSync(file, JSON.stringify(raw));

  const env = { ...FULL_ENV };
  // disabled product must not resolve to an entitlement
  assert.equal(resolveProductByPrice('price_TEST_std', { filePath: file, env }), null);
  const disabled = getProduct('skill_pack_std', { filePath: file, env });
  assert.throws(
    () => assertProductEnabled(disabled, { filePath: file, env }),
    (err) => err instanceof CatalogError && err.code === 'catalog.product_disabled',
  );
});

test('an unconfigured price fails closed PER PRODUCT without breaking the catalog', () => {
  const env = { ...FULL_ENV };
  delete env.PRICE_SKILL_PACK_STD; // one product unconfigured

  // the rest of the catalog still works
  assert.equal(listProducts({ env }).length, 6);
  const lite = resolveProductByPrice('price_TEST_lite', { env });
  assert.equal(lite.product_id, 'skill_pack_lite');

  // the unconfigured product does not resolve
  assert.equal(resolveProductByPrice('price_TEST_std', { env }), null);

  // and asserting on it fails closed with a specific code
  const std = getProduct('skill_pack_std', { env });
  assert.throws(
    () => assertProductEnabled(std, { env }),
    (err) => err instanceof CatalogError && err.code === 'catalog.missing_price_configuration',
  );
  assert.equal(configuredPriceId(std, { env }), null);
});

test('assertProductEnabled throws catalog.product_not_found for a missing product', () => {
  assert.throws(
    () => assertProductEnabled(null, { env: FULL_ENV }),
    (err) => err instanceof CatalogError && err.code === 'catalog.product_not_found',
  );
});

test('CATALOG_PATH points at the shipped catalog file', () => {
  assert.equal(CATALOG_PATH, CATALOG_FILE);
});
