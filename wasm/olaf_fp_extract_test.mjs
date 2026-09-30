// Runs the browser module (olaf.wasm) in node through the shared loader with the
// server profile and onFingerprint enabled, to verify that fingerprint extraction is
// correct and deterministic. The grid must match olaf_config_default() (16 kHz / step 128),
// every hash a non-negative integer below 2**40, time_index an integer in non-decreasing
// order and never from the future relative to the last processed block; two independent
// runs on the same samples must be bit-for-bit identical. Requires ffmpeg for decoding.
//
//   node wasm/olaf_fp_extract_test.mjs [wasm] [query audio]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { instantiateOlaf } from "./js/olaf_wasm.js";

const wasmPath = process.argv[2] ?? fileURLToPath(new URL("js/olaf.wasm", import.meta.url));
const queryPath = process.argv[3] ?? fileURLToPath(new URL("../dataset/queries/1051039_34s-54s.mp3", import.meta.url));
const wasmBytes = readFileSync(wasmPath);

// Feeds samples in 128-sample blocks, like an AudioWorklet; returns the grid and every
// fingerprint reported by olaf_fp_callback. A second independent run on the same samples
// must be bit-for-bit identical (determinism). finalBlockIndex is the last block index
// returned by match(), used to reject fingerprints "from the future".
async function extract(samples) {
	const fingerprints = [];
	let finalBlockIndex = 0;
	const olaf = await instantiateOlaf(wasmBytes, { profile: "server", onFingerprint: (fp) => fingerprints.push(fp) });
	for (let offset = 0; offset + 128 <= samples.length; offset += 128) {
		finalBlockIndex = olaf.match(samples.subarray(offset, offset + 128));
	}
	return { grid: olaf.grid, fingerprints, finalBlockIndex };
}

const raw = execFileSync("ffmpeg", ["-loglevel", "error", "-i", queryPath, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);

// Two independent runs on the same decoded audio.
const runA = await extract(samples);
const runB = await extract(samples);

function fail(detail) { console.error("FAIL", JSON.stringify({ ...detail })); process.exit(1); }

const grid = runA.grid;
if (grid.sampleRate !== 16000 || grid.stepSize !== 128) fail({ check: "server profile grid", sampleRate: grid.sampleRate, stepSize: grid.stepSize });

const fingerprints = runA.fingerprints;
if (fingerprints.length === 0) fail({ check: "no fingerprints" });

// Each hash is a non-negative integer below 2**40. Track the range for the summary line.
let minHash = Infinity, maxHash = -Infinity;
for (const fp of fingerprints) {
	if (!Number.isInteger(fp.hash) || fp.hash < 0 || fp.hash >= 2 ** 40) fail({ check: "hash", fingerprint: fp });
	minHash = Math.min(minHash, fp.hash);
	maxHash = Math.max(maxHash, fp.hash);
}

// Each time_index is an integer and non-decreasing in list order.
let prevTimeIndex = -Infinity;
for (const fp of fingerprints) {
	if (!Number.isInteger(fp.time_index)) fail({ check: "time_index not int", fingerprint: fp });
	if (fp.time_index < prevTimeIndex) fail({ check: "time_index decreasing", previous: prevTimeIndex, current: fp.time_index });
	prevTimeIndex = fp.time_index;
}

// No time_index from the future relative to the last processed block.
const maxTimeIndex = fingerprints.reduce((m, fp) => Math.max(m, fp.time_index), -Infinity);
if (maxTimeIndex > runA.finalBlockIndex) fail({ check: "time_index beyond final block", maxTimeIndex, finalBlockIndex: runA.finalBlockIndex });

// Determinism: the two independent runs produce bit-for-bit identical lists.
const deterministic = JSON.stringify(fingerprints) === JSON.stringify(runB.fingerprints);
if (!deterministic) fail({ check: "not deterministic" });

console.log(`fingerprints: ${fingerprints.length}, stepSize: ${grid.stepSize}, hash range: [${minHash}, ${maxHash}], deterministic: true`);
process.exit(0);
