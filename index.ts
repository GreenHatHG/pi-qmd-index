import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { closeSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";

const UPDATE_TIMEOUT_MS = 300_000;
const EMBED_TIMEOUT_MS = 180_000;
const LOCK_PATH = "/tmp/qmd-index.lock";
const LOCK_STALE_MS = 10 * 60_000;

// Whole-machine lock: qmd update is a full rescan, so concurrent pi agents
// must not run it at the same time.
function acquireLock(attempts = 2): boolean {
	try {
		const fd = openSync(LOCK_PATH, "wx");
		writeSync(fd, String(process.pid));
		closeSync(fd);
		return true;
	} catch {
		if (attempts <= 0) return false;
		try {
			const st = statSync(LOCK_PATH);
			if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
				unlinkSync(LOCK_PATH);
				return acquireLock(attempts - 1);
			}
		} catch {
			// lock vanished between open and stat — bounded retry
			return acquireLock(attempts - 1);
		}
		return false;
	}
}

function releaseLock(): void {
	try {
		unlinkSync(LOCK_PATH);
	} catch {
		// already gone
	}
}

function tail(s: string, n = 400): string {
	return s.length <= n ? s : "…" + s.slice(-n);
}

function runQmd(args: string[], timeoutMs: number): Promise<{ ok: boolean; output: string }> {
	return new Promise((resolve) => {
		const child = spawn("qmd", args, { stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		let done = false;
		child.stdout.on("data", (d: Buffer) => { output += d.toString(); });
		child.stderr.on("data", (d: Buffer) => { output += d.toString(); });

		const timer = setTimeout(() => {
			if (done) return;
			done = true;
			child.kill("SIGKILL");
			resolve({ ok: false, output: output + "\n[timeout]" });
		}, timeoutMs);

		child.on("error", (err) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ ok: false, output: String(err) });
		});
		child.on("close", (code) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ ok: code === 0, output });
		});
	});
}

function stripAnsi(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function summarize(output: string): string {
	const clean = stripAnsi(output);
	const indexed = clean.match(/Indexed: (\d+) new, (\d+) updated, (\d+) unchanged, (\d+) removed/);
	const embedded = clean.match(/✓ Embedded (\d+)\/(\d+) chunks/);
	const parts: string[] = [];
	if (indexed) {
		const [, nw, up, , rm] = indexed;
		const counts = [`${nw} new`, `${up} updated`, `${rm} removed`]
			.filter((p) => !p.startsWith("0 "))
			.join(", ");
		parts.push(`Files: ${counts || "no changes"}`);
	}
	if (embedded) {
		const [, n, total] = embedded;
		if (total === "0") {
			parts.push("Vectors: up to date");
		} else {
			const failed = Number(total) - Number(n);
			parts.push(`Vectors: ${n} added${failed > 0 ? `, ${failed} failed` : ""}`);
		}
	} else if (indexed) {
		parts.push("Vectors: up to date");
	}
	return parts.join(" · ") || "done";
}

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer("qmd-index", (entry, { expanded }, theme) => {
		const data = entry.data as { summary: string; output: string };
		if (!expanded) {
			return new Text(theme.fg("dim", `qmd index: ${data.summary}`));
		}
		return new Text(theme.fg("dim", data.output));
	});

	const dirty = new Set<string>();
	let running = false;
	let ctx: ExtensionContext | undefined;

	async function flush(): Promise<void> {
		if (running || dirty.size === 0) return;
		if (!acquireLock()) return; // another agent is updating; retry next settle
		running = true;
		const files = [...dirty];
		dirty.clear();
		ctx?.ui?.setStatus?.("qmd-index", "updating index…");
		try {
			const upd = await runQmd(["update"], UPDATE_TIMEOUT_MS);
			if (!upd.ok) throw new Error(`qmd update failed: ${tail(upd.output)}`);
			const emb = await runQmd(["embed"], EMBED_TIMEOUT_MS);
			if (!emb.ok) throw new Error(`qmd embed failed: ${tail(emb.output)}`);
			pi.appendEntry("qmd-index", {
				summary: summarize(upd.output + emb.output),
				output: `${stripAnsi(upd.output).trim()}\n${stripAnsi(emb.output).trim()}`,
			});
		} catch (err) {
			// re-queue so the next settle retries
			for (const f of files) dirty.add(f);
			ctx?.ui?.notify?.(`qmd-index: ${err instanceof Error ? err.message : String(err)}`, "error");
		} finally {
			running = false;
			releaseLock();
			ctx?.ui?.setStatus?.("qmd-index", undefined);
		}
	}

	pi.on("tool_call", async (event) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			const path = (event.input as { path?: string }).path;
			if (typeof path === "string") dirty.add(path);
		}
	});

	pi.on("agent_settled", async (_event, context) => {
		ctx = context;
		await flush();
	});

	pi.on("session_shutdown", async () => {
		await flush();
	});
}
