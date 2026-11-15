# Releasing

Releases are cut from `main` by pushing a tag. The [release workflow](../.github/workflows/release.yml)
runs the full CI first and stops before publishing anything if a check fails.

1. Move the entries under `## [Unreleased]` in [`CHANGELOG.md`](../CHANGELOG.md) to a new
   `## [X.Y.Z] - YYYY-MM-DD` section, and add a fresh, empty `[Unreleased]` above it.
2. Set `"version": "X.Y.Z"` in `package.json` and run `npm install` so `package-lock.json` follows.
3. Merge that to `main`, then tag the merge commit:

   ```sh
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

The workflow then:

- checks that the tag equals the `package.json` version and that `CHANGELOG.md` has notes for it
  (`node scripts/release-notes.ts X.Y.Z` shows them locally);
- builds the image for `linux/amd64` and `linux/arm64` and pushes
  `ghcr.io/tw4/local-llm-gateway:X.Y.Z`, `:X.Y`, `:X` (from 1.0 on) and `:latest`, with an SBOM
  and build provenance attached;
- creates the GitHub release with the changelog section as its notes.

A tag with a suffix (`v1.1.0-rc.1`) is published as a pre-release and does not move `latest`.

After the first release, check that the package at
<https://github.com/tw4/local-llm-gateway/pkgs/container/local-llm-gateway> is **public**
(Package settings → Change visibility), so `docker pull` works without logging in.
