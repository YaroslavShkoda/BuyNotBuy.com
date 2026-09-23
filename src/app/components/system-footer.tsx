export default function SystemFooter() {
    return (
        <footer className="system-footer">
            <div className="system-footer-main">
                <div className="system-brand">
                    <span className="system-brand-mark">₿</span>

                    <div>
                        <strong>BUYNOTBUY</strong>
                        <span>BITCOIN ANALYTICS TERMINAL</span>
                    </div>
                </div>

                <div className="system-status">
                    <span className="status-dot" />
                    <span>SYSTEM OPERATIONAL</span>
                </div>
            </div>

            <div className="system-footer-grid">
                <div className="system-info">
                    <span>MARKET DATA</span>
                    <strong>LIVE</strong>
                </div>

                <div className="system-info">
                    <span>DATA SOURCE</span>
                    <strong>BINANCE</strong>
                </div>

                <div className="system-info">
                    <span>ANALYTICAL ENGINE</span>
                    <strong>ACTIVE</strong>
                </div>

                <div className="system-info">
                    <span>VERSION</span>
                    <strong>0.1.0</strong>
                </div>
            </div>

            <div className="system-footer-bottom">
                <span>
                    BUYNOTBUY / MARKET INTELLIGENCE
                </span>

                <span>
                    DATA-DRIVEN ANALYSIS
                </span>
            </div>
        </footer>
    );
}