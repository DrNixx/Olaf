// Browser-side ingest: capture the microphone, run Olaf through the worklet
// with the server profile, and ship extracted fingerprints (t1, hash) to the
// external matching server in sliding windows.
import { createOlafNode } from "./olaf.js";
import { createWindowBuffer } from "./olaf_windows.js";

// Voice processing distorts the spectral peaks Olaf fingerprints: switch it off
const MIC_CONSTRAINTS = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false };

// Used before the worklet reports its grid
const FALLBACK_GRID = { sampleRate: 16000, stepSize: 128 };

// Collects the matches from any of the response shapes the endpoint may use:
// the olaf rest envelope (summary.matches plus results[].data.queries[].matches)
// or a flat { matches | queries } object. Entries without a usable id are
// skipped. The same match may appear twice (summary and results); callers only
// read the best match_count, so that is harmless.
export function extractMatches(data) {
	const out = [];
	const push = (match) => {
		if (!match || typeof match !== "object") return;
		const raw = match.match_identifier ?? match.match_id;
		if (raw == null) return;
		const id = Number(raw);
		if (!Number.isFinite(id)) return;
		out.push({
			id,
			match_count: Number(match.match_count ?? 0),
			path: match.path == null ? "" : String(match.path),
			query_offset: Number(match.query_offset ?? 0),
			reference_start: Number(match.reference_start ?? 0),
			reference_stop: Number(match.reference_stop ?? 0),
		});
	};
	if (!data || typeof data !== "object") return out;
	if (data.summary && Array.isArray(data.summary.matches)) for (const match of data.summary.matches) push(match);
	if (Array.isArray(data.results)) {
		for (const result of data.results) {
			const queries = result && result.data && Array.isArray(result.data.queries) ? result.data.queries : [];
			for (const query of queries) if (Array.isArray(query.matches)) for (const match of query.matches) push(match);
		}
	}
	if (Array.isArray(data.matches)) for (const match of data.matches) push(match);
	if (Array.isArray(data.queries)) for (const query of data.queries) if (Array.isArray(query.matches)) for (const match of query.matches) push(match);
	return out;
}

// The best match of a window: the one with the highest match_count.
function bestMatch(matches) {
	return matches.reduce((best, match) => (best == null || match.match_count > best.match_count ? match : best), null);
}

export async function startIngest({ endpoint, windowSeconds = 10, hopSeconds = 5, onStatus = () => {} }) {
	const context = new AudioContext();
	const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS, video: false });
	const node = await createOlafNode(context, { profile: "server" });
	context.createMediaStreamSource(stream).connect(node);

	const sessionId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());
	const stats = { sessionId, grid: null, sent: 0, windows: 0, errors: 0, matches: 0, lastMatch: null, lastResponse: null };

	let buffer = null;
	const queue = [];
	let pumping = false;

	function ensureBuffer() {
		if (buffer != null) return;
		const grid = stats.grid ?? FALLBACK_GRID;
		const blocksPerSecond = grid.sampleRate / grid.stepSize;
		buffer = createWindowBuffer(
			Math.max(1, Math.round(windowSeconds * blocksPerSecond)),
			Math.max(1, Math.round(hopSeconds * blocksPerSecond)),
		);
	}

	async function send(window) {
		const fingerprints = window.fingerprints.map((fp) => ({ t1: fp.time_index, hash: fp.hash }));
		try {
			const response = await fetch(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ type: "fingerprints", sessionId, grid: stats.grid, wallClockMs: Date.now(), fingerprints }),
			});
			stats.sent += fingerprints.length;
			stats.windows++;
			const text = await response.text();
			stats.lastResponse = text.length > 2000 ? text.slice(0, 2000) + "…" : text;
			let data = null;
			try { data = text ? JSON.parse(text) : null; } catch { data = null; }
			const matches = extractMatches(data);
			stats.matches += matches.length;
			if (!response.ok) {
				stats.errors++;
				onStatus("window @" + window.startBlock + ": " + fingerprints.length + " fingerprints, HTTP " + response.status + (stats.lastResponse ? ": " + stats.lastResponse : ""));
				return;
			}
			if (matches.length === 0) {
				onStatus("window @" + window.startBlock + ": " + fingerprints.length + " fingerprints, HTTP " + response.status + ", no matches");
				return;
			}
			const best = bestMatch(matches);
			stats.lastMatch = { ...best, at: Date.now(), windowStart: window.startBlock };
			onStatus("window @" + window.startBlock + ": " + fingerprints.length + " fingerprints, HTTP " + response.status + ", " + matches.length + " match(es), best " + best.id + " (count " + best.match_count + ", ref " + best.reference_start + "-" + best.reference_stop + "s)");
		} catch (err) {
			stats.errors++;
			onStatus("send failed: " + err);
		}
	}

	// One POST at a time, in window order.
	async function pump() {
		if (pumping) return;
		pumping = true;
		while (queue.length > 0) await send(queue.shift());
		pumping = false;
	}

	node.port.onmessage = (event) => {
		const data = event.data;
		if (data.type === "status") {
			onStatus("[worklet] " + (data.error || data.message));
		} else if (data.type === "grid") {
			stats.grid = data;
		} else if (data.type === "fingerprints") {
			ensureBuffer();
			for (const window of buffer.push(data.fingerprints)) queue.push(window);
			pump();
		}
	};

	return {
		stats,
		async stop() {
			stream.getTracks().forEach((track) => track.stop());
			await context.close();
		},
	};
}
