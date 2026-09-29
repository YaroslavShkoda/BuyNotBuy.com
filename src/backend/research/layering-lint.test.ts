import { describe, expect, it } from 'vitest';

import {
    DATABASE_ACCESSORS,
    EXEMPT,
    audit,
    databaseImports,
    dataLayerOf,
    isSeam,
    listSources,
} from './layering-lint.js';

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const realRoot = resolve(here, '..');

describe('deciding which layer a file belongs to', () => {
    it('puts the data layer in the data layer', () => {
        expect(dataLayerOf('db/pool.ts')).toBe('db');
    });

    it('puts a domain folder outside it, whatever is inside', () => {
        expect(dataLayerOf('indicators/indicator.service.ts')).toBeNull();
        expect(dataLayerOf('strategies/candidate.repository.ts')).toBeNull();
        expect(dataLayerOf('observability/health.registry.ts')).toBeNull();
    });
});

describe('reading a file, rather than scanning its text', () => {
    it('finds a database import', () => {
        const found = databaseImports(
            'thing.ts',
            "import { query } from '../db/pool.js';\nconst x = await query('SELECT 1');\n",
        );

        expect(found.map((entry) => entry.symbol)).toEqual(['query']);
    });

    it('finds a default import of the pool', () => {
        const found = databaseImports('thing.ts', "import getPool from '../db/pool.js';\n");

        expect(found.map((entry) => entry.symbol)).toEqual(['getPool']);
    });

    it('sees an import from a nested path inside the data layer', () => {
        const found = databaseImports(
            'thing.ts',
            "import { withTransaction } from '../db/retention.js';\n",
        );

        expect(found.map((entry) => entry.symbol)).toEqual(['withTransaction']);
    });

    it('is not fooled by a mention of a database symbol in a comment', () => {
        // The reason this parses. The scanner written earlier walked into a
        // multi-line template literal, never came out of it, and reported no
        // hardcode in a file that had one on line 63 — silently, and in a form
        // that looked like a passing result.
        const found = databaseImports(
            'thing.ts',
            '// we used to import { query } from ../db/pool.js\nconst x = 1;\n',
        );

        expect(found).toEqual([]);
    });

    it('is not fooled by a string that names the path', () => {
        const found = databaseImports(
            'thing.ts',
            "const p = '../db/pool.js';\nconst x = 1;\n",
        );

        expect(found).toEqual([]);
    });

    it('ignores a symbol from the data layer that is not a database accessor', () => {
        // `MIGRATIONS` and `LATEST_SCHEMA_VERSION` are data about the database,
        // not access to it. Counting them would produce offences nobody could
        // act on.
        const found = databaseImports(
            'thing.ts',
            "import { MIGRATIONS, LATEST_SCHEMA_VERSION } from '../db/migrations.js';\n",
        );

        expect(found).toEqual([]);
    });

    it('ignores an accessor name imported from somewhere that is not the data layer', () => {
        const found = databaseImports('thing.ts', "import { query } from '../config/db.js';\n");

        expect(found).toEqual([]);
    });

    it('handles an aliased import', () => {
        const found = databaseImports(
            'thing.ts',
            "import { query as run } from '../db/pool.js';\n",
        );

        expect(found.map((entry) => entry.symbol)).toEqual(['query']);
    });

    it('names every accessor it knows, so the list cannot grow silently', () => {
        expect(DATABASE_ACCESSORS).toEqual(
            expect.arrayContaining(['query', 'withTransaction', 'getPool']),
        );
    });
});

describe('the exemption', () => {
    it('is one named file with a reason, not a pattern', () => {
        expect(EXEMPT).toHaveLength(1);
        expect(EXEMPT[0]?.file).toBe('observability/health.registry.ts');
        expect(EXEMPT[0]?.reason.length).toBeGreaterThan(40);
    });
});

describe('this codebase, measured', () => {
    it('has no domain file that touches the database outside a repository', () => {
        // Zero, and pinned at zero so it cannot be raised quietly. This is the
        // rule M2 existed to enable, and it turned out to be enabled already:
        // all eleven files outside `db/` that reach into the database are ten
        // repositories and one health check.
        expect(audit(realRoot).offences).toEqual([]);
    }, 30000);

    it('names the ten repositories, so the accepted set is checkable', () => {
        // "There is no SQL in the domain" and "the only SQL in the domain is in
        // these ten files" are different claims, and only the second one can be
        // checked later. A guard that reports only failures says nothing about
        // what it accepted.
        const report = audit(realRoot);

        expect([...report.seams].sort()).toEqual([
            'analysis/signal-snapshot.repository.ts',
            'analysis/strategy-version.repository.ts',
            'history/candle.repository.ts',
            'history/signal-history.repository.ts',
            'indicators/performance/indicator-vote.repository.ts',
            'instruments/asset.repository.ts',
            'outcomes/outcome.repository.ts',
            'signals/lifecycle.repository.ts',
            'strategies/candidate.repository.ts',
            'strategies/decision-log.repository.ts',
        ]);
    }, 30000);

    it('exempts the health check rather than reporting it', () => {
        const report = audit(realRoot);

        expect(report.exempt.map((entry) => entry.file)).toEqual([
            'observability/health.registry.ts',
        ]);
    }, 30000);

    it('does not report the data layer itself', () => {
        const report = audit(realRoot);

        expect(report.offences.some((o) => o.file.startsWith('db/'))).toBe(false);
    }, 30000);

    it('does not report a domain file that never touches the database', () => {
        // The whole layer is full of files that import nothing from `db/`, and a
        // rule that reported them would be a rule about folders rather than
        // about the defect.
        const report = audit(realRoot);

        expect(report.offences.some((o) => o.file === 'indicators/indicator.service.ts')).toBe(
            false,
        );
    }, 30000);

    it('excludes tests, so a test that mocks the pool is not an offence', () => {
        // There are many; a rule that counted them would be unusable.
        const files = listSources(realRoot);

        expect(files.every((file) => !file.endsWith('.test.ts'))).toBe(true);
    }, 30000);
});

describe('which files are the declared seam', () => {
    it('treats a repository as the seam and nothing else', () => {
        expect(isSeam('strategies/candidate.repository.ts')).toBe(true);
        expect(isSeam('indicators/indicator.service.ts')).toBe(false);
        expect(isSeam('db/pool.ts')).toBe(false);
    });

    it('does not mistake a service for a repository because the word appears in it', () => {
        expect(isSeam('strategies/repository-service.ts')).toBe(false);
    });
});

describe('the file that has to parse correctly', () => {
    it('reports the line the import is on, not the line the file starts at', () => {
        // A guard that always says line 1 is a guard nobody can navigate with.
        const found = databaseImports(
            'thing.ts',
            ['const a = 1;', 'const b = 2;', 'const c = 3;', "import { query } from '../db/pool.js';", ''].join(
                '\n',
            ),
        );

        expect(found[0]?.line).toBe(4);
    });

    it('survives a file that does not parse', () => {
        // A broken file is a broken file, and the guard must still run — a
        // guard that dies on the first syntax error is a guard that only works
        // when there is nothing to report.
        const found = databaseImports('thing.ts', "import { query } from '../db/pool.js'\nconst = ;\n");

        expect(found.map((entry) => entry.symbol)).toEqual(['query']);
    });
});
