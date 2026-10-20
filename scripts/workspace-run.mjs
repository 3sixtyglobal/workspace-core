// Copyright 2026 3Sixty Trade Ltd.
// SPDX-License-Identifier: Apache-2.0.
/**
 * Run a script across the root workspace. pnpm -r cannot be used because it
 * builds its graph from the manifests on disk, where the cross-repo dependencies
 * are release tags rather than workspace references, so it does not see them.
 *
 * By default the script runs in every package in dependency order, a package
 * starts as soon as all of its local dependencies have completed. A
 * devDependency which would close a cycle is not used for ordering.
 *
 * With --repos the script runs in every submodule root instead, which is where
 * the format and lint scripts live, these have no ordering between them.
 *
 * Usage:
 *    node ./scripts/workspace-run.mjs &lt;script&gt; [package...] [--repos] [--concurrency n]
 *
 * When packages are given the script only runs for them and their dependencies.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { findWorkspacePackages, workspaceRoot } from './workspace-packages.mjs';

/**
 * Execute the process.
 */
async function run() {
	const args = process.argv.slice(2);
	const concurrencyIndex = args.indexOf('--concurrency');
	const concurrency =
		concurrencyIndex === -1
			? Math.max(1, Math.floor(os.availableParallelism() / 2))
			: Number.parseInt(args.splice(concurrencyIndex, 2)[1], 10);
	const reposIndex = args.indexOf('--repos');
	const repos = reposIndex !== -1;
	if (repos) {
		args.splice(reposIndex, 1);
	}
	const [script, ...targets] = args;

	if (!script) {
		throw new Error('No script specified');
	}
	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw new Error('Concurrency must be a positive integer');
	}

	// Submodule roots are keyed by their directory as their names are not unique
	const packages = new Map(
		findWorkspacePackages()
			.filter(pkg => pkg.isRepo === repos)
			.map(pkg => [repos ? path.basename(pkg.dir) : pkg.name, pkg])
	);
	for (const target of targets) {
		if (!packages.has(target)) {
			throw new Error(`${repos ? 'Submodule' : 'Package'} ${target} not found in the workspace`);
		}
	}

	const graph = repos
		? new Map([...packages.keys()].map(name => [name, new Set()]))
		: buildGraph(packages);
	const selected = targets.length > 0 ? withDependencies(graph, targets) : new Set(graph.keys());

	process.stdout.write(`Script: ${script}\n`);
	process.stdout.write(`${repos ? 'Submodules' : 'Packages'}: ${selected.size}\n`);
	process.stdout.write(`Concurrency: ${concurrency}\n\n`);

	await runInOrder(packages, graph, selected, script, concurrency);
}

/**
 * Build the dependency graph between the workspace packages. The dependencies
 * are always used, a devDependency is only used when it does not close a cycle.
 * @param packages The workspace packages.
 * @returns The local dependencies of each package.
 */
function buildGraph(packages) {
	const graph = new Map();
	const local = deps => Object.keys(deps ?? {}).filter(name => packages.has(name));

	for (const [name, { manifest }] of packages) {
		graph.set(
			name,
			new Set([...local(manifest.dependencies), ...local(manifest.optionalDependencies)])
		);
	}

	for (const [name, { manifest }] of packages) {
		for (const dependency of local(manifest.devDependencies)) {
			if (dependency !== name && !graph.get(name).has(dependency)) {
				if (withDependencies(graph, [dependency]).has(name)) {
					process.stdout.write(`Ignoring devDependency cycle: ${name} > ${dependency}\n`);
				} else {
					graph.get(name).add(dependency);
				}
			}
		}
	}

	return graph;
}

/**
 * Find the packages and everything they depend on.
 * @param graph The dependency graph.
 * @param names The packages to start from.
 * @returns The packages and their transitive dependencies.
 */
function withDependencies(graph, names) {
	const found = new Set();
	const pending = [...names];
	while (pending.length > 0) {
		const name = pending.pop();
		if (!found.has(name)) {
			found.add(name);
			pending.push(...graph.get(name));
		}
	}
	return found;
}

/**
 * Run the script in each selected package once its dependencies have completed,
 * stopping at the first failure after the running scripts finish.
 * @param packages The workspace packages.
 * @param graph The dependency graph.
 * @param selected The packages to run the script in.
 * @param script The script to run.
 * @param concurrency The maximum number of scripts to run at once.
 * @returns Promise to wait for all the scripts to complete.
 */
async function runInOrder(packages, graph, selected, script, concurrency) {
	const waiting = new Set(selected);
	const completed = new Set();
	const running = new Map();
	const failed = [];

	while (waiting.size > 0 || running.size > 0) {
		if (failed.length === 0) {
			for (const name of waiting) {
				if (running.size >= concurrency) {
					break;
				}
				const ready = [...graph.get(name)].every(
					dependency => !selected.has(dependency) || completed.has(dependency)
				);
				if (ready) {
					waiting.delete(name);
					running.set(
						name,
						runScript(packages.get(name), script).then(
							() => ({ name, success: true }),
							() => ({ name, success: false })
						)
					);
				}
			}
		} else {
			waiting.clear();
		}

		if (running.size === 0 && waiting.size > 0) {
			throw new Error(`Dependency cycle between ${[...waiting].join(', ')}`);
		}

		if (running.size > 0) {
			const result = await Promise.race(running.values());
			running.delete(result.name);
			if (result.success) {
				completed.add(result.name);
			} else {
				failed.push(result.name);
			}
		}
	}

	if (failed.length > 0) {
		throw new Error(`Script ${script} failed in ${failed.join(', ')}`);
	}

	process.stdout.write(`\nScript ${script} completed (${completed.size})\n`);
}

/**
 * Run the script in a package, prefixing its output with the package location.
 * A package without the script is treated as complete.
 * @param pkg The package directory and manifest.
 * @param script The script to run.
 * @returns Promise to wait for the script to complete.
 */
async function runScript(pkg, script) {
	if (!pkg.manifest.scripts?.[script]) {
		return;
	}

	const prefix = `${path.relative(workspaceRoot, pkg.dir).replaceAll('\\', '/')} ${script}:`;
	process.stdout.write(`${prefix} started\n`);
	const startTime = performance.now();
	const elapsed = () => `${((performance.now() - startTime) / 1000).toFixed(1)}s`;

	return new Promise((resolve, reject) => {
		// Every pnpm call made by the script, including nested ones, has to use the
		// root workspace, otherwise pnpm treats the nearest submodule as the
		// workspace and installs it standalone when it has not been installed
		const sp = spawn(`pnpm run ${script}`, {
			stdio: ['ignore', 'pipe', 'pipe'],
			shell: true,
			cwd: pkg.dir,
			env: { ...process.env, NPM_CONFIG_WORKSPACE_DIR: workspaceRoot }
		});

		for (const stream of [sp.stdout, sp.stderr]) {
			let buffer = '';
			stream.on('data', chunk => {
				const lines = `${buffer}${chunk}`.split(/\r?\n/);
				buffer = lines.pop();
				for (const line of lines) {
					process.stdout.write(`${prefix} ${line}\n`);
				}
			});
			stream.on('end', () => {
				if (buffer.length > 0) {
					process.stdout.write(`${prefix} ${buffer}\n`);
				}
			});
		}

		sp.on('error', err =>
			reject(new Error(`Unable to start ${script} in ${pkg.dir}`, { cause: err }))
		);
		sp.on('exit', exitCode => {
			if (exitCode === 0) {
				process.stdout.write(`${prefix} done in ${elapsed()}\n`);
				resolve();
			} else {
				process.stdout.write(`${prefix} failed with exit code ${exitCode} after ${elapsed()}\n`);
				reject(new Error(`Script ${script} failed in ${pkg.dir}`));
			}
		});
	});
}

run().catch(err => {
	process.stderr.write(`${err.message}\n`);
	process.exitCode = 1;
});
