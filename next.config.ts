import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
    turbopack: {
        resolveAlias: {
            '../config/market.config.js': './src/backend/config/market.config.ts',
            '../indicators/divergence.js': './src/backend/indicators/divergence.ts',
            '../instruments/domain.js': './src/backend/instruments/domain.ts',
            '../signals/signal.types.js': './src/backend/signals/signal.types.ts',
            '../types/analysis.js': './src/backend/types/analysis.ts',
            '../types/candle-interval.js': './src/backend/types/candle-interval.ts',
            '../types/direction.js': './src/backend/types/direction.ts',
            '../types/venue.js': './src/backend/types/venue.ts',
            './asset.registry.js': './src/backend/config/asset.registry.ts',
            './market.capabilities.js': './src/backend/config/market.capabilities.ts',
            './market.defaults.js': './src/backend/config/market.defaults.ts',
            './market.env.js': './src/backend/config/market.env.ts',
            './market.runtime.js': './src/backend/config/market.runtime.ts',
            './market.schema.js': './src/backend/config/market.schema.ts',
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
