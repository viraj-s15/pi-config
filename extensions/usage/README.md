# Usage modal

Run `/usage` after `/reload`. One modal has two tabs, **Limits** and **Spend**. Tab or Shift-Tab switches between them without closing the modal.

## Limits

The default tab shows subscription quota bars for Anthropic, Codex and Antigravity: window, percent **used**, and time until reset. There are no costs on this tab. Press `d` to show or hide absolute reset dates in local time. This toggle is independent of Spend details. Providers load independently; one failed request does not hide the others.

## Spend

Spend opens on a deliberately compact overview, designed for a 76-column modal and no more than 22 body rows with normal data. It shows:

- The exact all-time processed token count once. No session response count is shown on the overview.
- A single-line picker for rolling **7 days, 30 days, 60 days, and all time**.
- One selected-period cost and abbreviated token-volume summary.
- Four compact count-and-cost rows: uncached input, cache reads, cache writes, and output.
- One cache summary with hit rate and estimated savings.

The overview has no rainbow token-share bar, provider rows, or charts. Press `d` to replace the overview body with **Models & history**; it does not append details below the overview. That view retains provider and model rows with token shares, daily token and cost charts, exact category counts, subscription-aligned weekly costs, and accounting notes. Only in this details view is the recorded response count shown, for the selected period.

Use **Left/Right** or **1/2/3/4** to select 7 days / 30 days / 60 days / all time. The default is 30 days. Changing periods returns the body to the top.

Illustrative compact overview (not live values):

```text
╭─ Usage ───────────────────────────────────────────────────────────────╮
│    Limits       [ Spend ]                                            │
├───────────────────────────────────────────────────────────────────────┤
│  1,440,000,000 tokens all time                                        │
│                                                                       │
│   7 days   [30 days]   60 days   All time                             │
│                                                                       │
│  $101.90                                           400.00M tokens     │
│  API-equivalent cost                                last 30 days      │
│                                                                       │
│  Uncached input                          10.00M             $20.00   │
│  Cache read                             380.00M             $60.00   │
│  Cache write                              8.00M             $12.00   │
│  Output                                   2.00M              $9.90   │
│                                                                       │
│  Cache hit 95.5%                         Est. saved $700.00            │
│  API-equivalent USD · Pi history                ←→ period              │
│  tab switch · d models & history · r refresh · esc close              │
╰───────────────────────────────────────────────────────────────────────╯
```

## Controls

Controls are context-specific: Left/Right and 1–4 change the period only on Spend; `d` toggles Spend's Models & history body on Spend, and reset-date details on Limits. These two `d` states are independent.

| Key | Action |
| --- | --- |
| Tab / Shift-Tab | Switch Limits / Spend |
| Left / Right | Change Spend period |
| 1 / 2 / 3 / 4 | Select 7 days / 30 days / 60 days / all time on Spend |
| d | Toggle Spend Models & history / return to overview, or Limits reset dates |
| r | Refresh limits and history; repeated presses during refresh do not duplicate requests |
| Up / Down, j / k | Scroll |
| Page Up / Page Down, Home / End | Scroll a page or jump to an edge |
| Esc / q / Enter | Close |

Fullscreen mouse-wheel scrolling is supported. Tab navigation, scope and controls remain pinned while the body scrolls. Switching tabs or changing periods returns the body to the top. Columns use visible terminal widths, preserving alignment for ANSI colors and wide characters. Narrow terminals keep one full-width body rather than squeezed side-by-side cards.

## Accounting

**API-equivalent value is not your invoice or an additional subscription charge.** Costs come from usage recorded in saved Pi sessions. This is not a cross-client usage importer: Claude Code, Codex CLI, T3 Code and other clients' histories are not read. Deleted history and unrecorded nested/subagent or `/btw` calls are not reconstructed.

- All time scans all available `.jsonl` history, including old files. The 7/30/60-day periods are rolling 24-hour windows, not calendar weeks/months. Records exactly at a rolling cutoff have rolled off; future records are excluded.
- Processed tokens = uncached input + cache reads + cache writes + output. Pi's `input` already excludes cache reads; `totalTokens` is not added again. Output includes reasoning where the provider reports it as output. Token totals describe processed volume across requests, not unique words or context size.
- Cache hit rate = cache reads / (uncached input + cache reads + cache writes).
- Estimated cache savings compare cache reads with the **same response's** recorded uncached input rate, subtracting its recorded cache-read cost. Records with no nonzero uncached-input token count or missing comparable costs are excluded and their token coverage is shown. No current rate card or invented historical price is substituted. This estimate is not a measured invoice discount.
- Valid token usage without cost is counted and marked **unpriced**. Known API costs remain a subtotal, not a claim that those unpriced requests were free. Legacy records with a total but no per-category prices are flagged; category sums can be lower than the total.
- Unreadable history is marked **partial**, never silently presented as complete zero usage. A readable empty period genuinely has zero recorded usage. Sub-cent values retain extra precision.
- Forked copies of responses are deduplicated by provider/response ID, or by entry ID/timestamp when response IDs are absent. Provider rows reflect stored provider IDs, not verified billing accounts.
- Daily charts use rolling 24-hour buckets, oldest first. On all time, charts show the latest 60 days while totals include all history. At narrow widths, only the latest days that fit are charted; the chart caption states the displayed span.

### Subscription weeks

The Spend detail view also retains exact subscription-aligned weekly costs. These are separate from the global rolling 7-day summary:

- A subscription week begins at its next reset timestamp minus its declared seven-day duration.
- Anthropic uses its overall seven-day bucket, not an Opus/Sonnet-only cap. Codex must report an actual 604800-second window; a fallback `7d` label alone does not establish a trustworthy interval.
- Antigravity model groups with missing or different resets cannot be combined into one subscription week. Direct Google API usage is not attributed to Antigravity.
- These intervals include their start and exclude their end. Missing/expired/ambiguous resets or unreadable history show **unavailable**, not a zero-dollar week. Dates are local; arithmetic uses absolute timestamps.

## Design

The two tabs separate live capacity from historical accounting, following the supplied T3 references without copying their three-tab web layout. The modal inherits the terminal's monospace font. The compact overview uses text `#DDE1E6`, muted text `#8D9199`, track `#33353B`, selection `#33B1FF`, and cache summary `#08BDBA`. It avoids the earlier dense repeated period/category/provider tables, accents on every metric, and inflated modal. More boxes/cards and a dashboard layout were rejected; competing charts do not appear together on the overview. Detailed model/provider coloring and charts remain in Models & history. Limits gets the full width for quota bars.

Session parsing is cached by file size/mtime. One scan produces all four global periods, and weekly queries reuse the parsed records. Quotas publish as their requests finish; closing the modal prevents late results from updating it.

## Tests

```bash
node tests/run.mjs usage
```

Tests cover quota parsing/auth, token and cache-cost accounting, savings coverage, daily buckets, historical windows, forks, missing prices/history, provider-specific weekly resets, tab/period/detail navigation, scrolling and pinned chrome, ANSI/wide-character alignment, narrow/short terminal bounds, resize, and independent/stale refreshes.
