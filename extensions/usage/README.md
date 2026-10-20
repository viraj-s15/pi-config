# Usage modal

Run `/usage` after `/reload`.

The modal is a fixed-column usage meter, not a stack of cost annotations. Every subscription keeps its quota bars. Dollar amounts share a right edge in a separate weekly API-value lane:

```text
Subscription    Quota used           Reset in     Weekly API value
Anthropic                                                   $23.45
  5h            █████░░░░░  50%        2h 10m  since Oct 14, 09:00
  7d            ███████░░░  70%        3d 4h

Codex                                                       $12.08
  5h            ███░░░░░░░  30%        1h 05m  since Oct 15, 11:30
  7d            ████░░░░░░  40%        2d 8h

30-day API value                                            $48.20
█████████████████████████████████████████████████████████████████
■ Anthropic $23.45    ■ OpenAI $24.75
```

The example is illustrative, not live account data. Amounts are USD at API-equivalent prices recorded in saved Pi sessions, not additional subscription charges or a provider invoice. Weekly values have provider-specific periods; they are not synchronized calendar-week totals.

## Controls

- `d`: show/hide model-level cost breakdowns, configured plan value multiples, daily history and full reset details.
- `r`: refresh quotas and costs. Repeated presses during an active refresh do not launch duplicate requests.
- `↑` / `↓`, `j` / `k`, `Page Up` / `Page Down`, `Home` / `End`: scroll when necessary. Mouse-wheel scrolling is supported in fullscreen mode.
- `Esc`, `q`, `Enter`: close.

The scope note and controls remain pinned on short terminals. Below the two-column breakpoint, each provider's amount stays right-aligned in its heading, its period moves below it, and quota bars use the full content width. No squeezed side-by-side panels. Long model-group labels retain their window suffix, and wide characters do not shift the numeric columns.

## Design research and decisions

The earlier free-form layout put bars, percentages, countdown sentences and cost annotations into successive rows without stable columns. Hiding details reduced density but did not solve the organization problem.

Three directly relevant examples informed the redesign:

- [Vercel AI Gateway budgets](https://vercel.com/docs/ai-gateway/observability-and-spend/budgets) pair scoped usage bars with spend and limits for a defined period. Here, capacity and monetary value belong together by provider, but in distinct lanes.
- [Cursor usage and limits](https://cursor.com/help/models-and-usage/usage-limits) distinguish quota/reset information from monetary usage and charges. Here, API-equivalent values must not be presented as actual bills or a dollar allowance.
- [Claude Code Usage Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) separates realtime meter views from daily/monthly analysis. Here, the daily cost chart and model breakdown remain behind `d` rather than competing with the initial quota view.

Alternatives considered: a free-form cost line beneath each provider (rejected after user feedback), one dense table row per quota window (duplicates a provider's weekly amount or implies cost belongs to one model bucket), selected-provider tabs (hide cross-provider status), and a shared quota grid with a provider-level value lane (chosen).

### Visual system

- **Palette:** text `#DDE1E6`, secondary text `#8D9199`, quiet outline/track `#33353B`, available quota `#08BDBA`, high usage `#EE5396`, cost-series blue `#33B1FF`. Existing warning and provider-series colors are retained; no new palette or decorative cards.
- **Type:** inherit the terminal's monospace font. Align by visible terminal columns, not string length. Bold provider names and dollar amounts; keep captions and dates muted.
- **Layout:** subscription/window labels, bars/percentages, reset countdowns, and weekly API values occupy stable lanes. Monetary values are right-aligned. One blank row separates actual provider groups; there are no per-provider boxes.
- **Restraint:** use `Reset in` once as a column heading rather than repeating a sentence per bar. Use `Weekly API value` once rather than repeating a cost label. The 30-day summary is a separate full-width share bar with one compact key, not a second nested table.
- **Honest scales:** quota bars use provider-reported percentages. The 30-day stacked bar shows the distribution of recorded monetary value across providers. API-equivalent value is never divided by the subscription price and drawn as a dollar-limit meter: there is no trustworthy API-dollar allowance denominator.

The plan was reviewed against the brief before implementation: provider cards and more charts would recreate dashboard clutter. The deliberate choice is one quiet terminal grid, keeping the existing bars as the primary visual element. Layout tests verify amount right edges, percentage columns, full-width cost bars, narrow stacking, and long labels. Actual compact/wide/narrow terminal renderings are reviewed before handoff.

## Accounting rules

- A week begins at the provider's next reset timestamp minus its declared seven-day window, not Monday, midnight, or seven days before opening the modal.
- Anthropic's overall `seven_day` bucket supplies its reset; model-only Opus/Sonnet caps do not substitute for a missing overall bucket.
- Codex must report an actual `limit_window_seconds` of 604800. A fallback label of `7d` alone is not enough to assert an interval.
- Antigravity's model groups may reset independently. Different or missing weekly reset timestamps mean there is no single trustworthy subscription interval, so the amount is unavailable. Direct Google API records are not attributed to Antigravity.
- Totals include records at the interval start and exclude its end and future-dated records. Forked copies of the same recorded response are deduplicated.
- Missing/expired reset metadata or unreadable session history shows **unavailable**, not `$0.00`. A valid, readable window with no recorded matching charges can genuinely show `$0.00`.
- Reset dates are displayed in local time; interval arithmetic uses absolute timestamps, including across daylight-saving transitions.
- Totals are grouped by saved provider IDs, not verified billing account identity. They exclude activity in other clients, deleted/unrecorded history, and the subagent and `/btw` calls not represented by the existing spend reader. The detail view's plan multiples use the manually configured monthly prices in `index.ts`.

Session parsing is cached until file size/mtime changes. Weekly queries use exact message timestamps, even if files have preserved older mtimes; they still walk/stat the session files on refresh. Quotas appear as soon as their requests finish, without waiting for cost scanning. Closing the modal prevents later results from updating it.

## Tests

```bash
node tests/run.mjs usage
```

Coverage includes all three quota payload parsers, precise interval bounds, provider-specific resets, missing and ambiguous windows, duplicate responses, unreadable history, compact/detail rendering, aligned columns, narrow and short terminals, wide-character labels, scroll/close/refresh controls, and stale refresh results.
