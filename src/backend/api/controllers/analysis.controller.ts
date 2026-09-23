import { analyzeMarket } from '../../services/analysis.service';
import { MarketAnalysisSchema } from '../schemas';

export async function getAnalysis() {
    const analysis = await analyzeMarket();

    return MarketAnalysisSchema.parse(analysis);
}
