import { test } from "node:test";
import assert from "node:assert/strict";

import { generateAnonSecret, hmacAnonymize } from "../dist/index.js";

test("generateAnonSecret: returns a 64-char hex string (256-bit secret)", () => {
  const secret = generateAnonSecret();
  assert.equal(secret.length, 64);
  assert.match(secret, /^[0-9a-f]{64}$/);
});

test("generateAnonSecret: two calls never collide", () => {
  assert.notEqual(generateAnonSecret(), generateAnonSecret());
});

test("hmacAnonymize: deterministic — same value+secret always hashes the same", () => {
  const secret = "fixed-secret-for-test";
  assert.equal(hmacAnonymize("acme/widgets", secret), hmacAnonymize("acme/widgets", secret));
});

test("hmacAnonymize: different values under the same secret hash differently", () => {
  const secret = "fixed-secret-for-test";
  assert.notEqual(hmacAnonymize("acme/widgets", secret), hmacAnonymize("acme/other", secret));
});

test("hmacAnonymize: the same value under different secrets hashes differently", () => {
  assert.notEqual(hmacAnonymize("acme/widgets", "secret-a"), hmacAnonymize("acme/widgets", "secret-b"));
});

test("hmacAnonymize: output is truncated to 24 hex chars", () => {
  const hash = hmacAnonymize("acme/widgets#42", "fixed-secret-for-test");
  assert.equal(hash.length, 24);
  assert.match(hash, /^[0-9a-f]{24}$/);
});

test("hmacAnonymize: matches Orb's own pre-extraction output for a known vector (regression)", () => {
  // Fixed vector captured from the original inline `hmacField` in orb-collector.ts before extraction —
  // guards against the refactor silently changing Orb's live anonymized output.
  assert.equal(hmacAnonymize("acme/widgets", "known-fixed-secret"), "7323d8850fac6d7c2c4bdfae");
});
