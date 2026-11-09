# pi-qmd-index

pi extension: keeps the [qmd](https://github.com/) index fresh. When the agent edits files with `write`/`edit`, the dirty paths are collected; once the agent settles (`agent_settled`), it runs a full `qmd update` then `qmd embed`, and shows a summary parsed from qmd's output, e.g. `Files: 2 new, 1 updated · Vectors: 30 added` (or `Files: no changes · Vectors: up to date`). Dirty paths are flushed on `session_shutdown` too.

Deleted files are pruned automatically by `qmd update`'s full collection rescan — no special handling needed.

## Install

Register in pi's `settings.json` packages array:

```json
{ "extensions": ["/home/jooooody0710/projects/pi-qmd-index"] }
```

## Behavior notes

- Always a full-machine update (no per-collection env scoping).
- Cross-process file lock at `/tmp/qmd-index.lock`: if another pi agent on the same machine is already updating, this run is skipped and retried on the next settle. Stale locks (older than 10 min) are broken automatically.
- Fire-and-forget: dedup via a Set, one update at a time; failed runs re-queue their paths for the next settle.
- Status shows a generic "updating index…" (no file counts); the notify after completion carries the parsed qmd summary. Failures notify with the last 400 chars of qmd output.
