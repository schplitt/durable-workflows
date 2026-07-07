# AGENTS.md

## Project Overview

This repo is a **pnpm monorepo** (modeled on the [iso4](https://github.com/schplitt/iso4) repo, releases via [changesets](https://github.com/changesets/changesets)) containing two published packages:

- **`durable-workflows`** — a composable durable workflow library, actively inspired by [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) and built on top of [`iso4`](https://github.com/schplitt/iso4). Workflows run inside a sandbox with a step-based API whose results are persisted, enabling suspend/resume, retries, and event-driven continuation. The persistence layer is pluggable, and the sandbox is extensible with user-provided globals and module imports. It has a `workspace:*` dependency on `durable-isolates` (declared now, consumed later).
- **`durable-isolates`** — the replay kernel `durable-workflows` builds on: durably execute one isolate program over a log. Currently a skeleton; the kernel is implemented in a later session.

The project uses ESM modules, Vitest for testing, ESLint for code quality, and tsdown for builds. Node `>=26`.

> Note: design notes live in the git-ignored `internal/` directory (e.g. `internal/thoughts.md`, `internal/durable-isolates.md`) — design content is intentionally not committed yet.

## Architecture

```
packages/
  durable-workflows/      # The engine (published as `durable-workflows`)
    src/
      index.ts            # Public entry — re-exports the type surface
      types.ts            # Engine/host public type surface
    package.json          # workspace:* dep on durable-isolates
    tsconfig.json         # standalone (no root base)
    tsdown.config.ts
    vitest.config.ts
  durable-isolates/       # The replay kernel (published as `durable-isolates`)
    src/
      index.ts            # Skeleton — kernel lands in a later session
      types/iso4.ts       # Re-exports the @iso4/sandbox type surface
    package.json          # @iso4/sandbox dependency lives here
    tsconfig.json         # standalone (no root base)
    tsdown.config.ts
    vitest.config.ts
eslint.config.js          # Shared flat ESLint config (lints the whole repo)
pnpm-workspace.yaml       # `packages/*` + dependency catalog
.changeset/               # changesets config + release docs
```

Each package owns its own `src/` (public API exported from `src/index.ts`), a standalone `tsconfig.json` (no shared root base), `tsdown.config.ts`, and `vitest.config.ts`. Shared root config is just ESLint and the pnpm catalog.

Dependency layering: `@iso4/sandbox` is a dependency of **`durable-isolates`** only, which re-exports its type surface at `durable-isolates/types/iso4`. `durable-workflows` depends solely on `durable-isolates` (`workspace:*`) and imports the iso4 types from that re-export — it never depends on `@iso4/sandbox` directly. Because these are compiled packages, `durable-workflows`'s cross-package type imports resolve against `durable-isolates`'s built `dist`, so **`build` must run before `typecheck`** (CI does this; run `pnpm build` before `pnpm typecheck` locally).

## Development

Run from the repo root — the root scripts fan out recursively across `packages/*`:

```sh
pnpm install    # Install dependencies
pnpm test:run   # Run all package tests (recursive, no watch)
pnpm build      # Build all packages with tsdown (recursive)
pnpm lint       # Lint the whole repo with ESLint
pnpm lint:fix   # Lint and auto-fix
pnpm typecheck  # Type-check all packages (recursive)
pnpm changeset  # Add a changeset for the next release
```

Root scripts use `pnpm -r --filter="./packages/*"`; `lint`/`lint:fix` run ESLint once over the whole repo. You can also `cd packages/<pkg>` and run that package's own scripts directly.

## Code Style

- ESM only (`"type": "module"`)
- TypeScript strict mode enabled
- Uses `tsdown` for building
- Uses `@schplitt/eslint-config` for linting
- Uses `vitest` for testing

## Testing

- Each package has its own `vitest.config.ts`; put tests inside that package's `tests/` directory (or alongside source under `src/`) — both are covered by the package `tsconfig.json` `include`, so tests are type-checked against the same config as source
- Use the `*.test.ts` file naming convention
- Run `pnpm test:run` from the root for all packages (no watch), or run it inside a single package
- Both packages currently set `passWithNoTests: true` — they have no tests yet; drop that once a real suite lands

Example test structure:

```ts
import { expect, test } from 'vitest'
import { myFunction } from '../src'

test('should do something', () => {
  expect(myFunction()).toBe(expectedValue)
})
```

## Maintaining Documentation

When making changes to the project:

- **`AGENTS.md`** — Update with technical details, architecture, and best practices for AI agents
  - Project architecture and file structure
  - Internal patterns and conventions
  - Development workflows
  - Testing strategies
  - Build/deployment processes
  - Code organization principles
  - Tool configurations and quirks

- **`README.md`** — Update with user-facing documentation for end users:
  - ✅ New exported utilities or functions from the package
  - ✅ New configuration options users can set
  - ✅ New CLI commands or features
  - ✅ Changes to existing API behavior
  - ✅ Environment variables users can set
  - ✅ Any feature users can configure, use, or interact with
  - ✅ Installation or setup instructions
  - ✅ Usage examples and code snippets

## Agent Guidelines

When working on this project:

1. **Run tests** after making changes: `pnpm test:run` (runs once, no watch mode)
2. **Run linting** to ensure code quality: `pnpm lint`
3. **Run type checking** before committing: `pnpm typecheck`
4. **Update this file** when adding new modules, APIs, or changing architecture
5. **Keep exports in each package's `src/index.ts`** — a package's public API should be exported from its own entry point
6. **Add tests** for new functionality inside the relevant package
7. **Record learnings** — When the user corrects a mistake or provides context about how something should be done, add it to the "Project Context & Learnings" section below if it's a recurring pattern (not a one-time fix)
8. **Notify documentation changes** — When updating `README.md` or `AGENTS.md`, explicitly call out the changes to the user at the end of your response so they can review and don't overlook them
9. **Use available workflow tools first** — When the user asks for branch/commit/PR workflow, use the available MCP/devtools first. Only fall back to `gh` CLI when those tools are not available.
10. **Use conventional naming for git workflow** — Branch names should use conventional prefixes where appropriate, such as `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`, `test/`, `build/`, `types/`, `style/`, `perf/`, `examples/`, and `ci/`. Commit subjects and PR titles should use conventional-commit style with the most appropriate type.
11. **Default PR behavior** — If the current branch already contains the related work, assume the PR should be opened from the current branch to `main` unless the user explicitly asks to isolate only part of the work or use a different base branch.
12. **Always include a PR body** — PRs created for the user must include a body. If a related issue identifier is known, include the appropriate GitHub-style reference.
13. **Prefer autofix first** — Strongly prefer running `pnpm lint:fix` before manually fixing lintable issues by hand. For automated validation, prefer this order: `pnpm build` → `pnpm test:run` → `pnpm lint:fix` → `pnpm typecheck`. `build` comes first because `durable-workflows`'s cross-package type imports resolve against `durable-isolates`'s built `dist` (there is no `paths` mapping), so `typecheck` needs an up-to-date build.
14. **Ask when requirements are unclear** — If requirements are ambiguous, ask a focused clarifying question instead of implementing a guessed solution.
15. **Prefer simple inline logic over trivial helpers** — Do not introduce tiny one-line helper/utility functions or throwaway `parse*` helpers for trivial one-off logic. Inline simple normalization or branching unless there is real reuse or a clear API boundary.

## Project Context & Learnings

This section captures project-specific knowledge, tool quirks, and lessons learned during development. When the user provides corrections or context about how things should be done in this project, add them here if they are recurring patterns (not a one-time fix).

> **Note:** Before adding something here, consider: Is this a one-time fix, or will it come up again? Only document patterns that are likely to recur or are notable enough to prevent future mistakes.

### Tools & Dependencies

- Use `pnpm test:run` in automated/agent workflows. Do not use `pnpm test` there because it starts watch mode.
- Prefer `pnpm lint:fix` before spending time on manual lint/style cleanup.
- Releases are changesets-based: a PR changing a published package should include a changeset (`pnpm changeset`). On merge to `main`, `changesets/action` opens a "Version Packages" PR; merging that publishes to npm. Do not add bumpp/changelogithub — those were the old single-package flow.
- Run root scripts from the repo root; they fan out over `packages/*`. Per-package work can be done with `cd packages/<pkg>`.

### Patterns & Conventions

- Use conventional branch prefixes and conventional-commit style commit subjects / PR titles.
- Prefer simple, clean, reusable solutions over ad-hoc implementations.
- Keep trivial one-off normalization and branching inline instead of extracting tiny helper functions too early.
- If requirements are ambiguous, ask a focused clarifying question before implementing.

### Common Mistakes to Avoid

- Do not commit changes before the user has reviewed them — make the edits, report, and wait for the user's go-ahead to commit.
- Do not use `pnpm test` in automation.
- Do not create tiny helper/utility functions or `parse*`/`normalize*` wrappers for trivial one-off logic.
- Do not guess when the requested behavior or scope is unclear.
