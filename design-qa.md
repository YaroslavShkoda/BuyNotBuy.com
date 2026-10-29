# Graphite visual QA —29 October2026

final result: blocked

## Owner feedback supersedes the initial local assessment

On29 October the owner rejected the new design, specifically its layout and block sizes, and preferred the previous design. The local assessment below is historical technical evidence and does not establish visual acceptance. YAR-106 remains open. A corrected composition must be shown and accepted before visual handoff; tests and green CI do not settle this feedback. The owner subsequently requested a landing page and asked for all briefing questions first; those questions are pending answers.

Scope: owner-selected Graphite direction and YAR-102–106 acceptance, preserving the existing research product. Source board is1536×1024, SHA d2fe7bf8f0d035cb1ce30a0dc2254522f86027dd89d1878ce86c9ee18dca9200. It combines an illustrative desktop and mobile composition, not exact viewport screenshots or a numeric chart oracle. The Linear brief's explicit tokens/actual API semantics take precedence over generated incidental data.

Opened source image and rendered1440×1000/390×1000 captures. Side-by-side comparison artifacts: `data/graphite/qa-desktop-comparison.png` and `qa-mobile-comparison.png`, source left/app right. Source content crops are resized for composition comparison; this does not establish pixel equality. Latest captures normalize secondary disclosures closed and pointer outside the chart, with data/table disclosure closed. Dates reflect the test fixture's actual hour rather than the historical mock date. Context/state comparison also covers768/1024/1920/360, stale and error captures.

Iteration1: increased label size exposed volume-label overlap and chart-header clipping; independent review found both. Auto-fit volume tracks/wrapping and wrapping chart header fixed them; DOM-range check reproduced RED then GREEN. Iteration2: chart SVG/axis coordinate regions had differing height; explicit plot height/display:block SVG fixed RED→GREEN. Iteration3: keyboard Escape lost focus; button ref restores it, matrix RED→GREEN. Final captures have no actionable P0/P1/P2 regression under this implementation scope.

Typography: system family, clear price hierarchy, tabular numbers,14px captions. Spacing/layout: compact masthead, native widths, chart-first narrow layout,44px controls; full data retained. Colours: declared Graphite tokens, labelled semantic states, blue interaction/EMA accents; reviewed muted/floating/hover contrast. Images: existing supplied logo reused; native chart remains numerical data, no raster or fabricated series. Copy: confidence is agreement, stale/unknown explicit, source/analysis scopes separate, research limitations retained.

Directional deviations/P3: mobile is taller than the board because full metadata and volume statistics remain; timestamps can be more compact. Source board's added navigation/trading-looking decoration is not introduced. The core chart data, price units and actual indicators take priority over its approximate curves. No unrequested routes, trading actions, icon assets or new dependencies.

Four independent-review minors are recorded exhaustively in docs/graphite-terminal.md. Actual browser zoom, hardware touch, NVDA/VoiceOver and field CWV remain NOT_TESTED; owner explicitly deferred manual acceptance. This QA result is local visual/functional acceptance, not release approval or full WCAG certification.
