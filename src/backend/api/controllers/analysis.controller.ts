import { analyzeMarket } from '../../services/analysis.service';

export async function getAnalysis() {
    return analyzeMarket();
}
