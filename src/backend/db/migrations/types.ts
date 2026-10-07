export interface Migration {
    readonly version: number;
    readonly name: string;
    readonly sql: string;
}
