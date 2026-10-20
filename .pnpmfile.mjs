// Copyright 2026 3Sixty Trade Ltd.
// SPDX-License-Identifier: Apache-2.0.
/**
 * The submodules depend on each other through the next release tag, which pnpm
 * always resolves from the registry. When installing from the workspace root
 * this hook rewrites those dependencies to the workspace protocol, so they link
 * to the local packages instead. Installs inside a submodule do not load it.
 */
import { findWorkspacePackages } from './scripts/workspace-packages.mjs';

const workspacePackages = new Set(
	findWorkspacePackages()
		.filter(pkg => !pkg.isRepo)
		.map(pkg => pkg.name)
);

/**
 * Point the @3sixty dependencies of the local packages at the workspace.
 * @param pkg The package manifest being read.
 * @returns The updated manifest.
 */
function readPackage(pkg) {
	if (workspacePackages.has(pkg.name)) {
		for (const dependencies of [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies]) {
			for (const name of Object.keys(dependencies ?? {})) {
				if (workspacePackages.has(name)) {
					dependencies[name] = 'workspace:*';
				}
			}
		}
	}
	return pkg;
}

export const hooks = {
	readPackage
};
