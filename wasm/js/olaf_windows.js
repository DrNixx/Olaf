// Splits a stream of fingerprints ({time_index, hash}) into overlapping,
// self-contained windows on Olaf's time grid: a window covers windowBlocks and
// the next starts hopBlocks later, so windows overlap when hopBlocks <
// windowBlocks. Pure: no DOM, no timers.
export function createWindowBuffer(windowBlocks, hopBlocks) {
	if (!(windowBlocks > 0) || !(hopBlocks > 0) || hopBlocks > windowBlocks) {
		throw new Error("invalid window/hop: " + windowBlocks + "/" + hopBlocks);
	}
	let pending = [];
	let windowStart = null;
	return {
		// Adds fingerprints and returns the windows that are now complete, each
		// { startBlock, fingerprints }.
		push(fingerprints) {
			for (const fp of fingerprints) pending.push(fp);
			const windows = [];
			if (pending.length === 0) return windows;
			if (windowStart === null) windowStart = pending[0].time_index;
			while (pending[pending.length - 1].time_index >= windowStart + windowBlocks) {
				const window = pending.filter((fp) => fp.time_index < windowStart + windowBlocks);
				if (window.length > 0) windows.push({ startBlock: windowStart, fingerprints: window });
				windowStart += hopBlocks;
				pending = pending.filter((fp) => fp.time_index >= windowStart);
				if (pending.length === 0) { windowStart = null; break; }
			}
			return windows;
		},
	};
}
