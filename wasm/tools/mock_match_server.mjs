// Minimal no-dependency receiver for the Olaf ingest probe: logs event point
// batches posted to /match and answers 200 so the browser fetch resolves.
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8787);

const server = createServer((req, res) => {
	const headers = {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
	};
	if (req.method === "OPTIONS") {
		res.writeHead(204, headers);
		res.end();
		return;
	}
	if (req.method !== "POST" || !req.url.startsWith("/match")) {
		res.writeHead(404, headers);
		res.end("not found");
		return;
	}
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		let summary = "unparsable body";
		try {
			const data = JSON.parse(body);
			const count = Array.isArray(data.eventPoints) ? data.eventPoints.length : 0;
			summary = "session " + data.sessionId + ": " + count + " event points, " + body.length + " bytes";
			console.log(count > 0 ? summary + " | first " + JSON.stringify(data.eventPoints[0]) : summary);
		} catch (err) {
			console.log("bad payload: " + err.message);
		}
		res.writeHead(200, { ...headers, "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true, received: summary }));
	});
});

server.listen(port, () => console.log("mock match server on http://localhost:" + port + "/match"));
