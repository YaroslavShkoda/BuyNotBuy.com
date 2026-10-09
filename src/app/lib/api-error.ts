import type { ZodType } from 'zod';

export interface ApiErrorBody {
    error: {
        code: string;
        message: string;
    };
}

export class BackendApiError extends Error {
    readonly status: number;
    readonly code: string;

    constructor(status: number, body: ApiErrorBody) {
        super(`Backend returned ${status}: ${body.error.code}`);

        this.name = 'BackendApiError';
        this.status = status;
        this.code = body.error.code;
    }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
    if (typeof value !== 'object' || value === null) {
        return false;
    }

    const error = (value as { error?: unknown }).error;

    if (typeof error !== 'object' || error === null) {
        return false;
    }

    const { code, message } = error as { code?: unknown; message?: unknown };

    return typeof code === 'string' && typeof message === 'string';
}

export async function fetchJson<T>(url: string, schema: ZodType<T>): Promise<T> {
    // NOTE: fetch() is intentionally NOT wrapped in try/catch.
    // Next.js signals dynamic server usage by throwing a special
    // internal error (digest DYNAMIC_SERVER_USAGE) from fetch() during
    // static prerender. Wrapping it would break `next build` by hiding
    // that signal, so network failures propagate raw to the error boundary.
    const response = await fetch(url, { cache: 'no-store' });

    if (!response.ok) {
        let body: unknown = null;

        try {
            body = await response.json();
        } catch {
            body = null;
        }

        if (isApiErrorBody(body)) {
            throw new BackendApiError(response.status, body);
        }

        throw new Error(`Backend returned ${response.status}`);
    }

    let data: unknown;

    try {
        data = await response.json();
    } catch (error) {
        throw new Error('Backend returned invalid JSON', { cause: error });
    }

    // The wire is a contract, not a hope. TypeScript's `as T` checks nothing
    // at runtime, so a backend that drifted — a renamed field, a string where
    // a number belongs — used to reach the page as confident garbage. The same
    // schemas the controllers parse on the way out parse here on the way in:
    // one contract, enforced at both ends, and a violation is a loud error
    // that names the field rather than a page drawn from nothing.
    const parsed = schema.safeParse(data);

    if (!parsed.success) {
        const issues = parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(корень)'}: ${issue.message}`)
            .join('; ');

        throw new Error(
            `Backend response does not match the contract at ${url}: ${issues}`,
            { cause: parsed.error },
        );
    }

    return parsed.data;
}
