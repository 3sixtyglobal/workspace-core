// Creates the standard issue labels in workspace-core and every submodule repo.
// LABELS mirrors the repository default labels, so keep both in step when changing either.
// Labels that already exist are updated to match the colour and description. Set GITHUB_TOKEN before running.
import { Octokit } from '@octokit/rest';
import { readFileSync } from 'fs';

const GITHUB_TOKEN = 'github_pat_...';

const workspacePackage = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf8')
);
const SUBMODULES = ['workspace-core', ...workspacePackage.submodules];

const octokit = new Octokit({
	auth: GITHUB_TOKEN
});

const ORG = '3sixtyglobal';
const LABELS = [
	{
		name: 'autorelease: pending',
		color: 'ededed',
		description: 'This issue is pending an autorelease'
	},
	{
		name: 'autorelease: tagged',
		color: '74c7ac',
		description: 'This issue has been tagged by the autorelease'
	},
	{
		name: 'needs-triage',
		color: 'f0650b',
		description: 'Issues that need triage'
	},
	{
		name: 'information-needed',
		color: '7ecd6e',
		description: 'More information is needed from the issue reporter'
	},
	{
		name: 'blocked',
		color: 'b03b06',
		description: 'This issue is blocked by another issue'
	},
	{
		name: 'changes-requested',
		color: 'e7e26f',
		description: 'Changes have been requested for this issue'
	},
	{
		name: 'chore',
		color: '3eba9c',
		description: 'A task that needs to be done but does not add any new features or fix any bugs'
	},
	{
		name: 'testing',
		color: 'add8e6',
		description: 'A task to enhance testing coverage or improve testing infrastructure'
	},
	{
		name: 'accessibility',
		color: 'f143ab',
		description: 'Barrier affecting people with disabilities'
	},
	{
		name: 'bug',
		color: 'd73a4a',
		description: "Something isn't working"
	},
	{
		name: 'documentation',
		color: '0075ca',
		description: 'Improvements or additions to documentation'
	},
	{
		name: 'duplicate',
		color: 'cfd3d7',
		description: 'This issue or pull request already exists'
	},
	{
		name: 'enhancement',
		color: 'a2eeef',
		description: 'New feature or request'
	},
	{
		name: 'good first issue',
		color: '7057ff',
		description: 'Good for newcomers'
	},
	{
		name: 'help wanted',
		color: '008672',
		description: 'Extra attention is needed'
	},
	{
		name: 'invalid',
		color: 'e4e669',
		description: "This doesn't seem right"
	},
	{
		name: 'question',
		color: 'd876e3',
		description: 'Further information is requested'
	},
	{
		name: 'wontfix',
		color: 'ffffff',
		description: 'This will not be worked on'
	}
];

async function addLabelToAllRepos() {
	for (const repoName of SUBMODULES) {
		await addLabelToRepo(repoName);
	}
}

async function addLabelToRepo(repoName) {
	for (const label of LABELS) {
		try {
			await octokit.issues.createLabel({
				owner: ORG,
				repo: repoName,
				...label
			});
			console.log(`✅ Label ${label.name} added to ${repoName}`);
		} catch (err) {
			if (err.status === 422) {
				try {
					await octokit.issues.updateLabel({
						owner: ORG,
						repo: repoName,
						...label
					});
					console.log(`🔄 Label ${label.name} updated in ${repoName}`);
				} catch (updateErr) {
					console.error(`❌ Error updating ${label.name} in ${repoName}:`, updateErr.message);
				}
			} else {
				console.error(`❌ Error in ${repoName}:`, err.message);
			}
		}

		// To avoid hitting rate limits
		await new Promise(resolve => setTimeout(resolve, 1000));
	}
}

addLabelToAllRepos();
// addLabelToRepo('tracing');
