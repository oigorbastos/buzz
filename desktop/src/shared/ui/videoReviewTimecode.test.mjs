import assert from "node:assert/strict";
import test from "node:test";

import { parseVideoReviewTimecode } from "./videoReviewTimecode.ts";

test("parseVideoReviewTimecode extracts supported leading timecodes", () => {
  assert.deepEqual(parseVideoReviewTimecode("[00:10.7] Tighten **this** cut"), {
    seconds: 10.7,
    sourceLineOffset: 0,
    text: "Tighten **this** cut",
    timecode: "00:10.7",
  });
  assert.deepEqual(parseVideoReviewTimecode("[1:02:03] Long-form note"), {
    seconds: 3723,
    sourceLineOffset: 0,
    text: "Long-form note",
    timecode: "1:02:03",
  });
});

test("parseVideoReviewTimecode reports source lines removed before markdown", () => {
  assert.deepEqual(parseVideoReviewTimecode("[00:10]\n\n- [ ] review cut"), {
    seconds: 10,
    sourceLineOffset: 2,
    text: "- [ ] review cut",
    timecode: "00:10",
  });
});

test("parseVideoReviewTimecode ignores ordinary bracketed markdown", () => {
  assert.equal(parseVideoReviewTimecode("[docs](https://example.com)"), null);
  assert.equal(parseVideoReviewTimecode("Comment at [00:10]"), null);
});
