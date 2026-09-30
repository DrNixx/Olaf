// Browser-side ingest: capture the microphone, run Olaf through the worklet
// with the server profile, and ship extracted fingerprints (t1, hash) to the
// external matching server in sliding windows.
import { createOlafNode } from "./olaf.js";
import { createWindowBuffer } from "./olaf_windows.js";

// Voice processing distorts the spectral peaks Olaf fingerprints: switch it off
const MIC_CONSTRAINTS = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false };

// Used before the worklet reports its grid
const FALLBACK_GRID = { sampleRate: 16000, stepSize: 128 };

export async function startIngest({ endpoint, windowSeconds = 10, hopSeconds = 5, onStatus = () => {} }) {
	const context = new AudioContext();
	const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS, video: false });
	const node = await createOlafNode(context, { profile: "server" });
	context.createMediaStreamSource(stream).connect(node);

	const sessionId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());
	const stats = { sessionId, grid: null, sent: 0, windows: 0, errors: 0 };

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
			onStatus("window @" + window.startBlock + ": " + fingerprints.length + " fingerprints, HTTP " + response.status);
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
