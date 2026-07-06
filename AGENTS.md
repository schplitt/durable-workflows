# AGENTS.md

## Project Overview

**@schplitt/durable-workflows** is a composable durable workflow library, actively inspired by [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) and built on top of [`iso4`](https://github.com/schplitt/iso4). Workflows run inside a sandbox with a step-based API whose results are persisted, enabling suspend/resume, retries, and event-driven continuation. The persistence layer is pluggable, and the sandbox is extensible with user-provided globals and module imports. The project uses ESM modules, Vitest for testing, ESLint for code quality, and tsdown for builds.

> Note: design notes live in the git-ignored `thoughts.md` — design content is intentionally not committed yet.

## Architecture

```
src/
└── index.ts            # Main entry point with exports
tests/
└── greet.test.ts       # Tests using Vitest
```

### Source (src/index.ts)

- Main entry point for the package
- All public exports should be defined here
- Uses ESM module format

### Tests (tests/)

- Uses Vitest for testing
- Test files follow the `*.test.ts` naming convention
- Import from `../src` to test the source code

## Development

```sh
pnpm install    # Install dependencies
pnpm test:run   # Run tests
pnpm build      # Build with tsdown
pnpm lint       # Lint with ESLint
pnpm lint:fix   # Lint and auto-fix
pnpm typecheck  # TypeScript type checking
```

## Code Style

- ESM only (`"type": "module"`)
- TypeScript strict mode enabled
- Uses `tsdown` for building
- Uses `@schplitt/eslint-config` for linting
- Uses `vitest` for testing

## Testing

- Write tests in the `tests/` directory
- Use `*.test.ts` file naming convention
- Run `pnpm test:run` for running tests
- Import modules from `../src`

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
5. **Keep exports in `src/index.ts`** — all public API should be exported from the main entry point
6. **Add tests** for new functionality in the `tests/` directory
7. **Record learnings** — When the user corrects a mistake or provides context about how something should be done, add it to the "Project Context & Learnings" section below if it's a recurring pattern (not a one-time fix)
8. **Notify documentation changes** — When updating `README.md` or `AGENTS.md`, explicitly call out the changes to the user at the end of your response so they can review and don't overlook them
9. **Use available workflow tools first** — When the user asks for branch/commit/PR workflow, use the available MCP/devtools first. Only fall back to `gh` CLI when those tools are not available.
10. **Use conventional naming for git workflow** — Branch names should use conventional prefixes where appropriate, such as `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`, `test/`, `build/`, `types/`, `style/`, `perf/`, `examples/`, and `ci/`. Commit subjects and PR titles should use conventional-commit style with the most appropriate type.
11. **Default PR behavior** — If the current branch already contains the related work, assume the PR should be opened from the current branch to `main` unless the user explicitly asks to isolate only part of the work or use a different base branch.
12. **Always include a PR body** — PRs created for the user must include a body. If a related issue identifier is known, include the appropriate GitHub-style reference.
13. **Prefer autofix first** — Strongly prefer running `pnpm lint:fix` before manually fixing lintable issues by hand. For automated validation, prefer this order: `pnpm test:run` → `pnpm lint:fix` → `pnpm typecheck`.
14. **Ask when requirements are unclear** — If requirements are ambiguous, ask a focused clarifying question instead of implementing a guessed solution.
15. **Prefer simple inline logic over trivial helpers** — Do not introduce tiny one-line helper/utility functions or throwaway `parse*` helpers for trivial one-off logic. Inline simple normalization or branching unless there is real reuse or a clear API boundary.

## Project Context & Learnings

This section captures project-specific knowledge, tool quirks, and lessons learned during development. When the user provides corrections or context about how things should be done in this project, add them here if they are recurring patterns (not a one-time fix).

> **Note:** Before adding something here, consider: Is this a one-time fix, or will it come up again? Only document patterns that are likely to recur or are notable enough to prevent future mistakes.

### Tools & Dependencies

- Use `pnpm test:run` in automated/agent workflows. Do not use `pnpm test` there because it starts watch mode.
- Prefer `pnpm lint:fix` before spending time on manual lint/style cleanup.

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
