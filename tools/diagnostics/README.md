# One-off diagnostics

Scripts written while bringing this plugin up inside a live dsh profile on
Windows. They are kept because each one settled a question that a unit test
could not: what the real cordis runtime does with a plugin's `apply()` result,
what a Loader entry does when it is re-applied, and how the shipped theme
tokens resolve. They contain absolute paths from that machine and are not part
of the install path.

| Script | Question it answered |
| --- | --- |
| `cordis-contract-probe.mjs` | What `ctx.on`, `ctx.effect` and an `async apply` return value actually do under the shipped cordis build |
| `instrument-installed.mjs` | Where a live mount fails: breadcrumbs around each owned effect |
| `make-instrumented-copy.mjs` | Mounting a fresh module URL (Node caches ESM per URL) with breadcrumbs |
| `switch-to-clean-live.mjs` | Moving the live entry to a clean, uninstrumented copy in one step |
