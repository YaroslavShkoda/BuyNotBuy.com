import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { createApp } from '../app.js';

/**
 * This suite exists because the redaction used to be wrapped around `app.log`
 * after the server was built. That covered the one logger it was assigned to
 * and nothing else: every request-scoped logger Fastify derives with `child()`
 * — including the `request.log` the error handler writes through — kept
 * writing verbatim. The test therefore drives a real request and reads the real
 * sink rather than calling the redactor directly.
 */

// Not a credential. This string exists only to be searched for.
const SECRET = 'SENTINEL_PASSWORD_9f2c';
const CONNECTION_STRING = `postgres://buynotbuy:${SECRET}@127.0.0.1:5432/buynotbuy`;

function capturingSink(lines: string[]): Writable {
    return new Writable({
        write(chunk, _encoding, callback) {
            lines.push(chunk.toString());
            callback();
        },
    });
}

async function drain(): Promise<void> {
    // The stream is written synchronously, but a resolved request and a flushed
    // log line are not the same instant.
    await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('log redaction', () => {
    it('keeps a password carried by a thrown error out of the sink', async () => {
        const lines: string[] = [];
        const app = createApp(capturingSink(lines));

        app.get('/__redaction-probe', async () => {
            throw new Error(`connect ECONNREFUSED ${CONNECTION_STRING}`);
        });

        await app.ready();
        await app.inject({ method: 'GET', url: '/__redaction-probe' });
        await app.close();
        await drain();

        const written = lines.join('');

        expect(written).toContain('[redacted]');
        expect(written).not.toContain(SECRET);
    });

    it('redacts a secret carried by a request-scoped logger as well as the root one', async () => {
        const lines: string[] = [];
        const app = createApp(capturingSink(lines));

        app.get('/__redaction-scopes', async (request) => {
            // The root logger and the request-scoped one are separate objects.
            // Only the second of these is the one the error handler uses, so
            // covering it is the point of this test.
            app.log.error({ err: new Error(CONNECTION_STRING) }, 'from app.log');
            request.log.error({ err: new Error(CONNECTION_STRING) }, 'from request.log');

            return { ok: true };
        });

        await app.ready();
        await app.inject({ method: 'GET', url: '/__redaction-scopes' });
        await app.close();
        await drain();

        const written = lines.join('');

        expect(written).toContain('from request.log');
        expect(written).not.toContain(SECRET);
    });
});
