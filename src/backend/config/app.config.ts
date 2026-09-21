import { z } from 'zod';

const AppConfigSchema = z.object({
    port: z.coerce.number().int().positive(),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export const appConfig: AppConfig = AppConfigSchema.parse({
    port:
        process.env.PORT ??
        '3001',
});
