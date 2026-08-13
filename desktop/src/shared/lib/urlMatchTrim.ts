/**
 * Trailing-punctuation trimming shared by the `buzz://` bare-URL remark
 * plugins (`remarkMessageLinks`, `remarkLabLinks`).
 *
 * A bare deep link pasted at the end of a sentence ("see buzz://lab?board=…,
 * thanks") should not swallow the following punctuation into the link — this
 * peels trailing sentence punctuation (`. , ; : ! ?`) and any unmatched
 * closing bracket/paren off the regex match, emitting them as plain text
 * immediately after the link node instead.
 */

const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?]+$/;

function isUnmatchedClosing(value: string): boolean {
  const closing = value[value.length - 1];
  const opening = closing === ")" ? "(" : "[";
  return value.split(closing).length > value.split(opening).length;
}

/**
 * Split a raw regex match into the part that belongs to the link and the
 * trailing text (punctuation / unmatched closing bracket) that does not.
 */
export function trimTrailingUrlPunctuation(matchText: string): {
  value: string;
  trailing: string;
} {
  let value = matchText.replace(TRAILING_PUNCTUATION_PATTERN, "");
  while (/[)\]]$/.test(value) && isUnmatchedClosing(value)) {
    value = value.slice(0, -1).replace(TRAILING_PUNCTUATION_PATTERN, "");
  }
  return { value, trailing: matchText.slice(value.length) };
}
