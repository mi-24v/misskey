# Docker image validation

Run from the repository root after installing the pinned Node.js/pnpm versions
and dependencies (`corepack pnpm install --frozen-lockfile`). Bash and jq are
required for the shell-step tests.

```bash
node --test scripts/test-docker-workflow.mjs
actionlint .github/workflows/docker.yml
```

The tests parse the actual workflow and execute its image-name preparation in
isolated job environments. They also execute the manifest command with a stubbed
Docker function to check tag and digest arguments. They do not push images or
emulate GitHub Actions, Docker metadata generation, or GHCR authentication.

To check the Dockerfile locally with Docker Buildx:

```bash
git submodule update --init --recursive
docker buildx build --platform linux/amd64 --load -t miwkey:local .
```

Use this local image for integration tests on the same Docker daemon. An arm64
host can use `linux/arm64` instead.

## Publish a candidate before merging

In GitHub Actions, select **Publish Docker image**, then **Run workflow**, and
select the PR branch. The workflow must exist on the default branch for manual
dispatch, but the selected branch supplies the workflow implementation.

Alternatively, with an authenticated GitHub CLI:

The branch name below is an example. Replace `feature/notification-extension-server`
with the branch you want to validate, and push its latest commits to GitHub before
running the command. `--ref` selects the remote branch to build; it does not use
your local checkout or unpushed commits. The selected branch must contain the
candidate-publishing workflow described here.

```bash
gh workflow run docker.yml --repo mi-24v/misskey --ref feature/notification-extension-server
```

Manual runs publish `ghcr.io/mi-24v/misskey:candidate-<full-commit-sha>` for
linux/amd64 and linux/arm64. They do not update branch, release, or latest tags,
even when dispatched on a release tag. PR events only build and never publish.
Pushes to `miwkey-main` publish the normal branch/SHA tags and latest.

After both build jobs and the merge job succeed, use the candidate image in the
notification importer's `MISSKEY_2025_IMAGE` setting. Prefer its manifest digest
(`ghcr.io/mi-24v/misskey@sha256:...`) to pin the exact build. Check the GHCR
package visibility if the integration environment pulls without authentication.

A successful local check does not prove GHCR permissions or the multi-platform
publish path work. Confirm those using the candidate workflow run before merging.
