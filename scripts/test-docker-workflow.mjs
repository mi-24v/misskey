import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { load } from 'js-yaml';

const workflow = load(readFileSync(new URL('../.github/workflows/docker.yml', import.meta.url), 'utf8'));

for (const name of ['build', 'merge']) {
	test(`${name} initializes its own lowercase registry image before metadata`, () => {
		const directory = mkdtempSync(join(tmpdir(), 'misskey-workflow-'));
		try {
			const envFile = join(directory, 'env');
			writeFileSync(envFile, '');
			const steps = workflow.jobs[name].steps;
			const metadataIndex = steps.findIndex(step => step.uses?.startsWith('docker/metadata-action@'));
			assert.ok(metadataIndex >= 0);
			for (const step of steps.slice(0, metadataIndex)) {
				if (!step.run) continue;
				const script = step.run.replaceAll('${{ matrix.platform }}', 'linux/amd64');
				assert.ok(!script.includes('${{'), 'Unsupported expression in preparation script');
				execFileSync('bash', ['--noprofile', '--norc', '-euo', 'pipefail', '-c', script], {
					env: { PATH: process.env.PATH, GITHUB_REPOSITORY: 'Mi-24V/Misskey', GITHUB_ENV: envFile },
				});
			}
			const assignments = readFileSync(envFile, 'utf8').trim().split('\n');
			assert.deepEqual(assignments.filter(line => line.startsWith('REGISTRY_IMAGE=')), [
				'REGISTRY_IMAGE=ghcr.io/mi-24v/misskey',
			]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
}

test('manifest command combines both platform digests and all tags', () => {
	const directory = mkdtempSync(join(tmpdir(), 'misskey-manifest-'));
	try {
		const digests = ['a'.repeat(64), 'b'.repeat(64)];
		for (const digest of digests) writeFileSync(join(directory, digest), '');
		const image = 'ghcr.io/mi-24v/misskey';
		const tags = [`${image}:miwkey-main`, `${image}:sha-ccccccc`];
		const step = workflow.jobs.merge.steps.find(step => step.name === 'Create manifest list and push');
		const script = step.run.replaceAll('${{ env.REGISTRY_IMAGE }}', image);
		assert.ok(!script.includes('${{'));
		// Capture Docker's arguments without contacting a registry.
		const output = execFileSync('bash', ['--noprofile', '--norc', '-euo', 'pipefail', '-c',
			'docker() { printf "%s\\0" "$@"; };\n' + script], {
			cwd: directory,
			env: { PATH: process.env.PATH, DOCKER_METADATA_OUTPUT_JSON: JSON.stringify({ tags }) },
			encoding: 'utf8',
		});
		assert.deepEqual(output.split('\0').slice(0, -1), [
			'buildx', 'imagetools', 'create', ...tags.flatMap(tag => ['-t', tag]),
			...digests.map(digest => `${image}@sha256:${digest}`),
		]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
