# Held changesets

Changesets for packages listed in `.changeset/config.json` → `ignore` are parked
here instead of `.changeset/`, because `changesets/action` does not account for
the ignore list: leftover ignored-package changesets make it try to open a
Version Packages PR (which comes out empty and errors) instead of publishing.

They cannot live in a subdirectory of `.changeset/` either — changesets treats
directories there as its legacy v1 changeset format and crashes.

To release a held package: move its files back into `.changeset/` and remove the
package from `ignore` in the same PR.
