# Releasing

Releases are cut from `main` by pushing a tag; the [release workflow](../.github/workflows/release.yml)
then publishes the image and the GitHub release. There is no CI: the checks run on your machine.

1. Run everything locally on the commit you are going to tag:

   ```sh
   npm run verify         # lint, typecheck, tests, build, npm audit, OpenAI SDK smoke test (Node + Python)
   docker build -t local-llm-gateway:check .   # the image builds
   ```

   The smoke test needs the Python SDK once:
   `python3 -m venv .venv-smoke && .venv-smoke/bin/pip install -r scripts/smoke/requirements.txt`.
2. Move the entries under `## [Unreleased]` in [`CHANGELOG.md`](../CHANGELOG.md) to a new
   `## [X.Y.Z] - YYYY-MM-DD` section, and add a fresh, empty `[Unreleased]` above it.
3. Set `"version": "X.Y.Z"` in `package.json` and run `npm install` so `package-lock.json` follows.
4. Merge that to `main`, then tag the merge commit:

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

Docker Hub (`mertturkoglu/local-llm-gateway`) is pushed from your machine, since the workflow
holds no Docker Hub credentials. After the tag, with `docker login` done once:

```sh
v=X.Y.Z
docker buildx build --platform linux/amd64,linux/arm64 --provenance=mode=max --sbom=true \
  -t mertturkoglu/local-llm-gateway:$v -t mertturkoglu/local-llm-gateway:${v%.*} \
  -t mertturkoglu/local-llm-gateway:${v%%.*} -t mertturkoglu/local-llm-gateway:latest --push .
```

A tag with a suffix (`v1.1.0-rc.1`) is published as a pre-release and does not move `latest`.

After the first release, check that the package at
<https://github.com/tw4/local-llm-gateway/pkgs/container/local-llm-gateway> is **public**
(Package settings → Change visibility), so `docker pull` works without logging in.
