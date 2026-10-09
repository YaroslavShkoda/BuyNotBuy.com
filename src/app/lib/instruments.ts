import { z } from 'zod';

import { InstrumentsResponseSchema } from '../../backend/api/schemas';
import { fetchJson } from './api-error';

type InstrumentRow = z.infer<typeof InstrumentsResponseSchema>['instruments'][number];

export async function getInstruments(): Promise<InstrumentRow[]> {
    const response = await fetchJson(
        `${process.env.BACKEND_URL}/api/instruments`,
        InstrumentsResponseSchema,
    );

    return response.instruments;
}
