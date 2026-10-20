# Workflow Guide

## Workspace workflows

The workspace repository contains the following workflows in `.github/workflows`.

| Workflow                  | File                         | Triggers                                               |
| ------------------------- | ---------------------------- | ------------------------------------------------------ |
| Workspace Submodule Build | `submodule-published.yaml`   | `schedule`, `workflow_dispatch`, `repository_dispatch` |
| Workspace Build           | `workspace-build.yaml`       | `push` to `next` and `main`, `workflow_dispatch`       |
| Align Branches            | `align-branches.yaml`        | `workflow_dispatch`                                    |
| Publish Project Audit     | `publish-project-audit.yaml` | `workflow_dispatch`                                    |
| Project Add Issue         | `project-add-issue.yaml`     | `issues` opened                                        |

### Workspace Submodule Build

The **Workspace Submodule Build** workflow reads the `submodules` array from `package.json` and builds each submodule in a matrix, with up to 4 running in parallel. Each submodule is checked out directly from GitHub, its `pnpm-lock.yaml` files are removed so the latest dependency versions are resolved, and it is then built.

It can run via:

- `schedule`, on weekdays at 00:00 and 12:00 UTC for `main`, and at 00:30 and 12:30 UTC for `next`
- `workflow_dispatch` (manual run)
- `repository_dispatch` with event type `submodule-published`, building the branch given in the payload

#### Manual run options

`workflow_dispatch` exposes two choice inputs.

`releaseType` selects the branch to build:

- `🌱 prerelease (next branch)` (default)
- `🌳 production (main branch)`

`runTesting` selects the build mode:

- `⚡ no-test` (default)
- `🧪 test`

Behaviour:

- `⚡ no-test` runs `pnpm run dist:no-test` for each submodule.
- `🧪 test` runs setup/teardown composite actions plus `pnpm run dist`:
  - prepares and runs the submodule `setup-test-env` action
  - runs `pnpm run dist`
  - prepares and runs the submodule `teardown-test-env` action (with `always()` semantics)

For the `schedule` and `repository_dispatch` triggers, the workflow always runs in no-test mode.

### Workspace Build

The **Workspace Build** workflow checks out the workspace with all its submodules and installs them as one workspace, with the `@3sixty` dependencies linked to their local source rather than the published packages (see [Workspace commands](./COMMANDS.md#workspace-commands)). It then runs `pnpm run workspace:dist-no-test` to build every package in dependency order, followed by `pnpm run workspace:lint`.

This catches changes in one submodule that break another before they are published, which the **Workspace Submodule Build** only finds afterwards. Tests are not run, as they need the docker services each submodule sets up for itself.

It runs on every push to `next` or `main`, which includes the submodule updates from **Align Branches**, and can be run manually with a `branch` choice of `🌱 next` (default) or `🌳 main`.

### Align Branches

The **Align Branches** workflow is run manually to bring the workspace submodule pointers up to date:

1. Checks out `next`, runs `pnpm run submodule:align-next` to move every submodule to the head of its `next` branch, then commits and pushes `chore: update next submodules`.
1. Checks out `main`, applies the diff from `main` to `next`, runs `pnpm run submodule:align-main` to move every submodule to the head of its `main` branch, then commits and pushes `chore: update main submodules`.

Commits are GPG signed using the bot identity from the `ORG_GPG_NAME` and `ORG_GPG_EMAIL` secrets.

### Publish Project Audit

The **Publish Project Audit** workflow deploys the contents of `docs/project-audit` from the `next` branch to Vercel and assigns the production audit domain alias.

### Project Add Issue

The **Project Add Issue** workflow adds each newly opened issue to the organisation project and labels it `needs-triage`.

## How submodules notify the workspace

The `Release Next` and `Release Production` workflows in each submodule repository contain a `notify-workspace` job that runs once the packages and GitHub releases have been published.

That job dispatches a repository event to `3sixtyglobal/workspace-core` using `gh api`:

- `event_type`: `submodule-published`
- `client_payload`: includes `submodule`, `branch` (`next` or `main`) and `sha`

This `repository_dispatch` triggers the workspace **Workspace Submodule Build** workflow for the published branch, so every consumer is rebuilt against the newly published packages.
