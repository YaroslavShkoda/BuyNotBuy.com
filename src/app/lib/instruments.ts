import { fetchJson } from './api-error';

export interface InstrumentSummary {
    ticker: string;
    status: 'active' | 'inactive';
}

interface InstrumentsResponse {
    instruments: InstrumentSummary[];
}

export async function getInstruments(): Promise<InstrumentSummary[]> {
    const response = await fetchJson<InstrumentsResponse>(
        `${process.env.BACKEND_URL}/api/instruments`,
    );

    return response.instruments;
}
