import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));

const ROOT_MARKER = 'package.json';

/**
 * Finds the project root by walking up from this module.
 *
 * The alternative — resolving a fixed number of `..` segments — silently
 * breaks the moment the build output nests differently from the sources, and
 * the failure mode is nasty: the service starts happily and writes its
 * database somewhere nobody looks for it. Looking for the manifest is
 * independent of how deep the compiled file happens to sit.
 */
function findProjectRoot(): string {
    let current = MODULE_DIRECTORY;

    for (let depth = 0; depth < 10; depth += 1) {
        if (existsSync(join(current, ROOT_MARKER))) {
            return current;
        }

        const parent = dirname(current);

        if (parent === current) {
            break;
        }

        current = parent;
    }

    // Bundled into a single file with no manifest above it: the working
    // directory is the only sensible anchor left.
    return process.cwd();
}

export const projectRoot = resolve(findProjectRoot());

/** Where runtime state that must survive a restart belongs. */
export function dataPath(...segments: string[]): string {
    return join(projectRoot, 'data', ...segments);
}
