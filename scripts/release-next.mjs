// Copyright 2026 3Sixty Trade Ltd.
// SPDX-License-Identifier: Apache-2.0.
//
// Releases every workspace submodule to the npm next tag in dependency order.
//
// Usage: node ./scripts/release-next.mjs [--workspace <dir>] [--from <repo>] [--only <repo,...>] [--max-minutes <n>] [--dry-run]
//
// With --max-minutes no further repo is started once that time has passed, and the repo to
// continue from is written to the GITHUB_OUTPUT file as "next", so a workflow can resume.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ORG = '3sixtyglobal';
const RELEASE_WORKFLOW = 'release-next.yaml';
const BUILD_WORKFLOW = 'build.yaml';
const DOCKER_REPO = 'node';
const DOCKER_WORKFLOW = 'docker-publish.yaml';
const DOCKER_INPUTS = { releaseType: '🌱 prerelease (next branch)' };
const ACTIVE_STATUSES = ['queued', 'in_progress', 'waiting', 'requested', 'pending'];
const POLL_MS = 30_000;
const RUN_START_TIMEOUT_MS = 5 * 60_000;
const RUN_TIMEOUT_MS = 6 * 60 * 60_000;
const NPM_TIMEOUT_MS = 30 * 60_000;

const args = parseArgs(process.argv.slice(2));
const workspace = path.resolve(args.workspace ?? process.cwd());
const dryRun = args['dry-run'] === true;
const maxMs = args['max-minutes'] ? Number(args['max-minutes']) * 60_000 : undefined;
const startedAt = Date.now();

await main();

async function main() {
	const workspacePackage = JSON.parse(readFileSync(path.join(workspace, 'package.json'), 'utf8'));
	let repos = workspacePackage.submodules;
	if (!Array.isArray(repos) || repos.length === 0) {
		throw new Error(`No submodules array found in ${workspace}/package.json`);
	}

	if (args.from) {
		const index = repos.indexOf(args.from);
		if (index === -1) {
			throw new Error(`Unknown repo for --from: ${args.from}, expected one of ${repos.join(', ')}`);
		}
		repos = repos.slice(index);
	}
	if (args.only) {
		const only = args.only.split(',');
		repos = repos.filter(repo => only.includes(repo));
	}

	log(`Releasing ${repos.length} repos: ${repos.join(', ')}${dryRun ? ' (dry run)' : ''}`);

	for (const repo of repos) {
		if (maxMs !== undefined && Date.now() - startedAt > maxMs) {
			log(`Time budget of ${args['max-minutes']} minutes reached, continue from ${repo}`);
			if (process.env.GITHUB_OUTPUT) {
				appendFileSync(process.env.GITHUB_OUTPUT, `next=${repo}\n`);
			}
			return;
		}
		await releaseRepo(repo);
	}

	log('All repos released.');

	// Each release notifies the workspace, which records the new submodule pointers on its next branch.
	// Uncommitted local pointers can block the fast forward, which leaves the workspace to be pulled by hand.
	if (!dryRun) {
		const pulled = run('git pull --ff-only origin next', workspace, true);
		log(
			pulled.status === 0
				? 'Workspace submodule pointers pulled.'
				: 'Workspace pull skipped, pull it manually.'
		);
	}

	// The Docker image bundles the node packages, so it is published once they are all on npm.
	if (repos.includes(DOCKER_REPO) && !dryRun) {
		const runId = await dispatchWorkflow(DOCKER_REPO, DOCKER_WORKFLOW, '', DOCKER_INPUTS);
		await waitForSuccess(DOCKER_REPO, runId, 'docker publish');
		log('Docker image published.');
	}
}

async function releaseRepo(repo) {
	const cwd = path.join(workspace, repo);
	log(`[${repo}] starting`);

	// A release left running by an interrupted session is followed rather than repeated.
	const active = listRuns(repo, RELEASE_WORKFLOW).find(r => ACTIVE_STATUSES.includes(r.status));
	if (active) {
		log(`[${repo}] following release already in progress ${active.url}`);
		await waitForSuccess(repo, active.databaseId, 'release');
		pullRelease(repo, cwd);
		await waitForNpm(repo, cwd);
		log(`[${repo}] released`);
		return;
	}

	if (run('git status --porcelain', cwd).stdout.trim() !== '') {
		throw new Error(`[${repo}] working tree is not clean, commit or stash the changes first`);
	}
	run('git fetch origin next', cwd);
	run('git checkout next', cwd);
	run('git pull --ff-only origin next', cwd);

	run('pnpm run package:update-framework', cwd);
	if (run('git status --porcelain', cwd).stdout.trim() !== '') {
		log(`[${repo}] framework dependencies changed, pushing update`);
		if (!dryRun) {
			run('git add -A', cwd);
			// [skip ci] as the Bun only build and the release workflow run the checks instead.
			run('git commit -m "chore: update dependencies [skip ci]"', cwd);
			run('git push origin next', cwd);
		}
	} else {
		log(`[${repo}] framework dependencies already up to date`);
	}

	if (dryRun) {
		log(`[${repo}] dry run, skipping build and release`);
		return;
	}

	await runBuild(repo, cwd);

	const runId = await dispatchWorkflow(repo, RELEASE_WORKFLOW, '-f force=true');
	await waitForSuccess(repo, runId, 'release');

	pullRelease(repo, cwd);
	await waitForNpm(repo, cwd);

	log(`[${repo}] released`);
}

// Brings the local checkout up to date with the version bumps the release merged.
function pullRelease(repo, cwd) {
	run('git pull --ff-only origin next', cwd);
	run('pnpm install --frozen-lockfile', cwd);
	log(`[${repo}] pulled ${run('git log -1 --format=%s', cwd).stdout.trim()}`);
}

// Compiles and runs the Bun tests before releasing, the release workflow runs the lint and Node tests.
async function runBuild(repo, cwd) {
	const sha = run('git rev-parse HEAD', cwd).stdout.trim();
	let runId = await dispatchWorkflow(repo, BUILD_WORKFLOW, '-f bunOnly=true');

	for (;;) {
		const result = await waitForRun(repo, runId, 'build');
		if (result.conclusion === 'success') {
			return;
		}
		if (result.conclusion === 'cancelled') {
			const newer = listRuns(repo, BUILD_WORKFLOW).find(
				r => r.headSha === sha && r.databaseId > runId
			);
			if (newer) {
				log(`[${repo}] build superseded, following ${newer.url}`);
				runId = newer.databaseId;
				continue;
			}
		}
		throw new Error(`[${repo}] build finished with ${result.conclusion}: ${result.url}`);
	}
}

async function dispatchWorkflow(repo, workflow, fields, jsonInputs) {
	const dispatchedAt = Date.now();
	// Inputs containing characters the shell may mangle, such as emoji, are sent as JSON on stdin.
	run(
		`gh workflow run ${workflow} -R ${ORG}/${repo} --ref next ${jsonInputs ? '--json' : fields}`,
		workspace,
		false,
		jsonInputs ? JSON.stringify(jsonInputs) : undefined
	);
	log(`[${repo}] dispatched ${workflow}`);
	// Allow for clock skew between this machine and GitHub.
	return findRun(
		repo,
		workflow,
		r => r.event === 'workflow_dispatch',
		dispatchedAt - 60_000,
		false
	);
}

async function findRun(repo, workflow, predicate, since, allowMissing) {
	const deadline = Date.now() + RUN_START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await sleep(10_000);
		const match = listRuns(repo, workflow).find(
			r => Date.parse(r.createdAt) >= since && predicate(r)
		);
		if (match) {
			log(`[${repo}] run ${match.url}`);
			return match.databaseId;
		}
	}
	if (allowMissing) {
		return undefined;
	}
	throw new Error(
		`[${repo}] no ${workflow} run appeared within ${RUN_START_TIMEOUT_MS / 60_000} minutes`
	);
}

function listRuns(repo, workflow) {
	return JSON.parse(
		run(
			`gh run list -R ${ORG}/${repo} --workflow ${workflow} --branch next --limit 10 --json databaseId,createdAt,status,event,headSha,url`
		).stdout
	);
}

async function waitForSuccess(repo, runId, label) {
	const result = await waitForRun(repo, runId, label);
	if (result.conclusion !== 'success') {
		throw new Error(`[${repo}] ${label} finished with ${result.conclusion}: ${result.url}`);
	}
}

async function waitForRun(repo, runId, label) {
	const deadline = Date.now() + RUN_TIMEOUT_MS;
	let lastStatus = '';
	while (Date.now() < deadline) {
		const view = JSON.parse(
			run(`gh run view ${runId} -R ${ORG}/${repo} --json status,conclusion,url`).stdout
		);
		if (view.status !== lastStatus) {
			log(`[${repo}] ${label} status ${view.status}`);
			lastStatus = view.status;
		}
		if (view.status === 'completed') {
			return view;
		}
		await sleep(POLL_MS);
	}
	throw new Error(
		`[${repo}] ${label} run ${runId} did not finish within ${RUN_TIMEOUT_MS / 3_600_000} hours`
	);
}

async function waitForNpm(repo, cwd) {
	const packages = publishablePackages(cwd);
	log(`[${repo}] waiting for ${packages.length} packages on npm`);

	const deadline = Date.now() + NPM_TIMEOUT_MS;
	let pending = packages;
	while (Date.now() < deadline) {
		pending = pending.filter(pkg => {
			const result = run(`npm view ${pkg.name} dist-tags.next --prefer-online`, cwd, true);
			return result.stdout.trim() !== pkg.version;
		});
		if (pending.length === 0) {
			log(`[${repo}] all packages available on the next tag`);
			return;
		}
		await sleep(POLL_MS);
	}
	throw new Error(
		`[${repo}] packages not on the npm next tag after ${NPM_TIMEOUT_MS / 60_000} minutes: ${pending
			.map(pkg => `${pkg.name}@${pkg.version}`)
			.join(', ')}`
	);
}

function publishablePackages(cwd) {
	const packages = [];
	for (const folder of ['packages', 'apps']) {
		const root = path.join(cwd, folder);
		if (!existsSync(root)) {
			continue;
		}
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			const file = path.join(root, entry.name, 'package.json');
			if (entry.isDirectory() && existsSync(file)) {
				const pkg = JSON.parse(readFileSync(file, 'utf8'));
				if (!pkg.private) {
					packages.push({ name: pkg.name, version: pkg.version });
				}
			}
		}
	}
	return packages;
}

function run(command, cwd = workspace, allowFail = false, input = undefined) {
	const result = spawnSync(command, {
		cwd,
		shell: true,
		encoding: 'utf8',
		input,
		maxBuffer: 64 * 1024 * 1024
	});
	if (result.status !== 0 && !allowFail) {
		throw new Error(`Command failed in ${cwd}: ${command}\n${result.stdout}\n${result.stderr}`);
	}
	return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

function parseArgs(argv) {
	const parsed = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith('--')) {
			const key = argv[i].slice(2);
			const next = argv[i + 1];
			if (next === undefined || next.startsWith('--')) {
				parsed[key] = true;
			} else {
				parsed[key] = next;
				i++;
			}
		}
	}
	return parsed;
}

function log(message) {
	console.log(`${new Date().toISOString()} ${message}`);
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}
