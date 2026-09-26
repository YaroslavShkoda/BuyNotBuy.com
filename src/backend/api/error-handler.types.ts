import type { z } from 'zod';

import type { ApiErrorResponseSchema } from './schemas.js';

export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
