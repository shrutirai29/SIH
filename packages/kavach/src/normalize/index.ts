/**
 * Text normalisation. Runs before every detector.
 *
 * This is where naive implementations leak: `<span>1234</span><span>5678</span>`
 * defeats a digit regex, a zero-width space between digits defeats it, and a Cyrillic
 * A defeats a letter class. Normalising first is not a nicety - it is most of the
 * real-world recall (PIPELINE.md sec 5.1).
 *
 * The offset map lets the redactor apply a substitution back onto the ORIGINAL string,
 * which is required because we redact the DOM value, not the normalised copy.
 */

/** Zero-width and formatting characters that must not break a pattern. */
const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff\u00ad]/;

/**
 * Confusable folding table (Latin targets). Deliberately small and explicit rather
 * than pulling the full Unicode confusables set: every entry here is one an attacker
 * would actually reach for, and a wrong fold is a false negative.
 */
const CONFUSABLES = new Map<string, string>([
  // Cyrillic -> Latin
  ['\u0410', 'A'], ['\u0412', 'B'], ['\u0415', 'E'], ['\u041a', 'K'], ['\u041c', 'M'],
  ['\u041d', 'H'], ['\u041e', 'O'], ['\u0420', 'P'], ['\u0421', 'C'], ['\u0422', 'T'],
  ['\u0423', 'Y'], ['\u0425', 'X'],
  ['\u0430', 'a'], ['\u0435', 'e'], ['\u043e', 'o'], ['\u0440', 'p'], ['\u0441', 'c'],
  ['\u0443', 'y'], ['\u0445', 'x'],
  // Greek -> Latin
  ['\u0391', 'A'], ['\u0392', 'B'], ['\u0395', 'E'], ['\u0397', 'H'], ['\u0399', 'I'],
  ['\u039a', 'K'], ['\u039c', 'M'], ['\u039d', 'N'], ['\u039f', 'O'], ['\u03a1', 'P'],
  ['\u03a4', 'T'], ['\u03a7', 'X'], ['\u03bf', 'o'],
  // Fullwidth digits -> ASCII
  ['\uff10', '0'], ['\uff11', '1'], ['\uff12', '2'], ['\uff13', '3'], ['\uff14', '4'],
  ['\uff15', '5'], ['\uff16', '6'], ['\uff17', '7'], ['\uff18', '8'], ['\uff19', '9'],
]);

export interface Normalized {
  /** The normalised text every detector should match against. */
  readonly text: string;
  /**
   * `map[i]` is the index in the ORIGINAL string that produced `text[i]`.
   * Length is always `text.length`.
   */
  readonly map: readonly number[];
}

/**
 * NFKC-normalises, drops invisible characters, and folds confusables, while keeping
 * an index back to the original for every surviving character.
 */
export function normalize(input: string): Normalized {
  const chars: string[] = [];
  const map: number[] = [];

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === undefined) continue;
    if (INVISIBLE_RE.test(ch)) continue;

    const folded = CONFUSABLES.get(ch) ?? ch.normalize('NFKC');
    // NFKC can expand one character into several; every expanded character maps back
    // to the single original index, which is what the redactor needs.
    for (const out of folded) {
      chars.push(out);
      map.push(i);
    }
  }

  return { text: chars.join(''), map };
}

/**
 * Collapses separators inside digit runs so `1234 5678 9012` and `1234-5678-9012`
 * both reach the Aadhaar pattern. Returns the compacted text plus its offset map,
 * composed with an incoming map when the caller has already normalised.
 */
export function compactDigitGroups(n: Normalized): Normalized {
  const chars: string[] = [];
  const map: number[] = [];

  for (let i = 0; i < n.text.length; i++) {
    const ch = n.text[i];
    const src = n.map[i];
    if (ch === undefined || src === undefined) continue;

    if (ch === ' ' || ch === '-') {
      const prev = n.text[i - 1];
      const next = n.text[i + 1];
      const betweenDigits =
        prev !== undefined && next !== undefined && prev >= '0' && prev <= '9' && next >= '0' && next <= '9';
      if (betweenDigits) continue;
    }
    chars.push(ch);
    map.push(src);
  }

  return { text: chars.join(''), map };
}

/**
 * Joins the text of adjacent inline nodes into one string with a map back to
 * `{nodeIndex, offset}`, so a value split across `<span>`s is detectable.
 */
export interface JoinedNodes {
  readonly text: string;
  readonly owner: readonly { readonly node: number; readonly offset: number }[];
}

export function joinInlineNodes(parts: readonly string[]): JoinedNodes {
  const chars: string[] = [];
  const owner: { node: number; offset: number }[] = [];
  for (let n = 0; n < parts.length; n++) {
    const part = parts[n];
    if (part === undefined) continue;
    for (let o = 0; o < part.length; o++) {
      const ch = part[o];
      if (ch === undefined) continue;
      chars.push(ch);
      owner.push({ node: n, offset: o });
    }
  }
  return { text: chars.join(''), owner };
}

/** Convenience: full normalisation pipeline used by the detectors. */
export function normalizeForDetection(input: string): Normalized {
  return compactDigitGroups(normalize(input));
}
