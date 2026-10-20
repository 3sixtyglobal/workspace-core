# Development Guide

## Development model

This workspace is an orchestration repository for submodules. It keeps the repositories together and provides shared scripts to run install, format, lint, and build commands across them.

For day-to-day implementation work, open the specific submodule repository in VS Code and run that repository's package scripts directly.

## Prerequisites

- Node.js `>=24.0.0`
- pnpm, which is provided by corepack using the `packageManager` version in `package.json`
- Git with submodule support
- Access to the submodule repositories

Each submodule follows the setup, branch, commit and release conventions described in its own `CONTRIBUTING.md`. Running `pnpm install` in a submodule also installs its `.githooks`, which check commit messages and branch names.

## Typical local workflow

1. Clone the workspace with submodules:

```shell
git clone --recursive https://github.com/3sixtyglobal/workspace-core.git
```

1. Keep submodules current when switching context:

```shell
git submodule update --recursive
git pull --recurse-submodules
```

1. Run workspace-wide orchestration commands when needed (for example from [COMMANDS.md](./COMMANDS.md)):

```shell
pnpm run submodule:install
pnpm run submodule:quality-no-test
```

1. Open and work in the target submodule repo for actual feature development.

## Cross-repo local linking

Each submodule resolves its dependencies on other submodules through the published npm packages.

To build changes that span several repositories before a release, install from the workspace root instead. This links every submodule to the local source of the others, and the `workspace:*` commands then build and lint them in dependency order, see [Workspace commands](./COMMANDS.md#workspace-commands):

```shell
pnpm run workspace:install
pnpm run workspace:quality-no-test
```

To link only specific packages into one repository, run that repository's local link script instead:

```shell
pnpm run local-link
```

This script creates a symlink to the locally built package so dependent repos can consume your local changes immediately.

## Practical guidance

- Build and validate the source repository before linking so consumers use the latest local output.
- Re-run `pnpm run local-link` after rebuilding if the linked package output changes.
- Keep your submodules on the intended branch (for most repos this is `next`) while integrating multi-repo changes.
- Use workspace orchestration commands for broad checks, then debug failures directly in the affected submodule.
