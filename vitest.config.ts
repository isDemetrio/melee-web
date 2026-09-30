import { defineConfig } from 'vitest/config';

/**
 * The Pages Functions tests deliberately live outside `functions/`.
 *
 * `wrangler pages functions build` treats every `.ts`, `.tsx`, `.js`, `.jsx` and `.mjs`
 * file below the functions directory as a route candidate and runs esbuild on each one --
 * including `.d.ts` files, whose extension is `.ts`, and including everything under
 * `functions/node_modules`. With the tests and their dependencies inside that directory,
 * the route scan fails on a type declaration (`nanoid/index.d.ts`, a transitive dependency
 * of the test tooling) and, in a real deployment, the test files would be published as
 * public routes.
 *
 * So: routes and nothing else under `functions/`, tooling at the repository root. The
 * upstream cause is recorded in docs/OPEN_QUESTIONS.md (Q8).
 */
export default defineConfig({
  test: { environment: 'node', include: ['tests/functions/**/*.test.ts'], maxWorkers: 1, minWorkers: 1 },
});
