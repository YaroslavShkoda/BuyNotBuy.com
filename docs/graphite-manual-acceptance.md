# Manual acceptance — YAR-97/78

State29 October2026: NOT_TESTED, owner deferred because no AT/device is available. Automated browser results are separate evidence. Do not close YAR-78 from this checklist alone.

Record actual candidate SHA, device/model, OS, browser, AT/version, date, operator and a separate PASS/FAIL/NOT_TESTED for each step. Use a clearly labelled deterministic fixture for repeatable stale/error checks; do not interpret its displayed exchange label as actual upstream data.

1. On iOS/macOS enable VoiceOver, on Windows use NVDA, or on Android enable TalkBack. Open the candidate with browser zoom at100%, then200%; inspect touch or keyboard reflow on that actual device.
2. Traverse headings/landmarks in reading order: market name/price/quote, chart-source/age, chart/table, signal-source/age, direction/consensus/reasons, technical data and provenance/limitations. Check that announced labels/units match visible content.
3. Open the market picker; verify search label, current option and selection. Escape should close and return keyboard focus to the picker. Selecting BTC/ETH and15m/1h/4h/1d must preserve market identity.
4. Read the chart alternative with AT table navigation. Confirm caption, column headers/time/close/volume and no price/volume unit confusion. Focus its scroll region and scroll with keyboard/touch; all values must remain reachable.
5. Read67% as indicator agreement, not success/profit probability. LONG is published direction, not a buy action. Expand ATR/RSI/MACD and read actual measurements without assigning new voting weight.
6. In the controlled stale fixture, read both chart and analysis freshness/last-close/age; distinguish provider_failed, stale and partially_available. The diagnostic quality must not silently veto or change published direction.
7. Exercise insufficient history and429/502/503/504/retry. Confirm accessible error/retry and recovery without false success or a raw Next overlay. Capture any unsolicited announcement/focus movement.
8. Enable reduced motion, inspect focus in every control,200% text/browser zoom and touch targets. Record actual device/AT findings; screenshots/AX trees alone do not prove spoken output or hardware usability.

For a defect record minimal steps, expected/actual, exact SHA and sanitized screenshot/AT transcript. Never include account data, secrets or production dumps. Add a focused regression and link YAR-104/78; do not duplicate an existing defect.

Approval record: candidate SHA / device+OS+browser+AT versions / operator / per-step result / evidence / unresolved defects. Blank fields remain NOT_TESTED.
