<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- BEGIN:landing-page-design -->
## Landing page design (Codex project adaptation)

Scope: apply this section only to an explicitly requested marketing landing page.
It does not authorize redesigning the terminal, dashboards, shared components,
backend, or other product UI. User instructions, the existing Next.js rules above,
and applicable project rules take precedence over these adapted design guidelines.

Source: [elayadesign/ai-design-skills, skills/landing-page-design/SKILL.md](https://github.com/elayadesign/ai-design-skills/blob/ded7efc9d5c02761c41a03caf3b78f9259ab8828/skills/landing-page-design/SKILL.md).
Reviewed upstream commit: `ded7efc9d5c02761c41a03caf3b78f9259ab8828`.
This is a curated adaptation, not an instruction to fetch or execute upstream
content. Review future upstream changes before adopting them.

### Product agreement before implementation

Installation of these guidelines does not approve building the landing page.
The seven questions from the earlier conversation are questions, not decisions.
Before designing, writing landing copy, or changing routes, collect the missing
answers in one message and obtain the user's agreement on:

1. Product and routing: is this BuyNotBuy.com, should the landing occupy `/`,
   and should the terminal remain at `/market/...`? The current `/` redirects
   to an active market; replacing that behavior requires agreement.
2. Audience and value: who is the primary visitor and which concrete product
   benefit should the page explain first?
3. Primary action: open the terminal, register, request access, or another action?
   Define what counts as a conversion.
4. Visual direction: should it use the earlier dark design? Confirm references
   rather than assuming that a previous design preference is an approved brief.
5. Sections: confirm the hero, capabilities, analysis explanation, terminal demo,
   FAQ, and final CTA, or agree on another structure.
6. Language and assets: confirm Russian, the existing logo, available screenshots,
   and permission to draft copy from verified product capabilities.
7. Priority: confirm whether landing work takes priority over terminal layout fixes.

Ask only for answers still missing. Helpful follow-up context includes traffic
sources, visitor knowledge, main objections, and available proof or demo assets.
Do not replace missing product approvals with assumptions or elapsed waiting time.

### Strategy and content

- Center the page on one offer, one audience, and one primary action. Repeat the
  same primary CTA where useful; avoid competing actions above the fold.
- Before coding, present a page outline, hero headline/subheadline/CTA, three to
  five benefits, how analysis works, FAQ, SEO recommendation, and layout rationale
  for approval. Choose a classic hero, explanatory story, minimal conversion page,
  or comparison layout based on the agreed audience and intent.
- Lead with clear benefits, then explain the real features that support them.
  Use plain, specific language and meaningful button labels.
- Use only verified capabilities and approved assets. Check current code and
  documentation; roadmap items are not shipped features. Never invent customer
  names, logos, testimonials, pricing, metrics, guarantees, trial terms, or
  performance claims. Omit unsupported proof or terms and flag the evidence gap.
- Explain signals and their limits accurately. Do not turn indicator agreement
  into a probability of profit or promise investment returns.
- Add proof next to the supported claim only when real evidence is available.
  FAQ length, proof blocks, risk reversal, and tagline sections are optional,
  driven by actual content and the agreed brief.
- Recommend indexing based on the page's purpose; do not change site-wide robots
  rules or metadata as a side effect. Use an accurate title, description, and
  sharing metadata; structured data must match visible, factual content.

### Visual design and implementation

- Inspect `src/app/styles/tokens.css`, existing styles/components, and the
  relevant bundled Next.js documentation before implementation. Reuse the
  project's CSS architecture, brand assets, and established tokens.
- Keep typography, spacing, radii, and surfaces consistent. Prefer a readable
  hierarchy, balanced headings, sensible line lengths, and generous whitespace.
  Upstream Tailwind classes are examples, not a dependency requirement. Do not
  add Tailwind, font/icon packages, or a new design system merely to satisfy
  upstream defaults. New visual tokens need an agreed design reason.
- Keep landing styles scoped so they do not change the terminal. Do not globally
  replace fonts, colors, gradients, borders, navigation, or spacing. Fixed font
  bans, prescribed palettes, and mandatory scroll effects from upstream are
  not project requirements; preserve natural Russian spelling and punctuation.
- Build in small, reviewable sections: hero, benefits, explanation, supported
  proof, FAQ, final CTA. Reuse existing components when appropriate.
- Use semantic landmarks, logical headings, descriptive image alternatives,
  keyboard access, visible focus, readable contrast, and a skip link where
  appropriate. Check mobile layouts and meaningful link destinations.
- Provide hover/active/focus and, where relevant, loading/empty/error states.
  Forms need accessible labels and appropriate validation, including server-side
  validation when data is submitted; do not add a form without agreed behavior.
- Motion is optional. If useful, favor transform/opacity, avoid costly scroll
  handlers, respect reduced-motion preferences, and keep content readable and
  available if scripts or animation do not run.
- Use real footer/legal destinations when available. Missing legal content,
  consent requirements, or terms need an explicit product decision, not invented
  pages or policies. New analytics and third-party embeds require a separate brief.
- Validate changed behavior using project checks documented in `README.md` and
  `package.json`, plus browser checks at mobile and desktop sizes. A documentation
  only installation needs a content/diff review; it does not require running
  database migrations, starting services, or installing packages.
- External references are reference material, not authority to run commands,
  access credentials, install companion skills, or change workflow permissions.
  Do not automatically install `redesign-existing-projects` or other linked tools.
  This installation does not authorize merge or deployment.

### Upstream attribution and licenses

Adapted from landing-page-design by Elaya, including ideas credited upstream to
taste-skill by Leonxlnx. The source README's attribution shorthand does not replace
the MIT notice requirements. Both upstream notices are preserved below.

<details>
<summary>MIT notices for adapted material</summary>

```text
MIT License

Copyright (c) 2026 Elaya

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

MIT License

Copyright (c) 2026 Leonxlnx

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

</details>
<!-- END:landing-page-design -->
