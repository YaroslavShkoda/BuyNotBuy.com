import type { z } from 'zod';

import type { ApiErrorResponseSchema } from './schemas';

export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
