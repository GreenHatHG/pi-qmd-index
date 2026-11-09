---
created_at: 2026-11-02
updated_at: 2026-11-05
topic: pi-qmd-index-extension
status: resolved
affected_modules: [pi-qmd-index, pi-extensions, qmd]
tags: [pi, extension, qmd, rag, agent_settled, tool_call, file-lock]
---

# pi Extension: Auto-Refresh qmd Index on Agent Settle

## 1. Context & Problem
The user maintains a qmd RAG index (`~/.cache/qmd/index.sqlite`, collections in `~/.config/qmd/index.yml`). Docs edited by the pi agent went stale until a manual `qmd update`. Goal: a pi extension that watches `write`/`edit` tool calls and re-runs a full `qmd update` + `qmd embed` once the agent settles. 2026-11-05 revision: env-var config removed, cross-process file lock added, status text simplified with output parsing.

## 2. Pitfalls & Failed Attempts (Gotchas - DO NOT REPEAT)
- **Attempt**: Per-write indexing (run qmd on every write/edit).
  - **Failure Reason**: Wasteful and racy. Correct pattern: collect dirty paths in a Set, flush once on `agent_settled` (pi fires it only when no retry/compaction/queued follow-up remains).
- **Attempt**: Delete handling via watching `bash` for `rm`.
  - **Failure Reason**: Unnecessary. Verified live: `qmd update` full rescan prunes deleted files. No special-case code.
- **REVERSED (2026-11-05): per-collection env scoping** (`QMD_INDEX_COLLECTION` → `-c`, `QMD_INDEX_EMBED_TIMEOUT`).
  - **Failure Reason**: User decided update is always full-machine; env vars removed entirely. Never re-add `process.env.*` config to this extension. (Earlier note that `-c` works for update/embed is still true, but the extension no longer uses it.)
- **Gotcha**: `qmd update --pull` is a **silent no-op**. Help text advertises it, parser accepts it, but `handleUpdateCommand` in qmd's `app/commands/maintenance.ts` only reads `--allow-run` and drops `pull`. Do not forward `--pull` until qmd implements it.
- **Gotcha**: file counts in UI status (`updating N file(s)…`) are wrong with a dedup Set across multiple agents — user rejected them. Show a generic status; parse real counts from qmd output instead.
- **Gotcha**: qmd CLI output contains ANSI color codes. Strip with `/\x1b\[[0-9;]*m/g` before regex-parsing summaries.
- **Gotcha**: qmd's `update` summary line is `Indexed: N new, N updated, N unchanged, N removed`; embed's is `✓ Embedded N/M chunks in Ns`. Regex against these exact strings.

## 3. Decision & Verified Solution
- **Chosen Approach**: Single-file pi extension. `tool_call` collects `write`/`edit` input paths (dedup Set); on `agent_settled` and `session_shutdown` spawn full `qmd update` then `qmd embed` (single-flight guard, re-queue on failure). A machine-wide lock file (`/tmp/qmd-index.lock`, `openSync(..., "wx")` + pid, stale > 10 min auto-broken) prevents concurrent pi agents on the same host from running overlapping full updates; if the lock is held, the flush is skipped and retried next settle. Status shows generic `"updating index…"`. On success, notify `qmd: <summary>` where summary is regex-parsed from qmd output, e.g. `2 new, 3 updated, 1 removed · 7/9 chunks embedded` (zero counts filtered out).
- **Key Changes**:
  - `/home/jooooody0710/projects/pi-qmd-index/index.ts` — full rewrite 2026-11-05: env vars removed, `acquireLock`/`releaseLock` added, `summarize()` added, embed timeout fixed at 180s constant.
  - `package.json` (`pi.extensions: ["./index.ts"]`), `README.md` (config section removed, lock + summary documented).
  - Registered in `~/.pi/agent/settings.json` `"packages"` array (NOT `extensions` array).
- **Minimal Code / Command Reference**:
  ```typescript
  function acquireLock(): boolean {
    try { const fd = openSync(LOCK_PATH, "wx"); writeSync(fd, String(process.pid)); closeSync(fd); return true; }
    catch {
      try { if (Date.now() - statSync(LOCK_PATH).mtimeMs > LOCK_STALE_MS) { unlinkSync(LOCK_PATH); return acquireLock(); } }
      catch { return acquireLock(); }
      return false; // another agent updating; retry next settle
    }
  }
  // flush: if (!acquireLock()) return;  →  spawn qmd update → qmd embed → ctx.ui.notify(`qmd: ${summarize(upd+emb)}`)
  ```
- **Verification**: lock logic tested live (first acquire true, second false, after release true); `summarize()` regex tested against real qmd output including ANSI.

## 4. Hard Constraints for Future AI
- NEVER run qmd per-write; ALWAYS batch into one flush on `agent_settled` (fallback flush on `session_shutdown`).
- NEVER re-add `process.env` configuration; updates are always full-machine, no `-c` scoping.
- ALWAYS take `/tmp/qmd-index.lock` before spawning qmd; skip and retry if held (never block).
- NEVER show computed file counts in `ui.setStatus`; only a generic status. Show parsed counts in the post-run `notify` only.
- NEVER pass `--pull` to `qmd update` — it is a no-op in current qmd.
- NEVER add delete-handling code; `qmd update` rescan prunes missing files.
- ALWAYS register the extension via `settings.json` `"packages"` array, not `"extensions"`.
- NEVER block the UI thread: spawn qmd with `stdio` pipes + timeout + SIGKILL, never `execSync`.
