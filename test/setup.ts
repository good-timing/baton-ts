/**
 * Global test setup — one place, because the exposure is repo-wide.
 *
 * `resolveTenantId` reads `BATON_TENANT_ID` when no `tenantId` is configured
 * (`config.ts`), which is the only environment variable this package reads at
 * all. That makes every suite asserting the `vendorId` migration fallback —
 * `withBaton.test.ts`'s `tenant_id === "acme"`, and all five
 * `emitterConformance` vectors, which match the Python run only because both
 * sides fall back — silently dependent on the ambient environment. Measured:
 * `BATON_TENANT_ID=ten_x npm test` reddens 6 tests that have nothing to do
 * with tenancy.
 *
 * Cleared before every test rather than restored after, so a developer's
 * shell and a future CI runner see the same thing. Suites that care about the
 * variable set it themselves inside the test body.
 *
 * Cleared TWICE, and the module-scope one is the load-bearing half: setup
 * files run before a file's hooks, but `beforeEach` does not run before
 * `beforeAll`, and `emitterConformance.test.ts` builds every envelope it
 * compares inside a `beforeAll`. With only the hook, that suite still read
 * the ambient value and stayed red — measured, not reasoned about.
 */
import { beforeEach } from "vitest";

delete process.env.BATON_TENANT_ID;

beforeEach(() => {
  delete process.env.BATON_TENANT_ID;
});
