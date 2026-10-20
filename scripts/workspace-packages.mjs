// Copyright 2026 3Sixty Trade Ltd.
// SPDX-License-Identifier: Apache-2.0.
/**
 * Find the packages which make up the root workspace, using the patterns from
 * pnpm-workspace.yaml so the pnpmfile and the scripts agree on the same set.
 */
import fs from 'node:fs';
import path from 'node:path';

export const workspaceRoot = path.resolve(import.meta.dirname, '..');

/**
 * Find the packages matched by the workspace patterns. Some submodule roots
 * share their name with a package in the submodule, so they are not unique.
 * @returns The packages with their name, directory, manifest and whether they
 * are a submodule root rather than a package within one.
 */
export function findWorkspacePackages() {
	const patterns = readWorkspacePatterns();
	const include = patterns.filter(pattern => !pattern.startsWith('!'));
	const exclude = patterns
		.filter(pattern => pattern.startsWith('!'))
		.map(pattern => pattern.slice(1));

	const packages = [];
	for (const manifestPath of fs.globSync(
		include.map(pattern => `${pattern}/package.json`),
		{ cwd: workspaceRoot, exclude: [...exclude, '**/node_modules/**'] }
	)) {
		const manifest = JSON.parse(fs.readFileSync(path.join(workspaceRoot, manifestPath), 'utf8'));
		const dir = path.dirname(manifestPath);
		packages.push({
			name: manifest.name,
			dir: path.join(workspaceRoot, dir),
			manifest,
			isRepo: !dir.includes(path.sep) && !dir.includes('/')
		});
	}
	return packages;
}

/**
 * Read the package patterns from pnpm-workspace.yaml, only the simple list form
 * used by the file is supported.
 * @returns The patterns, exclusions are prefixed with an exclamation mark.
 */
function readWorkspacePatterns() {
	const workspaceYaml = fs.readFileSync(path.join(workspaceRoot, 'pnpm-workspace.yaml'), 'utf8');
	const packagesBlock = /^packages:\r?\n((?:[ \t]+.*\r?\n)+)/m.exec(workspaceYaml)?.[1] ?? '';

	return [...packagesBlock.matchAll(/^[ \t]+-[ \t]+['"]?([^'"\r\n]+)['"]?/gm)].map(match =>
		match[1].trim()
	);
}
