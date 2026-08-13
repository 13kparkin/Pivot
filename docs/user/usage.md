# Review usage

The Usage page has two layers:

1. **Plan limits** — live subscription capacity from `omp usage` for each
   authenticated upstream provider (for example Codex Plus: percent used and
   remaining, with reset time). This is what your plan still has left.
2. **Token history** — local omp session transcripts on the host (including
   sessions run outside Pivot): API-equivalent token cost, processed tokens,
   cache savings, and model breakdowns. When omp records a cost on a turn,
   that figure is preferred over estimated model rates.

Plan limits and raw token cost are separate. A low remaining plan quota can
still show high historical token totals for the selected window.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.
