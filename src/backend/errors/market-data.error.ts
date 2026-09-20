export class MarketDataError extends Error {
    constructor(message: string) {
        super(message);

        this.name = 'MarketDataError';
    }
}
