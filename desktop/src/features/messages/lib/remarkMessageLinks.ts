/**
 * Remark plugin that detects bare `buzz://message?…` URLs in text nodes and
 * replaces each with a custom `message-link` HAST element. Legacy
 * `buzz://message?…` URLs are accepted during the rename. The `markdown.tsx`
 * components map renders that as an inline pill (channel name + click-to-open)
 * instead of the raw 100-char URL.
 *
 * Why this plugin exists: `remark-gfm`'s autolinker only covers `http(s)://`
 * and `www.`. Custom schemes like `buzz://` only reach the `<a>` component
 * override when the user wrote an explicit `[label](buzz://…)` link.
 *
 * Mirrors `remarkChannelLinks` / `remarkMentions` — same factory, same HAST
 * shape — so the rendering layer treats all three uniformly. Trailing
 * sentence punctuation (`. , ; : ! ?`) and unmatched closing brackets are
 * peeled off the match and emitted as plain text after the pill, so a URL
 * pasted at end-of-sentence still routes to the correct message id.
 */
// Explicit `.ts` extension lets this plugin be imported both by the Vite-built
// `markdown.tsx` and by `markdown.test.mjs` running under `node --test
// --experimental-strip-types`. `tsconfig.json` enables `allowImportingTsExtensions`.
import { createRemarkPrefixPlugin } from "../../../shared/lib/createRemarkPrefixPlugin.ts";
import { trimTrailingUrlPunctuation } from "../../../shared/lib/urlMatchTrim.ts";

const MESSAGE_URL_PATTERN = /(?:buzz|buzz):\/\/message\?[^\s<>"')\]]+/g;

export default function remarkMessageLinks() {
  return createRemarkPrefixPlugin(MESSAGE_URL_PATTERN, (matchText) => {
    const { value, trailing } = trimTrailingUrlPunctuation(matchText);

    return {
      node: {
        type: "message-link",
        value,
        data: {
          hName: "message-link",
          hChildren: [{ type: "text", value }],
        },
      },
      trailing,
    };
  });
}
