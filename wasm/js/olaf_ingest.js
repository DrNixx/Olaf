// Browser-side ingest probe: capture the microphone, run Olaf through the
// existing worklet with visualisation on, and ship the event points Olaf
// extracts to an external matching server. The current olaf.wasm exposes no
// fingerprint/hash extractor, so event points are the richest payload it can
// emit (see olaf_wasm.js callbacks).
import { createOlafNode } from "./olaf.js";

// Voice processing distorts the spectral peaks Olaf fingerprints: switch it off
const MIC_CONSTRAINTS = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false };

export async function startIngest({ endpoint, batchSize = 64, flushMs = 1000, onStatus = () => {} }) {
	const context = new AudioContext();
	const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS, video: false });
	const node = await createOlafNode(context, { visualize: true });
	context.createMediaStreamSource(stream).connect(node);

	const sessionId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());
	const stats = { sessionId, grid: null, sent: 0, batches: 0, errors: 0 };
	let pending = [];
	let sending = false;

	async function flush() {
		if (sending || pending.length === 0) return;
		const eventPoints = pending;
		pending = [];
		sending = true;
		try {
			const response = await fetch(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ type: "event_points", sessionId, grid: stats.grid, eventPoints }),
			});
			stats.sent += eventPoints.length;
			stats.batches++;
			onStatus("sent batch of " + eventPoints.length + " event points: HTTP " + response.status);
		} catch (err) {
			stats.errors++;
			onStatus("send failed: " + err);
		} finally {
			sending = false;
		}
	}

	node.port.onmessage = (event) => {
		const data = event.data;
		if (data.type === "status") {
			onStatus("[worklet] " + (data.error || data.message));
		} else if (data.type === "grid") {
			stats.grid = data;
		} else if (data.type === "spectrum") {
			for (const ep of data.eventPoints) pending.push(ep);
			if (pending.length >= batchSize) flush();
		}
	};

	const flushTimer = setInterval(flush, flushMs);

	return {
		stats,
		async stop() {
			clearInterval(flushTimer);
			await flush();
			stream.getTracks().forEach((track) => track.stop());
			await context.close();
		},
	};
}
