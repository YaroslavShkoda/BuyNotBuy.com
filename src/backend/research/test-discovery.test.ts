import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixture = mkdtempSync(join(tmpdir(), 'buynotbuy-discovery-'));
const live = ['src/backend/live.test.ts', 'src/data/domain.test.ts', 'scripts/security/live.test.ts'];
const archived = 'data/snapshot/src/backend/archived.test.ts';
for (const file of [...live, archived, 'node_modules/dependency/trap.test.ts', 'src/backend/test-support/test-database.ts', 'src/backend/test-support/no-network.ts']) {
    const full = join(fixture, file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.endsWith('.test.ts') ? 'throw new Error("files-only discovery must not execute tests");\n' : 'export {};\n');
}

afterAll(() => {
    const target = realpathSync(fixture);
    if (dirname(target) !== realpathSync(tmpdir()) || !basename(target).startsWith('buynotbuy-discovery-')) {
        throw new Error('Refusing cleanup outside the owned discovery fixture');
    }
    rmSync(target, { recursive: true, force: true });
});

it('discovers source/security tests but excludes root data snapshots and standard dependency folders', () => {
    const result = spawnSync(process.execPath, [join(project, 'node_modules/vitest/vitest.mjs'), 'list', '--filesOnly', '--root', fixture, '--config', join(project, 'vitest.config.mts')], { cwd: fixture, encoding: 'utf8', timeout: 4000, env: { ...process.env, FORCE_COLOR: '0' } });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const files = result.stdout.replaceAll('\\', '/').split(/\r?\n/).map(line => line.trim());
    for (const file of live) expect(files).toContain(file);
    expect(files).not.toContain(archived);
    expect(files).not.toContain('node_modules/dependency/trap.test.ts');
});
