import assert from "node:assert/strict";
import { describe, it } from "node:test";

import remarkLabLinks from "./remarkLabLinks.ts";

// `remark-gfm`'s autolinker only covers http(s)://, so bare `buzz://lab`
// URLs in plain text never reach any rendering path without this plugin.
// The plugin emits a custom `lab-link` HAST element which markdown.tsx
// renders as an inline pill. Tests operate on the mdast tree directly —
// mirrors markdown.test.mjs's remarkMessageLinks coverage.

const BOARD = "0f2b8a1c-1111-4222-8333-444455556666";

function runPlugin(tree) {
  remarkLabLinks()(tree);
  return tree;
}

function paragraph(...children) {
  return { type: "root", children: [{ type: "paragraph", children }] };
}

function text(value) {
  return { type: "text", value };
}

describe("remarkLabLinks", () => {
  it("replaces a bare buzz://lab URL", () => {
    const tree = runPlugin(paragraph(text(`buzz://lab?board=${BOARD}`)));
    const para = tree.children[0];
    assert.equal(para.children.length, 1);
    assert.equal(para.children[0].type, "lab-link");
    assert.equal(para.children[0].value, `buzz://lab?board=${BOARD}`);
    assert.equal(para.children[0].data.hName, "lab-link");
  });

  it("replaces a bare buzz://lab URL with a revision", () => {
    const value = `buzz://lab?board=${BOARD}&revision=7`;
    const tree = runPlugin(paragraph(text(value)));
    const para = tree.children[0];
    assert.equal(para.children[0].type, "lab-link");
    assert.equal(para.children[0].value, value);
  });

  it("mid-sentence URL splits surrounding text", () => {
    const tree = runPlugin(
      paragraph(text(`see buzz://lab?board=${BOARD} here`)),
    );
    const kids = tree.children[0].children;
    assert.equal(kids.length, 3);
    assert.equal(kids[0].type, "text");
    assert.equal(kids[0].value, "see ");
    assert.equal(kids[1].type, "lab-link");
    assert.equal(kids[2].type, "text");
    assert.equal(kids[2].value, " here");
  });

  it("two URLs in one text node are both replaced", () => {
    const tree = runPlugin(
      paragraph(
        text(
          `first buzz://lab?board=${BOARD}&revision=1 then buzz://lab?board=${BOARD}&revision=2 done`,
        ),
      ),
    );
    const kids = tree.children[0].children;
    const links = kids.filter((c) => c.type === "lab-link");
    assert.equal(links.length, 2);
    assert.equal(links[0].value, `buzz://lab?board=${BOARD}&revision=1`);
    assert.equal(links[1].value, `buzz://lab?board=${BOARD}&revision=2`);
  });

  it("trailing sentence punctuation stays outside the link", () => {
    for (const punctuation of [".", ",", ";", ":", "!", "?"]) {
      const tree = runPlugin(
        paragraph(text(`see buzz://lab?board=${BOARD}${punctuation}`)),
      );
      const kids = tree.children[0].children;

      assert.equal(kids.length, 3, punctuation);
      assert.equal(kids[0].value, "see ", punctuation);
      assert.equal(kids[1].type, "lab-link", punctuation);
      assert.equal(kids[1].value, `buzz://lab?board=${BOARD}`, punctuation);
      assert.equal(kids[2].type, "text", punctuation);
      assert.equal(kids[2].value, punctuation, punctuation);
    }
  });

  it("URL inside parens keeps the closing paren outside", () => {
    const tree = runPlugin(
      paragraph(text(`see (buzz://lab?board=${BOARD}) for details`)),
    );
    const kids = tree.children[0].children;

    assert.equal(kids.length, 3);
    assert.equal(kids[0].value, "see (");
    assert.equal(kids[1].type, "lab-link");
    assert.equal(kids[1].value, `buzz://lab?board=${BOARD}`);
    assert.equal(kids[2].type, "text");
    assert.equal(kids[2].value, ") for details");
  });

  it("non-lab buzz:// URLs are not matched", () => {
    const original = `buzz://message?channel=c&id=${BOARD}`;
    const tree = runPlugin(paragraph(text(original)));
    const kids = tree.children[0].children;
    assert.equal(kids.length, 1);
    assert.equal(kids[0].type, "text");
    assert.equal(kids[0].value, original);
  });

  it("text inside inlineCode is left alone", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "inlineCode", value: `buzz://lab?board=${BOARD}` },
          ],
        },
      ],
    };
    runPlugin(tree);
    const code = tree.children[0].children[0];
    assert.equal(code.type, "inlineCode");
    assert.equal(code.value, `buzz://lab?board=${BOARD}`);
  });
});
