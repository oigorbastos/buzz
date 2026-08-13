/**
 * Remark plugin that detects bare `buzz://lab?board=…` URLs in text nodes and
 * replaces each with a custom `lab-link` HAST element. The `markdown.tsx`
 * components map renders that as an inline pill instead of the raw URL.
 *
 * Why this plugin exists: `remark-gfm`'s autolinker only covers `http(s)://`
 * and `www.`. Custom schemes like `buzz://` only reach the `<a>` component
 * override when the user wrote an explicit `[label](buzz://…)` link — a
 * *bare* pasted `buzz://lab?board=…` URL would otherwise render as plain,
 * unclickable text.
 *
 * Mirrors `remarkMessageLinks` (`buzz://message`) — same factory, same HAST
 * shape, same trailing-punctuation trim — so the rendering layer treats every
 * `buzz://` deep-link kind uniformly.
 */
// Explicit `.ts` extension: this plugin (like remarkMessageLinks.ts) is
// imported directly by markdown.test.mjs under `node --experimental-strip-types`,
// which requires explicit extensions on relative ESM imports.
import { createRemarkPrefixPlugin } from "../../../shared/lib/createRemarkPrefixPlugin.ts";
import { trimTrailingUrlPunctuation } from "../../../shared/lib/urlMatchTrim.ts";

const LAB_URL_PATTERN = /buzz:\/\/lab\?[^\s<>"')\]]+/g;

export default function remarkLabLinks() {
  return createRemarkPrefixPlugin(LAB_URL_PATTERN, (matchText) => {
    const { value, trailing } = trimTrailingUrlPunctuation(matchText);

    return {
      node: {
        type: "lab-link",
        value,
        data: {
          hName: "lab-link",
          hChildren: [{ type: "text", value }],
        },
      },
      trailing,
    };
  });
}
