// Unit test for extractMatches (js/olaf_ingest.js): the client must read the
// matches out of every response shape the endpoint may answer with, and never
// throw on junk.
import { extractMatches } from "./js/olaf_ingest.js";

let cases = 0;
function fail(name, detail) {
	console.error("FAIL", name, JSON.stringify(detail));
	process.exit(1);
}
function ok(name, condition, detail) {
	cases++;
	if (!condition) fail(name, detail);
}

// The olaf rest envelope: the same match is in summary.matches and in
// results[].data.queries[].matches.
const envelope = {
	results: [{ endpoint: "local", data: { queries: [{ query_offset: 0, matches: [{ match_count: 417, path: "clip", match_identifier: 1790764217, reference_start: 1.5, reference_stop: 11.5 }] }] } }],
	summary: { match_count: 1, matches: [{ endpoint: "local", query_offset: 0, match_count: 417, path: "clip", match_identifier: 1790764217 }] },
};
const fromEnvelope = extractMatches(envelope);
ok("envelope finds the match", fromEnvelope.length > 0 && fromEnvelope.every((m) => m.id === 1790764217 && m.match_count === 417), fromEnvelope);
ok("envelope keeps reference times", fromEnvelope.some((m) => m.reference_start === 1.5 && m.reference_stop === 11.5), fromEnvelope);

const flat = extractMatches({ matches: [{ match_id: 42, match_count: 7 }] });
ok("flat matches + match_id", flat.length === 1 && flat[0].id === 42 && flat[0].match_count === 7, flat);

const flatQueries = extractMatches({ queries: [{ matches: [{ match_identifier: 5, match_count: 3 }] }] });
ok("flat queries", flatQueries.length === 1 && flatQueries[0].id === 5, flatQueries);

ok("null -> []", extractMatches(null).length === 0, null);
ok("{} -> []", extractMatches({}).length === 0, null);
ok("garbage matches -> []", extractMatches({ matches: "x" }).length === 0, null);
ok("entry without id is skipped", extractMatches({ matches: [{ match_count: 9 }] }).length === 0, null);

console.log("olaf_ingest_match_test: PASS (" + cases + " cases)");
