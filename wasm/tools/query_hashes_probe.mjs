// Reusable probe for the /api/query-hashes endpoint: it extracts fingerprints from a query audio with
// the browser module (server profile = olaf_config_default()), cuts them into overlapping self-contained
// windows, and POSTs each window to <baseUrl>/api/query-hashes. It prints per-window HTTP status + matches
// found (path / match_count / match_identifier) plus a final summary; exits 0 when at least one POST returned
// 2xx, else 1. Network/CORS/DNS failures are reported as clear messages instead of crashing the run. Reusable
// against any live server — both `olaf rest serve` and an ad-hoc instance work (see local_query_hashes_e2e.mjs).
//
//   node wasm/tools/query_hashes_probe.mjs <baseUrl> [query audio] [windowSeconds=10] [hopSeconds=5]

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// The probe lives in wasm/tools/, so the shared loader and windowing module are one level up.
import { instantiateOlaf } from "../js/olaf_wasm.js";
import { createWindowBuffer } from "../js/olaf_windows.js";

function fail(message) { console.error("FAIL " + message); process.exit(1); }

const baseUrl = (process.argv[2] ?? "").replace(/\/+$/, ""); // strip trailing slashes so we can append /api/query-hashes.
if (!baseUrl || !/^https?:\/\/.+/i.test(baseUrl)) fail(`usage: node wasm/tools/query_hashes_probe.mjs <baseUrl> [query audio] [windowSeconds=10] [hopSeconds=5]\n       baseUrl must look like http://host:port (got "${process.argv[2]}")`);

const defaultQuery = fileURLToPath(new URL("../../dataset/queries/1051039_34s-54s.mp3", import.meta.url)); // repo/dataset/...
const queryPath = process.argv[3] ? path.resolve(process.cwd(), process.argv[3]) : defaultQuery;

function parseSeconds(value, fallback) { const n = Number(value); return (Number.isFinite(n) && n > 0) ? n : fallback; }
const windowSeconds = parseSeconds(process.argv[4], 10); // one self-contained query span.
const hopSeconds = parseSeconds(process.argv[5], 5);     // overlap between consecutive windows.

if (!existsSync(queryPath)) fail(`query audio not found at ${queryPath}`);
let wasmBytes; try { wasmBytes = readFileSync(fileURLToPath(new URL("../js/olaf.wasm", import.meta.url))); } catch (err) { fail("cannot load js/olaf.wasm: " + err.message + " — build it with `zig build web`"); }

// Decode the query to mono 16 kHz f32le, exactly like olaf_wasm_test.mjs does.
let raw; try { raw = execFileSync("ffmpeg", ["-loglevel", "error", "-i", queryPath, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], { maxBuffer: 1 << 28 }); } catch (err) { fail(`ffmpeg failed to decode ${queryPath}: ${(err.stderr || err.message).toString().trim()}`); }
const samples = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));

// Extract fingerprints with the server profile (= olaf_config_default()), collecting them as they arrive.
const collected = []; // {time_index:int, hash:number} in arrival order (non-decreasing time).
let handle; try { handle = await instantiateOlaf(wasmBytes, { onPrint: () => {}, onFingerprint: (fp) => collected.push(fp) }); } catch (err) { fail("instantiateOlaf failed: " + err.message); }
const grid = handle.grid; // server profile must be 16 kHz / step 128.

// Feed samples in 128-sample render quanta like an AudioWorklet; match() emits fingerprints synchronously into `collected`.
for (let offset = 0; offset + 128 <= samples.length; offset += 128) handle.match(samples.subarray(offset, offset + 128));

if (collected.length === 0) fail(`no fingerprints extracted from ${queryPath} (${(samples.length / grid.sampleRate).toFixed(1)}s decoded)`);
console.log(`extracted ${collected.length} fingerprints over ~${(samples.length / grid.sampleRate).toFixed(1)}s`);

// Convert the requested seconds into Olaf's block grid using its own sampleRate/stepSize (server profile: 16000/128 = 125 blocks/s),
// then cut the fingerprint stream into overlapping self-contained windows on that time grid.
const windowBlocks = Math.max(1, Math.round(windowSeconds * grid.sampleRate / grid.stepSize)); // e.g. 10s -> 1250 blocks.
let hopBlocks; try { const hb = Math.max(1, Math.round(hopSeconds * grid.sampleRate / grid.stepSize)); if (hb > windowBlocks) throw new Error("hop must be <= window"); hopBlocks = hb; } catch (err) { fail(err.message + " — need 0 < hop <= window seconds"); }
const buffer = createWindowBuffer(windowBlocks, hopBlocks); // throws on invalid args; validated above so this is safe here.

let windows = buffer.push(collected).map((w) => w.fingerprints); // completed spans only (a trailing incomplete span stays pending by design of the windowing module).
if (windows.length === 0 && collected.length > 0) { console.log(`no complete ${windowSeconds}s window in this clip — sending all fingerprints as a single query`); windows = [collected]; } // guarantee at least one real POST regardless of clip length.

// Pull every distinct match object out of an arbitrary response envelope, wherever it is nested. Each real match appears both under results[].data.queries[].matches[] and again (tagged with endpoint/query_offset) in the summary.matches[], so we de-duplicate on path+match_count to avoid double-counting them here.
function collectMatches(node, acc, seen) {
	if (!node || typeof node !== "object") return; // leaves: nothing to walk into.
	const entries = Array.isArray(node) ? node : Object.values(node);
	for (const v of entries) {
		if (v && typeof v === "object" && !Array.isArray(v)) {
			if (Number.isFinite(v.match_count) && typeof v.path === "string") { // a match object.
				const key = `${v.path}|${v.match_count}`;
				if (!seen.has(key)) { seen.add(key); acc.push({ path: v.path, match_count: Number(v.match_count), match_identifier: ("match_identifier" in v ? v.match_identifier : null) }); } // de-dup on identity.
			}
		}
		collectMatches(v, acc, seen); // recurse into arrays and objects alike; leaves return early above.
	}
	return acc;
}

// POST one window's fingerprints as {"fingerprints":[{"t1":int,"hash":int}]}; never throws — network/CORS/DNS errors are returned for reporting.
async function postWindow(fingerprints) { const body = JSON.stringify({ fingerprints: fingerprints.map((fp) => ({ t1: fp.time_index, hash: Math.trunc(fp.hash) })) }); try { const res = await fetch(baseUrl + "/api/query-hashes", { method: "POST", headers: { "Content-Type": "application/json" }, body }); const text = await res.text(); let json; try { json = JSON.parse(text); } catch {} return { status: res.status, ok: (res.ok >= 200 && res.ok < 300), matches: collectMatches(json, [], new Set()) }; } catch (err) { return { status: null, ok: false, error: `${(err?.name ?? "Error")}: ${err.message}` }; } }

let twoXxWindows = 0; let bestMatch = null; // {count, path, match_identifier} of the strongest match seen so far across all windows.
for (const [i, fps] of windows.entries()) {
	const r = await postWindow(fps); if (r.ok) twoXxWindows++;
	let detail = ""; if (r.error) detail += " (" + r.error + ")"; else if (r.matches && r.matches.length > 0) detail += ", matches: " + JSON.stringify(r.matches.slice(0, 3)); else if (r.ok) detail += ", no matches"; // per-window status line.
	console.log(`window ${i + 1}/${windows.length} (${fps.length} fingerprints)` + ` → HTTP ${(r.status ?? "ERR")}` + detail);
	if (r.matches) for (const m of r.matches) { const c = Number(m.match_count ?? -1); if (!bestMatch || c > bestMatch.count) bestMatch = { count: c, path: m.path, match_identifier: m.match_identifier }; } // track the strongest hit.
}

let summaryTail; if (bestMatch) { let idPart = ""; if (bestMatch.match_identifier != null) idPart = " (match_identifier=" + String(bestMatch.match_identifier) + ")"; summaryTail = `, best match_count=${String(bestMatch.count)} for "${bestMatch.path}"${idPart}`; } else summaryTail = ", no matches found"; // final verdict line.
console.log(`summary: ${windows.length} window(s) posted, ${twoXxWindows}/${windows.length} returned 2xx` + (summaryTail ?? ""));
process.exit(twoXxWindows > 0 ? 0 : 1);
