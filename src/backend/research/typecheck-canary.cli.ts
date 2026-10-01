/**
 * Proves that the type checks actually check something.
 *
 * ```
 * node --env-file=.env --import=tsx src/backend/research/typecheck-canary.cli.ts
 * ```
 *
 * On a machine whose `ComSpec` points at a terminal emulator, every `npm run`
 * script here exits 0 without executing anything: `npm run typecheck:backend`,
 * `npm run lint`, `npm test`. A commit with seven type errors passed that way
 * and was rejected by CI. The failure mode is not a red build — it is a green
 * one, which is the one nobody investigates.
 *
 * No amount of reading the code finds that. The scripts look right, the
 * configuration looks right, and the output is exactly the output of success.
 * What catches it is asking the check to fail on purpose and requiring that it
 * does.
 *
 * **How it works, and why it is not a test file.** A deliberately wrong `.ts`
 * file inside `src/backend` is written, the project's own type-check command is
 * run, and the file is removed in a `finally`. Two conditions have to hold: the
 * command must exit non-zero, and its output must name the canary file — because
 * a compiler that fails for an unrelated reason, or on a file nobody can find,
 * has not proved that it is looking at the backend at all.
 *
 * It is a command rather than a test on purpose. It must run *before* the thing
 * it audits, in the same breath as the type check it is verifying, and a test
 * that lives in the suite it is meant to supervise cannot fail early enough to be
 * worth anything.
 */
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

/**
 * The canary, written where the check must be able to see it.
 *
 * `src/backend/`, because the root tsconfig *excludes* `src/backend` on purpose
 * — a split that is right and is also the reason a broken backend check can look
 * like a passing one: the root project simply has nothing to say about it.
 */
const CANARY = join(repoRoot, 'src', 'backend', 'typecheck-canary.probe.ts');

/**
 * `string` assigned to `number`, which no configuration of this project permits:
 * not `strict: false`, not a widening rule, not an `any` leaking in.
 */
const PROBE = [
    '/** Written by typecheck-canary.cli.ts and removed immediately after. */',
    'export const deliberate: number = "not a number";',
    'void deliberate;',
    '',
].join('\n');

interface Outcome {
    readonly status: number | null;
    readonly output: string;
}

/**
 * The same compiler, the same project, invoked the way the check invokes it.
 *
 * Resolved through the project's own entry point rather than a path of my own:
 * a canary that ran a different compiler than the one in use would prove
 * something about the wrong tool, and the whole value of this is that it audits
 * the real command.
 */
function runTypeCheck(): Outcome {
    const result = spawnSync(
        process.execPath,
        [
            join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
            '-p',
            join('src', 'backend', 'tsconfig.json'),
            '--noEmit',
        ],
        // No shell, and that is the content of the finding rather than an
        // omission. The first version passed `shell: true` on Windows "to be
        // safe", which on this machine routes the compiler through the very
        // `cmd.exe` that `npm run` is broken by — so the canary reported the
        // compiler exiting zero and would have declared the type check vacuous
        // while the type check was in fact fine. An auditor that reproduces the
        // defect it audits proves nothing about it. `process.execPath` with an
        // argument list needs no shell on any platform, and omitting it is what
        // makes the result mean something.
        { cwd: repoRoot, encoding: 'utf8' },
    );

    return {
        status: result.status,
        output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    };
}

const say = (line: string): void => {
    process.stdout.write(`${line}\n`);
};

let outcome: Outcome;

try {
    writeFileSync(CANARY, PROBE, 'utf8');
    outcome = runTypeCheck();
} finally {
    // Removed before anything is reported: a canary left on disk would break the
    // real check it exists to audit, which is a way of failing that teaches
    // nothing.
    rmSync(CANARY, { force: true });
}

const namedTheCanary = outcome.output.includes('typecheck-canary.probe.ts');

say('Канарейка проверки типов');
say('');
say(`  Компилятор завершился с кодом: ${outcome.status}`);
say(`  Ошибка в canary-файле упомянута: ${namedTheCanary ? 'да' : 'НЕТ'}`);
say('');

if (outcome.status === 0) {
    say('  ПРОВАЛ: проверка типов прошла код с намеренной ошибкой в бэкенде.');
    say('  Она ничего не проверяет. Скрипт, который её запускает, вероятно,');
    say('  не выполняется вовсе — на этой машине так ведёт себя `npm run` при');
    say('  ComSpec, указывающем не на командную строку.');
    process.exitCode = 1;
} else if (!namedTheCanary) {
    say('  ПРОВАЛ: компилятор упал, но не на canary-файле. Значит он не смотрит');
    say('  на src/backend, и падение ничего не доказывает о нём.');
    process.exitCode = 1;
} else {
    say('  Проверка типов видит бэкенд: намеренная ошибка поймана.');
}