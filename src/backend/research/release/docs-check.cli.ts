import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { checkReleaseStatus } from './docs-check.js';

const root = process.cwd();
const input: unknown = JSON.parse(readFileSync(resolve(root, 'docs/release-status.json'), 'utf8'));
const errors = checkReleaseStatus(input, {
    lockfileSha256: createHash('sha256').update(readFileSync(resolve(root, 'package-lock.json'))).digest('hex'),
    exists(path) {
        const full = resolve(root, path);
        return full.startsWith(root + sep) && existsSync(full);
    },
    commitExists(sha) {
        try {
            execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    },
});

// Check local Markdown destinations in the current status index. External
// URLs are intentionally not fetched: an unavailable network is not bad docs.
const indexPath = resolve(root, 'docs/release-status.md');
if (existsSync(indexPath)) {
    for (const match of readFileSync(indexPath, 'utf8').matchAll(/\]\(([^)]+)\)/g)) {
        const destination = match[1]!.split('#')[0]!;
        if (!destination || /^[a-z]+:/.test(destination)) continue;
        const full = resolve(root, 'docs', destination);
        if (!full.startsWith(root + sep) || !existsSync(full)) errors.push(`broken local link: ${destination}`);
    }
}
if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
} else {
    console.info('Release documentation paths, commit, lockfile and environment matrix are consistent.');
}
