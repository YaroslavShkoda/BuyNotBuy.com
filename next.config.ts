import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
    turbopack: {
        resolveAlias: {
            '../indicators/divergence.js': './src/backend/indicators/divergence.ts',
            '../instruments/domain.js': './src/backend/instruments/domain.ts',
            '../signals/signal.types.js': './src/backend/signals/signal.types.ts',
            '../types/analysis.js': './src/backend/types/analysis.ts',
            '../types/direction.js': './src/backend/types/direction.ts',
        },
    },
    webpack(config) {
        config.resolve.extensionAlias = {
            ...config.resolve.extensionAlias,
            '.js': ['.ts', '.tsx', '.js'],
        };

        return config;
    },
};

export default nextConfig;
