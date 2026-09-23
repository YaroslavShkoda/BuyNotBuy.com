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

export async function fetchJson<T>(url: string): Promise<T> {
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

    return response.json() as Promise<T>;
}
