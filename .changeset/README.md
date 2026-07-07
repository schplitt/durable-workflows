# Changesets

Short markdown files that describe which packages changed and at what
bump level. `changesets/action` consumes them on push to `main`.

## When to add a changeset

Any PR that changes user-visible behaviour in a published package
(`durable-workflows`, `durable-isolates`) needs one. Pure refactors, docs
edits, and test-only changes do not.

```sh
pnpm changeset
```

The interactive prompt asks which packages are affected and whether the
bump is `patch`, `minor`, or `major`. Commit the generated file in
`.changeset/<random-name>.md` as part of your PR.

## How releases work

1. Merge a PR that includes a changeset file into `main`.
2. The release workflow opens (or updates) a **"Version Packages" PR**
   that bumps `package.json` versions and writes `CHANGELOG.md` entries.
3. Merge the Version Packages PR.
4. The release workflow runs again — no pending changesets — so it builds
   the packages, runs `changeset publish`, and pushes to npm.

Publishing uses GitHub OIDC (no `NPM_TOKEN` secret required). Each package
must be configured on npmjs.com under Publishing → "Allow publishing from
GitHub Actions without a token".
