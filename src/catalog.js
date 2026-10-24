// ─────────────────────────────────────────────────────────────────────────────
// Aurora Revenue Engine — PRODUCT CATALOG
//
// Pure, offline, fail-closed product catalog.
//
// SECURITY CONTRACT
//   * catalog/products.json contains NO price ids and NO secrets.
//   * `price_reference` is an ENVIRONMENT VARIABLE NAME (e.g. PRICE_SKILL_PACK_LITE).
//     The literal price id is only ever read from process.env[price_reference].
//   * This module NEVER logs or returns a secret value. Env var NAMES only.
//
// FAIL-CLOSED CONTRACT
//   unknown price id              -> resolveProductByPrice() returns null (BLOCKED)
//   duplicate price mapping       -> throws CatalogError('catalog.duplicate_price_mapping')
//   disabled product              -> throws CatalogError('catalog.product_disabled')
//   missing price configuration   -> throws CatalogError('catalog.missing_price_configuration')
//   A single unconfigured product never breaks the rest of the catalog.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CATALOG_PATH = path.resolve(HERE, '..', 'catalog', 'products.json');

/** Environment variable names must look like env var names, never like price ids. */
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
/** Any literal price id / secret-ish literal is forbidden inside the catalog file. */
const PRICE_LITERAL_RE = /\bprice_[A-Za-z0-9]+/;

export class CatalogError extends Error {
  constructor(code, message, details = {}) {
    super(message || code);
    this.name = 'CatalogError';
    this.code = code;
    this.details = details;
  }
}

// ── internal state ──────────────────────────────────────────────────────────
let rawCache = null; // { key, raw } — parsed file contents only; validation is per-call

// ── validation ──────────────────────────────────────────────────────────────
function assertValidProduct(product, index) {
  const where = `product[${index}]`;
  if (!product || typeof product !== 'object') {
    throw new CatalogError('catalog.invalid_product', `${where} is not an object`);
  }
  const required = [
    'product_id',
    'product_name',
    'product_type',
    'price_reference',
    'entitlement_type',
    'license_policy',
    'fulfillment_type',
    'delivery_artifact',
    'renewal_policy',
    'expiration_policy',
    'status',
  ];
  for (const key of required) {
    if (typeof product[key] !== 'string' || !product[key].trim()) {
      throw new CatalogError('catalog.invalid_product', `${where}.${key} is required`);
    }
  }
  if (!ENV_NAME_RE.test(product.price_reference)) {
    throw new CatalogError(
      'catalog.invalid_price_reference',
      `${where}.price_reference must be an ENVIRONMENT VARIABLE NAME, got "${product.price_reference}"`,
    );
  }
  if (PRICE_LITERAL_RE.test(product.price_reference)) {
    throw new CatalogError(
      'catalog.invalid_price_reference',
      `${where}.price_reference must not contain a literal price id`,
    );
  }
  if (product.status !== 'active' && product.status !== 'disabled') {
    throw new CatalogError('catalog.invalid_product', `${where}.status must be active|disabled`);
  }
  return product;
}

/**
 * Detect duplicate price mappings.
 *  a) two products sharing the same `price_reference` (config typo)
 *  b) two products whose configured price ids resolve to the SAME literal price id
 * Both are hard configuration errors: the catalog refuses to load.
 */
function assertNoDuplicatePriceMappings(products, env) {
  const byReference = new Map();
  for (const p of products) {
    const seen = byReference.get(p.price_reference);
    if (seen) {
      throw new CatalogError(
        'catalog.duplicate_price_mapping',
        `price_reference "${p.price_reference}" is mapped to more than one product`,
        { price_reference: p.price_reference, product_ids: [seen.product_id, p.product_id] },
      );
    }
    byReference.set(p.price_reference, p);
  }

  const byPriceId = new Map();
  for (const p of products) {
    const priceId = env[p.price_reference];
    if (!priceId) continue; // unconfigured products are handled per-product, not here
    const seen = byPriceId.get(priceId);
    if (seen) {
      throw new CatalogError(
        'catalog.duplicate_price_mapping',
        `two products resolve to the same configured price id (${p.price_reference} / ${seen.price_reference})`,
        {
          price_reference: p.price_reference,
          other_price_reference: seen.price_reference,
          product_ids: [seen.product_id, p.product_id],
        },
      );
    }
    byPriceId.set(priceId, p);
  }
}

function normaliseCatalog(raw, env, source) {
  if (!raw || typeof raw !== 'object') {
    throw new CatalogError('catalog.invalid_catalog', 'catalog file did not parse to an object');
  }
  const products = Array.isArray(raw.products) ? raw.products : [];
  if (!products.length) {
    throw new CatalogError('catalog.empty_catalog', 'catalog contains no products');
  }
  products.forEach(assertValidProduct);

  const ids = new Set();
  for (const p of products) {
    if (ids.has(p.product_id)) {
      throw new CatalogError('catalog.duplicate_product_id', `duplicate product_id "${p.product_id}"`);
    }
    ids.add(p.product_id);
  }

  assertNoDuplicatePriceMappings(products, env);

  return {
    version: raw.version ?? 1,
    currency: raw.currency ?? 'usd',
    description: raw.description ?? '',
    products: products.map((p) => ({ ...p })),
    _source: source,
  };
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Load (and cache) the catalog.
 * @param {object} [options]
 * @param {string} [options.filePath] alternate catalog file (defaults to catalog/products.json)
 * @param {object} [options.env]      env override map (defaults to process.env)
 * @returns {object} parsed catalog object
 */
export function loadCatalog(options = {}) {
  const { filePath = CATALOG_PATH, env = process.env } = options;
  const key = `${filePath}`;

  let raw = rawCache && rawCache.key === key ? rawCache.raw : null;
  if (!raw) {
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      throw new CatalogError('catalog.unreadable', `cannot read catalog at ${filePath}: ${err.message}`);
    }
    rawCache = { key, raw };
  }

  // Re-validated on every call so that env-driven duplicate price mappings are
  // always detected, even when the file contents have not changed.
  return normaliseCatalog(raw, env, { key, filePath });
}

/** Drop the in-memory cache (used by tests). */
export function resetCatalogCache() {
  rawCache = null;
}

/** All products, in catalog order. Includes disabled and unconfigured products. */
export function listProducts(options = {}) {
  return loadCatalog(options).products.map((p) => ({ ...p }));
}

/** Look up a product by product_id. Returns null when unknown. */
export function getProduct(productId, options = {}) {
  if (!productId) return null;
  const found = loadCatalog(options).products.find((p) => p.product_id === productId);
  return found ? { ...found } : null;
}

/**
 * Resolve a concrete price id (e.g. from a webhook) to a product.
 * Returns null for an unknown price id — callers MUST treat null as BLOCKED.
 * Throws CatalogError('catalog.duplicate_price_mapping') on a duplicate mapping.
 * A disabled product NEVER resolves (returns null).
 * A product whose price env var is unset never resolves (returns null).
 */
export function resolveProductByPrice(priceId, options = {}) {
  if (!priceId || typeof priceId !== 'string') return null;
  const { env = process.env } = options;
  const catalog = loadCatalog(options);
  const product = catalog.products.find(
    (p) => p.status === 'active' && env[p.price_reference] && env[p.price_reference] === priceId,
  );
  return product ? { ...product } : null;
}

/**
 * Assert a product is sellable. Throws CatalogError otherwise.
 *  - missing product      -> catalog.product_not_found
 *  - disabled product     -> catalog.product_disabled
 *  - price not configured -> catalog.missing_price_configuration
 */
export function assertProductEnabled(product, options = {}) {
  const { env = process.env } = options;
  if (!product || typeof product !== 'object') {
    throw new CatalogError('catalog.product_not_found', 'product is missing');
  }
  if (product.status !== 'active') {
    throw new CatalogError('catalog.product_disabled', `product "${product.product_id}" is disabled`, {
      product_id: product.product_id,
    });
  }
  if (!env[product.price_reference]) {
    throw new CatalogError(
      'catalog.missing_price_configuration',
      `price environment variable "${product.price_reference}" is not configured for product "${product.product_id}"`,
      { product_id: product.product_id, price_reference: product.price_reference },
    );
  }
  return product;
}

/** The configured price id for a product, or null when unconfigured. Never throws. */
export function configuredPriceId(product, options = {}) {
  const { env = process.env } = options;
  if (!product) return null;
  const value = env[product.price_reference];
  return value || null;
}

export default {
  loadCatalog,
  listProducts,
  getProduct,
  resolveProductByPrice,
  assertProductEnabled,
  configuredPriceId,
  resetCatalogCache,
  CatalogError,
  CATALOG_PATH,
};
