class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParseError';
  }
}

const MINOR_WORDS = new Set(['a','an','the','and','but','or','for','nor','on','at','to','by','in','of','up','as','is','it']);

// 274k-word English dictionary (includes inflected forms like "has", "loves")
const _wordSet = new Set(require('an-array-of-english-words'));

function isEnglishWord(s) {
  return _wordSet.has(s.toLowerCase());
}

function toTitleCase(str) {
  return str.toLowerCase().split(' ').map((word, i) => {
    if (!word) return word;
    if (i !== 0 && MINOR_WORDS.has(word)) return word;
    return word[0].toUpperCase() + word.slice(1);
  }).join(' ');
}

function parseFirstLine(line) {
  // Match "PREFIX) Title" or "68. Title" (number followed by dot)
  const parenIdx = line.indexOf(')');
  const dotMatch = line.match(/^(\d+)\.\s+(.+)/);

  if (parenIdx === -1 && !dotMatch) {
    const trimmed = line.trim();
    // Bare number with no title text → hymn number prefix, no inline English title
    if (/^\d+$/.test(trimmed)) return { prefix: trimmed, englishTitle: null };
    const title = cleanTitle(toTitleCase(trimmed));
    // No prefix marker — only treat as title if short enough and has at least one letter
    if (title.length > 60 || !/[A-Za-z\uAC00-\uD7A3]/.test(title)) return { prefix: null, englishTitle: null };
    return { prefix: null, englishTitle: title };
  }

  let prefix, titleRaw;

  if (dotMatch && (parenIdx === -1 || dotMatch.index < parenIdx)) {
    prefix = dotMatch[1];
    titleRaw = dotMatch[2].trim();
  } else {
    prefix = line.slice(0, parenIdx).trim();
    titleRaw = line.slice(parenIdx + 1).trim();
  }

  if (!prefix || !titleRaw) return { prefix: null, englishTitle: cleanTitle(toTitleCase(line.trim())) };

  const englishTitle = cleanTitle(toTitleCase(titleRaw));
  return { prefix, englishTitle };
}

function cleanTitle(title) {
  return title
    .replace(/#\S*/g, '')          // remove hashtags
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '') // remove emoji (supplementary plane)
    .replace(/[\u2600-\u27BF]/g, '') // remove misc symbols & dingbats
    .replace(/[\uFE00-\uFE0F]/g, '') // remove variation selectors
    .trim();
}

function isKoreanTitle(line) {
  // Must contain at least one Hangul syllable block
  return /[\uAC00-\uD7A3]/.test(line);
}

function cleanLyricsLine(line) {
  // Split on every |, /, \ (consuming surrounding spaces) then decide per boundary
  const segments = line.split(/\s*[|/\\]\s*/);

  if (segments.length > 1) {
    const result = [segments[0]];
    for (let i = 1; i < segments.length; i++) {
      const prev = result[result.length - 1];
      const curr = segments[i];
      // Compare the token that straddles the | boundary
      const prevWord = (prev.match(/([A-Za-z]+)\s*$/) || [])[1] || '';
      const currWord = (curr.match(/^\s*([A-Za-z]+)/) || [])[1] || '';

      // Join if at least one token is not a real English word (it's a syllable fragment)
      const shouldJoin = prevWord && currWord && (!isEnglishWord(prevWord) || !isEnglishWord(currWord));
      if (shouldJoin) {
        result[result.length - 1] = prev.trimEnd() + curr.trimStart();
      } else {
        result.push(curr);
      }
    }
    line = result.join(' ');
  }

  // Handle hyphens: join syllable-break hyphens (recei-ved → received, king-dom → kingdom)
  // but keep compound-word/number hyphens (forty-four, hundred-forty-four)
  line = line.replace(/([A-Za-z]+)-([A-Za-z]+)/g, (match, left, right) => {
    return isEnglishWord(left + right) ? left + right : match;
  });

  return line
    .replace(/[_~]/g, '')
    .replace(/(?<![A-Za-z])-|-(?![A-Za-z])/g, '') // remove hyphens not between letters
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function formatLyrics(lines) {
  const result = [];
  let blankCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      blankCount++;
    } else {
      if (blankCount > 0 && result.length > 0) {
        result.push('');
      }
      blankCount = 0;

      const trimmed = cleanLyricsLine(line);
      if (!trimmed) continue;

      // Normalize verse labels: "1." "1)" "Verse 1" "Vs1." "V1" etc → "N. lyrics"
      const numDotParen = trimmed.match(/^(\d+)[.)]\s*(.*)/);
      const verseWord = trimmed.match(/^[Vv](?:erse|s)?\.?\s*(\d+)[.)\s:]*(.*)/);
      const match = numDotParen || verseWord;

      if (match) {
        const num = match[1];
        let rest = match[2].trim();

        // If no inline lyrics, grab next non-empty line
        if (!rest) {
          let j = i + 1;
          while (j < lines.length && lines[j].trim() === '') j++;
          if (j < lines.length) {
            rest = cleanLyricsLine(lines[j]);
            i = j;
          }
        }

        result.push(rest ? `${num}. ${rest}` : `${num}.`);
        continue;
      }

      result.push(trimmed);
    }
  }

  // Remove trailing blank lines
  while (result.length > 0 && result[result.length - 1] === '') {
    result.pop();
  }

  return result.join('\n');
}

function parseSongMessage(text) {
  const lines = text.split(/\r?\n/);

  let firstLine = (lines[0] || '').trim();
  let secondLine = (lines[1] || '').trim();

  // Handle Korean-first format: swap if line 0 is Korean and line 1 has the prefix
  if (isKoreanTitle(firstLine) && !isKoreanTitle(secondLine) && secondLine) {
    // If the Korean line carries a numeric prefix (e.g. "68. 시온의..."), move it to the English line
    const koreanPrefixMatch = firstLine.match(/^(\d+)[.)]\s*/);
    if (koreanPrefixMatch) {
      const strippedKorean = firstLine.slice(koreanPrefixMatch[0].length).trim();
      const englishHasPrefix = /^\S+[.)]\s/.test(secondLine);
      firstLine = englishHasPrefix ? secondLine : `${koreanPrefixMatch[1]}) ${secondLine}`;
      secondLine = strippedKorean;
    } else {
      [firstLine, secondLine] = [secondLine, firstLine];
    }
  }

  const firstLineParsed = parseFirstLine(firstLine);
  const { prefix, englishTitle } = firstLineParsed;

  // If no title AND no prefix (first line too long, no marker) treat entire message
  // as lyrics so the caller can try audio file metadata for the title.
  if (englishTitle === null && prefix === null) {
    return { prefix: null, englishTitle: null, koreanTitle: null, lyrics: formatLyrics(lines) };
  }

  // Line 1: Korean title — must contain Hangul; otherwise treat as absent
  const hasKoreanTitle = isKoreanTitle(secondLine);
  const koreanTitle = hasKoreanTitle ? cleanTitle(secondLine) : null;

  // Find body start: scan from line after Korean title (or line 1 if absent).
  // Stop at the first blank line (skip header metadata) OR the first line that
  // looks like a verse/chorus/bridge label — whichever comes first.
  const LYRICS_LABEL_RE = /^(\d+[.)]\s*|[Vv](?:erse|s)?\.?\s*\d|[Cc]horus\b|[Bb]ridge\b|[Pp]re[- ]?[Cc]horus\b|[Rr]efrain\b)/;
  const scanStart = hasKoreanTitle ? 2 : 1;
  let bodyStartIdx = -1;
  for (let i = scanStart; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l === '') {
      bodyStartIdx = i + 1;
      break;
    }
    if (LYRICS_LABEL_RE.test(l)) {
      bodyStartIdx = i;
      break;
    }
  }

  // If no separator found, body starts immediately after the header block
  if (bodyStartIdx === -1) {
    bodyStartIdx = scanStart;
  }

  const bodyLines = lines.slice(bodyStartIdx);
  const lyrics = formatLyrics(bodyLines);

  return { prefix, englishTitle, koreanTitle, lyrics };
}

function buildOutputText(prefix, englishTitle, koreanTitle, lyrics) {
  const header = prefix
    ? `${prefix}) ${englishTitle}${koreanTitle ? ` (${koreanTitle})` : ''}`
    : `${englishTitle}${koreanTitle ? ` (${koreanTitle})` : ''}`;

  const parts = [header];
  if (lyrics) {
    parts.push('');
    parts.push(lyrics);
  }
  return parts.join('\n');
}

function escapeMarkdownV2(text) {
  return text.replace(/([_*[\]()~`>#+=|{}.!\-\\])/g, '\\$1');
}

function buildCaption(prefix, englishTitle, koreanTitle) {
  let titlePart;
  if (prefix && englishTitle) {
    titlePart = `${escapeMarkdownV2(prefix)}\\) ${escapeMarkdownV2(englishTitle)}`;
  } else if (prefix) {
    titlePart = escapeMarkdownV2(prefix);
  } else {
    titlePart = escapeMarkdownV2(englishTitle || '');
  }
  const korean = koreanTitle ? ` \\(${escapeMarkdownV2(koreanTitle)}\\)` : '';
  return `🎵 *${titlePart}*${korean}`;
}

function buildLyricsMessage(lyrics) {
  if (!lyrics) return null;

  const sections = lyrics.split(/\n\n+/);
  const parts = ['· · · · · · · · · ·'];

  for (const section of sections) {
    const lines = section.split('\n').map(l => l.trimEnd()).filter(Boolean);
    if (lines.length === 0) continue;

    const first = lines[0];
    const verseMatch = first.match(/^(\d+)\.\s*(.*)/);
    const isChorus = /^[Cc]horus\b/.test(first);
    const isBridge = /^[Bb]ridge\b/.test(first);
    const isPreChorus = /^[Pp]re[- ]?[Cc]horus\b/.test(first);
    const isRefrain = /^[Rr]efrain\b/.test(first);

    parts.push('');

    if (verseMatch) {
      const num = verseMatch[1];
      const rest = verseMatch[2].trim();
      parts.push(escapeMarkdownV2(`[Verse ${num}]`));
      if (rest) parts.push(escapeMarkdownV2(rest));
      for (let i = 1; i < lines.length; i++) parts.push(escapeMarkdownV2(lines[i]));
    } else if (isChorus || isRefrain) {
      parts.push(escapeMarkdownV2('[Chorus]'));
      const content = /^(chorus|refrain)[):\s]*$/i.test(first) ? lines.slice(1) : lines;
      for (const line of content) parts.push(`_${escapeMarkdownV2(line)}_`);
    } else if (isBridge) {
      parts.push(escapeMarkdownV2('[Bridge]'));
      const content = /^bridge[):\s]*$/i.test(first) ? lines.slice(1) : lines;
      for (const line of content) parts.push(escapeMarkdownV2(line));
    } else if (isPreChorus) {
      parts.push(escapeMarkdownV2('[Pre\\-Chorus]'));
      const content = lines.slice(1);
      for (const line of content) parts.push(escapeMarkdownV2(line));
    } else {
      for (const line of lines) parts.push(escapeMarkdownV2(line));
    }
  }

  return parts.join('\n');
}

module.exports = { parseSongMessage, buildOutputText, buildCaption, buildLyricsMessage, ParseError, toTitleCase, cleanTitle };
