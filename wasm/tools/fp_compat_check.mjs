// Deterministic CLI↔WASM fingerprint compatibility check — proves a server index built by the CLI (`olaf store`) will match fingerprints extracted in-browser from the same decoded samples, WITHOUT any LMDB database on either side (the browser has no DB; we simulate its matcher). Both sides use olaf_config_default(): `olaf cache -f` writes {id}.tdb under an isolated $HOME for the CLI/reference side, and the "server" profile extracts from identical ffmpeg-decoded samples for the WASM/query side.
// The two sides are NOT expected to be bit-identical on {t1,hash}: wasm's t1 is a constant offset (typically +1) from the CLI's and its tail flush differs slightly — neither breaks matching because Olaf tallies aligned pairs by timeDiff=(q_t1-r_t1)>>2 into buckets per resource id. So we prove compatibility three ways: (1) hash overlap >=95% of the index, (2) t1 shift is one single constant for >=95% of comparable pairs (a drift would scatter across many offsets), and (3) a matcher simulation without LMDB yields a dominant aligned-pair bucket >= 20. exit 0 when all hold; else 1 with full JSON diagnostics separating overlap vs shift vs alignment failures.
//
//   node wasm/tools/fp_compat_check.mjs [audio] [--exe <olaf.exe>]     ($OLAF_EXE also honoured)

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) { console.error("FAIL", message); process.exit(1); } // one-line machine-readable verdict, like the sibling tools.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url)); // wasm/tools/ -> repo root (zig-out/, dataset/ live here).
const defaultAudio = path.join(repoRoot, "dataset", "queries", "1051039_34s-54s.mp3");

// Parse argv: one optional audio path and an optional --exe <path>; $OLAF_EXE wins over the built-in zig-out/bin/olaf.exe.
const args = process.argv.slice(2); let audioPath = defaultAudio; let exeOverride = null;
for (let i = 0; i < args.length; i++) { if (args[i] === "--exe") { exeOverride = path.resolve(process.cwd(), args[++i]); } else if (!audioPath || !/^--/.test(args[i])) audioPath = path.resolve(process.cwd(), args[i]); }
const olafExe = process.env.OLAF_EXE ? path.resolve(process.cwd(), process.env.OLAF_EXE) : (exeOverride ?? path.join(repoRoot, "zig-out", "bin", "olaf.exe"));

if (!existsSync(audioPath)) fail(`audio not found at ${audioPath}`);
if (!existsSync(olafExe)) fail(`olaf executable not found at ${olafExe} — build it with \`zig build\` or pass --exe <path>`); // the CLI side is meaningless without a binary.

// Decode to mono 16 kHz f32le exactly like olaf_fp_extract_test.mjs, so both sides start from identical samples (the C core decodes internally; we feed this buffer to WASM).
let raw; try { raw = execFileSync("ffmpeg", ["-loglevel", "error", "-i", audioPath, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], { maxBuffer: 1 << 28 }); } catch (err) { fail(`ffmpeg failed to decode ${audioPath}: ${(err.stderr || err.message).toString().trim()}`); }
const samples = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));

// --- CLI side: `olaf cache -f` into a fresh isolated $HOME (pure defaults; no LMDB), then read the single .tdb it writes. ---
function parseTdb(text) { // header line "fp_hash, t1, f1, m1, ..." then one row per fingerprint with columns hash,t1,... — we only need col0=hash and col1=t1(=time_index of first EP).
	const lines = text.split(/\r?\n/); const out = []; // split on CRLF too: Windows may write \r\n.
	for (let i = 1; i < lines.length; i++) { // line 0 is always the header, per parseCachedFingerprints in olaf_cli_session.zig.
		const row = lines[i].trim(); if (!row) continue;
		const cols = row.split(","); const hashStr = (cols[0] ?? "").trim(); const t1Str = (cols[1] ?? "").trim(); // first two columns only — the rest are per-EP detail we don't compare.
		if (!/^\d+$/.test(hashStr) || !/^\d+$/.test(t1Str)) continue; // defensive: skip a malformed row rather than crash on it.
		out.push({ time_index: Number(t1Str), hash: Number(hashStr) }); // both are exact integers < 2**40, so plain JS numbers compare bit-exactly (no float rounding).
	}
	return out;
}

const tempHome = mkdtempSync(path.join(os.tmpdir(), "olaf_fpcompat_")); // unique per run: guarantees a clean cache dir with only our file.
let cliFps = []; try {
	execFileSync(olafExe, ["cache", "-f", audioPath], { env: { ...process.env, HOME: tempHome }, cwd: repoRoot, maxBuffer: 1 << 28 }); // -f forces a fresh extraction; isolated $HOME keeps real ~/.olaf untouched and uses pure defaults.
	const cacheDir = path.join(tempHome, ".olaf", "cache"); if (!existsSync(cacheDir)) fail(`no .tdb produced (expected ${cacheDir})`);
	const tdbFiles = readdirSync(cacheDir).filter((n) => n.endsWith(".tdb")); // a single audio input yields exactly one {id}.tdb.
	if (tdbFiles.length === 0) fail("olaf cache ran but wrote no .tdb file");
	cliFps = parseTdb(readFileSync(path.join(cacheDir, tdbFiles[0]), "utf8")); if (cliFps.length === 0) fail(`parsed zero fingerprints from ${cacheDir}/${tdbFiles[0]}`); // a non-empty clip must yield some.
} catch (err) { const detail = err && typeof err.message === "string" ? `${(err.stderr || "").toString().trim()}\n${err.message}` : String(err); fail(`olaf cache failed: ${detail.split("\n").slice(-3).join(" | ")}`); } finally { rmSync(tempHome, { recursive: true, force: true }); } // best-effort cleanup of the throwaway HOME.

// --- WASM side: extract with the server profile (= olaf_config_default()) and collect every fingerprint as it arrives. ---
let wasmFps = []; let grid; try { const handle = await (await import("../js/olaf_wasm.js")).instantiateOlaf(readFileSync(path.join(repoRoot, "wasm", "js", "olaf.wasm")), { onPrint: () => {}, profile: "server", onFingerprint: (fp) => wasmFps.push(fp) }); grid = handle.grid; for (let offset = 0; offset + 128 <= samples.length; offset += 128) handle.match(samples.subarray(offset, offset + 128)); } catch (err) { fail(`WASM extraction failed: ${err.message}`); }
if (!grid || grid.sampleRate !== 16000 || grid.stepSize !== 128) fail({ check: "server profile grid", sampleRate: grid?.sampleRate, stepSize: grid?.stepSize }); // the two sides only line up on this exact time-frequency grid.

// --- Analysis + PASS verdict (no LMDB) ------------------------------------------------------
// The two sides are NOT expected to be bit-identical on {t1,hash}: wasm's t1 is a constant offset from the CLI's and its tail flush differs. What we must prove instead: that the hashes overlap almost completely AND any time shift is one single constant (so it lands in ONE matcher bucket) — i.e. a real server index built by `olaf store` would still match these wasm fingerprints.
// olaf_config_default().searchRange — exactly how wide a real matcher looks up [hash-range, hash+range] around each query hash (src/olaf_fp_matcher.c:189-189). Overridable via OLAF_FP_COMPAT_SEARCH_RANGE for tolerance probing / negative control; default 5 keeps behavior identical to the real matcher.
const SEARCH_RANGE = (() => { const v = Number(process.env.OLAF_FP_COMPAT_SEARCH_RANGE); return process.env.OLAF_FP_COMPAT_SEARCH_RANGE !== undefined && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 5; })(); // default 5 unless explicitly overridden (e.g. =0 to probe the exact-hash-only case).
const MIN_MATCH_COUNT_SIM = 20; // the dominant aligned-pair bucket must be at least this large to count as "would match" — comfortably above olaf_config_default().minMatchCount.

// Point 1: multiset by HASH ONLY (t1 dropped) so we can measure how much of one side has a hash counterpart on the other, independent of any time shift.
function hashMultiset(fps) { const m = new Map(); for (const fp of fps) m.set(fp.hash, (m.get(fp.hash) ?? 0) + 1); return m; }

// Point 2: t1-shift evidence from the unambiguous pairs — hashes that occur exactly once on BOTH sides give a clean one-to-one pairing.
function shiftEvidence(diffs) { // diffs = array of integer (wasm_t1 - cli_t1). Returns histogram + min/mode/max/coverage, or null when empty.
	if (!diffs.length) return null;
	const freq = new Map(); for (const d of diffs) freq.set(d, (freq.get(d) ?? 0) + 1); // value -> how many times it occurs.
	let mode = NaN, maxCount = -1; const sortedVals = [...freq.keys()].sort((a, b) => a - b); // deterministic tie-break: smallest |d| then lowest d wins the "mode".
	for (const v of sortedVals) { if ((freq.get(v)) > maxCount || ((freq.get(v)) === maxCount && Math.abs(v) < Math.abs(mode))) { mode = v; maxCount = freq.get(v); } } // argmax count, tie -> least magnitude.
	const minD = sortedVals[0], maxD = sortedVals[sortedVals.length - 1];
	return { pairs: diffs.length, histogram: Object.fromEntries(sortedVals.map((v) => [String(v), freq.get(v)])), min: minD, mode, max: maxD, distinctValues: sortedVals.length, coveragePct: Math.round(100 * (maxCount / diffs.length)) }; // coverage = share of pairs at the single dominant offset.
}

// Point 3: matcher simulation without LMDB — CLI fingerprints are one reference resource (id=1); each wasm fingerprint is a query; tally aligned-pair buckets exactly like olaf_fp_matcher_tally_results does, so max bucket ≈ match_count.
function simulateMatcher(queryFps, refFps) { // O(|Q|*|R|): ~400x~430 pairs here — trivially fast and exact (hashes are < 2**34 integers). No hash index needed; brute force avoids any float/precision subtlety.
	const buckets = new Map(); let maxBucket = -1, dominantTimeDiff = NaN; // timeDiff -> aligned-pair count for this single resource id=1.
	for (const q of queryFps) { const lo = q.hash - SEARCH_RANGE, hi = q.hash + SEARCH_RANGE; // the real matcher's [hash-range, hash+range] window around each query hash.
		for (const r of refFps) { if (r.hash < lo || r.hash > hi) continue; // |ref_hash - q_hash| <= searchRange — same tolerance as olaf_fp_matcher.c:189-189.
			const timeDiff = ((q.time_index - r.time_index)) >> 2; // mirrors src/olaf_fp_matcher.c:147 exactly (arithmetic shift of a small signed int).
			buckets.set(timeDiff, (buckets.get(timeDiff) ?? 0) + 1); } }
	for (const [td, c] of buckets) { if (c > maxBucket || ((c === maxBucket) && Math.abs(td) < Math.abs(dominantTimeDiff))) { maxBucket = c; dominantTimeDiff = td; } } // argmax count -> the estimate of match_count.
	return { pairs: [...buckets.values()].reduce((a, b) => a + b, 0), buckets: Object.fromEntries([...buckets.entries()].sort((x, y) => x[0] - y[0])), maxBucket, dominantTimeDiff }; // all metrics for the diagnostics dump.
}

// --- Point 1: hash overlap (multiset by hash). common = sum over shared hashes of min(count_cli, count_wasm); only-in-each is what's left on that side. ---
const cliHashes = hashMultiset(cliFps), wasmHashes = hashMultiset(wasmFps); // Map<hash,count> per side (t1 dropped).
let commonCount = 0; for (const [h, c] of cliHashes) { const w = wasmHashes.get(h) ?? 0; if (w > 0) commonCount += Math.min(c, w); } // multiplicity-aware intersection.
const totalCli = cliFps.length, totalWasm = wasmFps.length; // reference index size vs query side size.
const onlyInCliCount = totalCli - commonCount, onlyInWasmCount = totalWasm - commonCount; // fingerprints with no hash counterpart on the other side (the tail-flush gap lives here).
const overlapPctVsCli = Math.round(100 * (commonCount / totalCli)); // "доля общих хэшей" relative to the CLI-built index we are proving against.

// --- Point 2: t1 shift, measured on unambiguous pairs first; fall back to a sorted pairing over all shared hashes when that subset is too small to be meaningful. ---
const cliByHash = new Map(), wasmByHash = new Map(); // hash -> [t1,...] per side (order of appearance).
for (const fp of cliFps) { let a = cliByHash.get(fp.hash); if (!a) { a = []; cliByHash.set(fp.hash, a); } a.push(fp.time_index); }
for (const fp of wasmFps) { let a = wasmByHash.get(fp.hash); if (!a) { a = []; wasmByHash.set(fp.hash, a); } a.push(fp.time_index); }

function pairingDiffs(byCli, byWasm, onlyOnceBothSides) { // for each shared hash pair up t1 lists (ascending), diff=wasm_t-cli_t; when onlyOnceBothSides is true restrict to hashes with exactly one on both sides.
	const diffs = []; const sharedHashes = [...byCli.keys()].filter((h) => byWasm.has(h));
	for (const h of sharedHashes) { if (onlyOnceBothSides && !(byCli.get(h).length === 1 && byWasm.get(h).length === 1)) continue; // point-2 literal subset.
		const c = [...byCli.get(h)].sort((a, b) => a - b), w = [...byWasm.get(h)].sort((a, b) => a - b); const n = Math.min(c.length, w.length); for (let i = 0; i < n; i++) diffs.push(w[i] - c[i]); } // smallest-with-smallest pairing: reduces exactly to the one-to-one case when both counts are 1.
	return diffs; }

const MIN_STRICT_PAIRS = 30; // below this, a "single constant" claim from that subset alone is not statistically meaningful -> use the generalized sorted-pairing instead (which subsumes it).
let offsetMethod = "strict_single_once"; const strictDiffs = pairingDiffs(cliByHash, wasmByHash, true); if (strictDiffs.length < MIN_STRICT_PAIRS) { offsetMethod = "generalized_sorted_pairing"; } // pick the evidence source up front so PASS/FAIL and display agree.
const activeDiffs = offsetMethod === "strict_single_once" ? strictDiffs : pairingDiffs(cliByHash, wasmByHash, false); const t1Offset = shiftEvidence(activeDiffs) ?? { pairs: 0, histogram: {}, min: null, mode: null, max: null, distinctValues: 0, coveragePct: 0 }; // the constant-shift evidence we gate on.
const strictT1Offset = shiftEvidence(strictDiffs); // always reported for transparency (point-2 literal), even when not used to gate PASS.

// --- Point 3: matcher simulation without LMDB — CLI as one reference resource, wasm as queries. ---
const sim = simulateMatcher(wasmFps, cliFps); // maxBucket ≈ the match_count a real server would report for this clip against its own index.

// --- Verdict (point 4): PASS iff hashes overlap >=95% AND t1 shift is one constant for >=95% of comparable pairs AND sim dominant bucket >= MIN_MATCH_COUNT_SIM. ---
const pass = commonCount / totalCli >= 0.95 && t1Offset.pairs > 0 && t1Offset.coveragePct >= 95 && sim.maxBucket >= MIN_MATCH_COUNT_SIM; // every clause must hold: coverage, constant shift (not drift), and a real aligned match.
const summary = `hash overlap: ${commonCount}/${totalCli} (${overlapPctVsCli}%), t1 offset mode=${t1Offset.mode === null ? "n/a" : String(t1Offset.mode)} (${t1Offset.coveragePct}%, method=${offsetMethod}), matcher sim max bucket=${sim.maxBucket}@timeDiff=${sim.dominantTimeDiff} -> ${pass ? "PASS" : "FAIL"}`; // the one-line human-readable verdict.
const diagnostics = { summary, cli_count: totalCli, wasm_count: totalWasm, hash_overlap: { commonCount, onlyInCliCount, onlyInWasmCount, overlapPctVsCli }, t1_offset_used: { method: offsetMethod, ...t1Offset }, t1_offset_strict_single_once: strictT1Offset ?? null, matcher_sim_without_lmdb: sim }; // full diagnostics so a failure is explainable (overlap vs shift vs alignment).

if (pass) { if (process.env.OLAF_FP_COMPAT_DEBUG === "1") console.log(JSON.stringify(diagnostics)); // optional deep dump for verification, off by default so PASS output stays one line.
	console.log(`compatibility OK: wasm fingerprints will match a CLI-built index without LMDB — ${summary}`); process.exit(0); }
console.error("FAIL", JSON.stringify(diagnostics)); // full diagnostics (overlap vs shift vs alignment) so the failure is explainable, not just "no".
process.exit(1);
