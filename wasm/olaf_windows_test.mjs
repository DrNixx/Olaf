// Unit test for the pure windowing module (js/olaf_windows.js): it must split a
// stream of fingerprints into overlapping, self-contained windows on Olaf's time grid.
// No wasm, no DOM — just createWindowBuffer and its push(). On failure: FAIL + exit 1;
// at the end prints "olaf_windows_test: PASS (N windows)" and exits 0.
import { createWindowBuffer } from "./js/olaf_windows.js";

function fail(detail) { console.error("FAIL", JSON.stringify({ ...detail })); process.exit(1); }

const fps = (from, toInclusive) => Array.from({ length: toInclusive - from + 1 }, (_, i) => ({ time_index: from + i, hash: from + i }));
// Normalizes a window list for comparison by startBlock and the contiguous range it covers.
function norm(windows) { return windows.map((w) => [w.startBlock, w.fingerprints.length]); }

let totalWindows = 0; // number of windows produced across all successful scenarios below.

// --- Overlapping case: windowBlocks=10, hopBlocks=5 -------------------------
{
	const buffer = createWindowBuffer(10, 5);
	// Feed time_index 0..24 (hash == time_index) in one shot; expect starts [0,5,10].
	let windows = buffer.push(fps(0, 24));

	if (!Array.isArray(windows) || JSON.stringify(norm(windows)) !== JSON.stringify([[0,10],[5,10],[10,10]])) {
		fail({ check: "first push starts/counts", windows });
	}
	const byStart = Object.fromEntries(windows.map((w) => [w.startBlock, w]));

	if (byStart[0].fingerprints.length !== 10 || byStart[0].fingerprints.some((fp) => fp.time_index < 0 || fp.time_index > 9)) {
		fail({ check: "window start=0 range", window: byStart[0] });
	}
	if (byStart[5].fingerprints.length !== 10 || byStart[5].fingerprints.some((fp) => fp.time_index < 5 || fp.time_index > 14)) {
		fail({ check: "window start=5 range", window: byStart[5] });
	}
	if (byStart[10].fingerprints.length !== 10 || byStart[10].fingerprints.some((fp) => fp.time_index < 10 || fp.time_index > 19)) {
		fail({ check: "window start=10 range", window: byStart[10] });
	}

	// Overlap: the hop-5 window covers time_index 5..14, intersecting window 0 (which is 0..9) on 5..9.
	const inWindowZero = new Set(byStart[0].fingerprints.map((fp) => fp.time_index));
	for (const t of [5,6,7,8,9]) if (!inWindowZero.has(t)) fail({ check: "window start=5 overlaps window 0", timeIndex: t });

	// Feed the next stretch; windows with starts 15 and 20 must appear.
	windows = buffer.push(fps(25, 34));
	if (!Array.isArray(windows) || JSON.stringify(norm(windows)) !== JSON.stringify([[15,10],[20,10]])) {
		fail({ check: "second push starts/counts", windows });
	}

	totalWindows += 6; // three from each of the two pushes above (3 + 3).
}

// --- Monotonic startBlocks across a single continuous stream -----------------
{
	const buffer = createWindowBuffer(10, 5);
	let starts = [];
	for (const chunk of [fps(0,9), fps(10,24)]) for (const w of buffer.push(chunk)) { starts.push(w.startBlock); totalWindows++; }
	if (!starts.every((s, i) => i === 0 || s > starts[i - 1])) fail({ check: "startBlocks monotonic", starts });

	// --- No overlap when hop == window ---------------------------------------
	const noOverlap = createWindowBuffer(10, 10);
	let windows = [];
	for (const chunk of [fps(0,9), fps(10,24)]) for (const w of noOverlap.push(chunk)) { windows.push(w); totalWindows++; }
	if (!windows.every((w) => w.fingerprints.length === 10)) fail({ check: "hop==window window size", windows });
	// Consecutive non-overlapping windows must not share any time_index.
	const seen = new Set();
	for (const w of [...windows].sort((a, b) => a.startBlock - b.startBlock)) {
		for (const fp of w.fingerprints) if (seen.has(fp.time_index)) fail({ check: "hop==window overlap", timeIndex: fp.time_index }); else seen.add(fp.time_index);
	}
}

// --- Invalid parameters throw -------------------------------------------------
for (const [wb, hb] of [[0,5],[10,-1],[-3,4],[5,8]]) { // 0 / negative / hop>window all rejected.
	let threw = false;
	try { createWindowBuffer(wb, hb); } catch { threw = true; }
	if (!threw) fail({ check: "invalid params should throw", windowBlocks: wb, hopBlocks: hb });
}

// --- Chunking invariance ------------------------------------------------------
{
	// Same stream fed as one array vs several chunks must give the identical set of windows.
	const single = createWindowBuffer(10, 5).push(fps(0,24));

	let splitOut = [];
	const splitBuf = createWindowBuffer(10, 5);
	for (const chunk of [fps(0,9), fps(10,24)]) for (const w of splitBuf.push(chunk)) { splitOut.push(w); totalWindows++; }
	if (!Array.isArray(splitOut) || JSON.stringify(norm(single).sort((a,b)=>a[0]-b[0])) !== JSON.stringify(norm(splitOut).sort((a,b)=>a[0]-b[0]))) fail({ check: "chunking invariance", single, splitOut });
}

console.log(`olaf_windows_test: PASS (${totalWindows} windows)`);