/** Parse an explicit boolean environment value without silently coercing typos. */
export function booleanEnv(name: string, fallback: boolean): boolean {
    const raw = process.env[name];

    if (raw === undefined) {
        return fallback;
    }

    if (raw === 'true') {
        return true;
    }

    if (raw === 'false') {
        return false;
    }

    throw new Error(`${name} must be either "true" or "false"`);
}
