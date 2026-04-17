const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
// Patch dns.lookup to always resolve IPv4 — prevents hanging on broken IPv6 networks
const _originalLookup = dns.lookup.bind(dns);
dns.lookup = function(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (typeof options === 'number') { options = { family: options }; }
  options = Object.assign({}, options, { family: 4 });
  return _originalLookup(hostname, options, callback);
};

const { Telegraf, Markup } = require('telegraf');
const { BOT_TOKEN } = require('./config');
const fs = require('fs');
const path = require('path');
const https = require('https');
const axios = require('axios');
const { parseSongMessage, buildOutputText, buildCaption, buildLyricsMessage, ParseError, toTitleCase, cleanTitle } = require('./parser');
const { processAudio, cleanupFile, FfmpegError } = require('./converter');
const { loadTitles, lookupKoreanTitle, lookupKoreanByNumber } = require('./excelLookup');

const agent = new https.Agent({ keepAlive: true });
const bot = new Telegraf(BOT_TOKEN, { telegram: { agent } });

// Load Excel lookup on startup
loadTitles();

// ─── Pending state ────────────────────────────────────────────────────────────
// Keyed by `${chatId}:${promptMessageId}` so multiple prompts can be in-flight
// simultaneously (e.g. a batch of posts where several are missing data).
//
// Users must REPLY to the bot's prompt message to match the pending state.
// This lets batch processing work correctly — each song tracks independently.
//
// type: 'awaiting_audio'
//   { type, prefix, englishTitle, koreanTitle (may be null), lyrics }
//
// type: 'awaiting_korean_title'
//   { type, prefix, englishTitle, lyrics, fileId (null = /skip → lyrics only) }

const PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes
const pendingMap = new Map();

// ─── Per-chat queue ───────────────────────────────────────────────────────────
const queueMap = new Map(); // chatId -> [{ prefix, englishTitle, koreanTitle, lyrics, fileId }]

function getQueue(chatId) {
  if (!queueMap.has(chatId)) queueMap.set(chatId, []);
  return queueMap.get(chatId);
}

function clearQueue(chatId) {
  queueMap.delete(chatId);
}

function setPending(key, data) {
  pendingMap.set(key, { ...data, expiresAt: Date.now() + PENDING_TTL_MS });
}

function getPending(key) {
  const entry = pendingMap.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    pendingMap.delete(key);
    return null;
  }
  return entry;
}

function clearPending(key) {
  pendingMap.delete(key);
}

function pendingKey(chatId, messageId) {
  return `${chatId}:${messageId}`;
}

// ─── Keyboards ────────────────────────────────────────────────────────────────

function queueKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('▶️ Process all', 'cmd:done'), Markup.button.callback('🗑️ Clear', 'cmd:clear')],
  ]);
}

function prefixKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('G', 'p:G'), Markup.button.callback('SP', 'p:SP'), Markup.button.callback('Spop', 'p:Spop')],
  ]);
}

function skipKoreanKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback('⏭️ Skip', 'skip_korean')]]);
}

function skipAudioKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback('⏭️ Lyrics only', 'skip_audio')]]);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getAudioFileId(msg) {
  if (msg.audio) return msg.audio.file_id;
  if (msg.voice) return msg.voice.file_id;
  if (msg.video_note) return msg.video_note.file_id;
  if (msg.document && msg.document.mime_type?.startsWith('audio/')) return msg.document.file_id;
  return null;
}

// Returns { prefix, title } — either may be null
function getAudioMeta(msg) {
  let raw = null;
  if (msg.audio?.title) {
    raw = msg.audio.title.trim();
  } else {
    const filename = msg.audio?.file_name || msg.document?.file_name;
    if (filename) raw = filename.replace(/\.[^.]+$/, '').trim();
  }
  if (!raw) return { prefix: null, title: null };

  // "224 Song Name" / "224. Song Name" / "224 - Song Name" → prefix + title
  const numMatch = raw.match(/^(\d+)[.\s\-–]+(.+)/);
  if (numMatch) {
    return {
      prefix: numMatch[1],
      title: cleanTitle(toTitleCase(numMatch[2].trim())) || null,
    };
  }
  // Bare number → prefix only
  if (/^\d+$/.test(raw)) return { prefix: raw, title: null };

  return { prefix: null, title: cleanTitle(toTitleCase(raw)) || null };
}

function logMessageTypes(msg) {
  const types = ['audio','voice','video_note','document','text','caption','photo','video','sticker']
    .filter(t => msg[t])
    .map(t => t === 'document' ? `document(${msg.document.mime_type})` : t);
  console.log(`[msg] types: ${types.join(', ') || 'none'} | forward: ${!!msg.forward_date}`);
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const PROGRESS_TEXTS = [
  'Downloading audio',
  'Converting track',
  'Encoding output',
  'Formatting lyrics',
  'Preparing song',
  'Almost done',
];

async function withProgressMessage(ctx, action) {
  const chatId = ctx.chat?.id || ctx.message?.chat?.id;
  let frame = 0, textIdx = 0, progressMsgId = null;

  const sent = await ctx.reply(`${SPINNER[0]} ${PROGRESS_TEXTS[0]}...`).catch(() => null);
  progressMsgId = sent?.message_id;

  const interval = setInterval(() => {
    frame = (frame + 1) % SPINNER.length;
    if (frame === 0) textIdx = (textIdx + 1) % PROGRESS_TEXTS.length;
    if (progressMsgId) {
      ctx.telegram.editMessageText(chatId, progressMsgId, null,
        `${SPINNER[frame]} ${PROGRESS_TEXTS[textIdx]}...`).catch(() => {});
    }
  }, 2000);

  try {
    return await action();
  } finally {
    clearInterval(interval);
    if (progressMsgId) ctx.telegram.deleteMessage(chatId, progressMsgId).catch(() => {});
  }
}

const LYRICS_SEPARATOR = '· · · · · · · · · ·';

function buildLyricsWithCaption(caption, lyricsMsg) {
  // Title appears under the separator line: "· · ·\n🎵 *Title*\n\n[Verse 1]..."
  if (!lyricsMsg) return caption;
  const body = lyricsMsg.startsWith(LYRICS_SEPARATOR)
    ? lyricsMsg.slice(LYRICS_SEPARATOR.length)
    : `\n${lyricsMsg}`;
  return `${LYRICS_SEPARATOR}\n${caption}${body}`;
}

async function sendAudioResult(ctx, outputPath, duration, prefix, englishTitle, koreanTitle, lyrics) {
  const caption = buildCaption(prefix, englishTitle, koreanTitle);
  const lyricsMsg = buildLyricsMessage(lyrics);
  const plainTitle = (prefix && englishTitle) ? `${prefix}) ${englishTitle}` : (englishTitle || prefix || undefined);
  try {
    await ctx.replyWithAudio({ source: outputPath }, {
      ...(plainTitle && { title: plainTitle }),
      ...(duration && { duration }),
    });
    await ctx.reply(buildLyricsWithCaption(caption, lyricsMsg), { parse_mode: 'MarkdownV2' });
  } catch (err) {
    await ctx.reply(`Error sending file: ${err.message}`);
  } finally {
    cleanupFile(outputPath);
  }
}

async function sendLyricsOnly(ctx, prefix, englishTitle, koreanTitle, lyrics) {
  const caption = buildCaption(prefix, englishTitle, koreanTitle);
  const lyricsMsg = buildLyricsMessage(lyrics);
  try {
    await ctx.reply(buildLyricsWithCaption(caption, lyricsMsg), { parse_mode: 'MarkdownV2' });
  } catch (err) {
    await ctx.reply(`Error sending messages: ${err.message}`);
  }
}

async function convertAndSend(ctx, fileId, prefix, englishTitle, koreanTitle, lyrics) {
  let result = null;
  try {
    result = await withProgressMessage(ctx, () => processAudio(ctx.telegram, fileId));
  } catch (err) {
    console.error('[convertAndSend] error:', err);
    if (err instanceof FfmpegError) {
      await ctx.reply(`Audio conversion failed:\n\n${err.stderr}`);
    } else {
      await ctx.reply(`Error processing audio: ${err.message}`);
    }
    return;
  }
  await sendAudioResult(ctx, result.outputPath, result.duration, prefix, englishTitle, koreanTitle, lyrics);
}

// ─── Shared command logic ─────────────────────────────────────────────────────

async function processClear(chatId, ctx) {
  const queue = getQueue(chatId);
  const count = queue.length;
  clearQueue(chatId);
  await ctx.reply(count > 0 ? `Cleared ${count} song${count > 1 ? 's' : ''} from the queue.` : 'Queue is already empty.');
}

async function processDone(chatId, ctx) {
  const queue = getQueue(chatId);

  if (queue.length === 0) {
    await ctx.reply('No songs queued. Forward some posts first.');
    return;
  }

  // Merge songs with the same title (e.g. separate audio + lyrics messages)
  const mergedMap = new Map();
  for (const song of queue) {
    const key = (song.englishTitle || song.prefix || '').toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (!mergedMap.has(key)) {
      mergedMap.set(key, { ...song });
    } else {
      const base = mergedMap.get(key);
      if (!base.fileId && song.fileId) base.fileId = song.fileId;
      if (!base.lyrics && song.lyrics) base.lyrics = song.lyrics;
      if (!base.koreanTitle && song.koreanTitle) base.koreanTitle = song.koreanTitle;
      if (!base.prefix && song.prefix) base.prefix = song.prefix;
    }
  }
  const merged = [...mergedMap.values()];

  const lines = [`Queued ${merged.length} song${merged.length > 1 ? 's' : ''}:\n`];
  for (let i = 0; i < merged.length; i++) {
    const { prefix, englishTitle, koreanTitle, fileId } = merged[i];
    const title = prefix ? `${prefix}) ${englishTitle}` : englishTitle;
    const missing = [];
    if (!prefix) missing.push('prefix');
    if (!koreanTitle) missing.push('Korean title');
    if (!fileId) missing.push('audio file');
    lines.push(missing.length > 0
      ? `${i + 1}. ${title} — missing: ${missing.join(', ')}`
      : `${i + 1}. ${title} ✓`
    );
  }
  await ctx.reply(lines.join('\n'));

  const songs = merged;
  clearQueue(chatId);

  for (const song of songs) {
    const { prefix, englishTitle, koreanTitle, lyrics, fileId } = song;

    if (prefix && koreanTitle && fileId) {
      await convertAndSend(ctx, fileId, prefix, englishTitle, koreanTitle, lyrics);
      continue;
    }

    if (!prefix) {
      const promptMsg = await ctx.reply(
        `Reply to this message with the prefix for "${englishTitle}" (e.g. G, SP, 42):`,
        prefixKeyboard()
      );
      setPending(pendingKey(chatId, promptMsg.message_id), {
        type: 'awaiting_prefix', englishTitle, koreanTitle, lyrics, fileId,
      });
      continue;
    }

    if (!fileId) {
      const promptMsg = await ctx.reply(
        `Reply to this message with the audio file for "${prefix}) ${englishTitle}", or tap below for lyrics only.`,
        skipAudioKeyboard()
      );
      setPending(pendingKey(chatId, promptMsg.message_id), {
        type: 'awaiting_audio', prefix, englishTitle, koreanTitle, lyrics,
      });
      continue;
    }

    if (!koreanTitle) {
      const promptMsg = await ctx.reply(
        `Reply to this message with the Korean title for "${prefix}) ${englishTitle}":`,
        skipKoreanKeyboard()
      );
      setPending(pendingKey(chatId, promptMsg.message_id), {
        type: 'awaiting_korean_title', prefix, englishTitle, lyrics, fileId,
      });
    }
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

bot.command('start', (ctx) => {
  ctx.reply(
    'ChanYangBot\n\n' +
    'Forward a channel post that contains an audio file with song lyrics.\n\n' +
    'Expected text format:\n' +
    'G) HAIL TO THE BRIGHTNESS\n' +
    '시온의 영광이 빛나는 아침\n\n' +
    '1.\n' +
    'Verse text...\n\n' +
    'The bot will return the audio converted to .ogg with formatted lyrics.\n\n' +
    '/done — process all queued songs\n' +
    '/help — list commands\n' +
    '/reload — reload Korean title lookup from titles.xlsx'
  );
});

bot.command('help', (ctx) => {
  ctx.reply(
    'Commands:\n' +
    '/start — welcome message\n' +
    '/done — compile queued songs and process them\n' +
    '/clear — discard all queued songs\n' +
    '/reload — reload Korean title lookup from titles.xlsx\n' +
    '/help — show this message\n\n' +
    'Forward any channel posts, then send /done to process them all.\n\n' +
    'Supported prefixes:\n' +
    '  G = Gospel\n' +
    '  SP = Special Song\n' +
    '  Spop = Special Pop\n' +
    '  42 (any number) = Hymn number'
  );
});

bot.command('clear', (ctx) => processClear(ctx.chat.id, ctx));

bot.command('reload', (ctx) => {
  const ok = loadTitles();
  ctx.reply(
    ok
      ? 'Korean title lookup reloaded successfully.'
      : 'Failed to reload titles.xlsx. Make sure the file exists in the bot directory.'
  );
});

bot.command('done', async (ctx) => processDone(ctx.chat.id, ctx));

// ─── xlsx upload handler ──────────────────────────────────────────────────────

bot.on('document', async (ctx, next) => {
  const doc = ctx.message.document;
  if (!doc?.file_name?.endsWith('.xlsx')) return next();

  try {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const dest = path.join(__dirname, 'titles.xlsx');
    const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
    fs.writeFileSync(dest, response.data);
    const ok = loadTitles();
    await ctx.reply(ok ? 'titles.xlsx updated and reloaded successfully.' : 'File saved but failed to parse — check the format.');
  } catch (err) {
    await ctx.reply(`Failed to save titles.xlsx: ${err.message}`);
  }
});

// ─── Message handler ──────────────────────────────────────────────────────────

bot.on('message', async (ctx) => {
  const msg = ctx.message;
  const chatId = msg.chat.id;
  const isSkip = msg.text?.trim() === '/skip';
  logMessageTypes(msg);
  const fileId = getAudioFileId(msg);

  // ── Check if this is a reply to one of the bot's prompts ────────────────
  const replyToId = msg.reply_to_message?.message_id;
  if (replyToId) {
    const key = pendingKey(chatId, replyToId);
    const pending = getPending(key);

    if (pending?.type === 'awaiting_audio') {
      if (fileId) {
        clearPending(key);
        if (pending.koreanTitle) {
          await convertAndSend(ctx, fileId, pending.prefix, pending.englishTitle, pending.koreanTitle, pending.lyrics);
        } else {
          // Chain: now need Korean title
          const promptMsg = await ctx.reply(
            `Korean title not found for "${pending.prefix}) ${pending.englishTitle}".\n\nReply to this message with the Korean title to continue:`,
            skipKoreanKeyboard()
          );
          setPending(pendingKey(chatId, promptMsg.message_id), {
            type: 'awaiting_korean_title',
            prefix: pending.prefix,
            englishTitle: pending.englishTitle,
            lyrics: pending.lyrics,
            fileId,
          });
        }
        return;
      }

      if (isSkip) {
        clearPending(key);
        if (pending.koreanTitle) {
          await sendLyricsOnly(ctx, pending.prefix, pending.englishTitle, pending.koreanTitle, pending.lyrics);
        } else {
          // Chain: need Korean title even for lyrics-only
          const promptMsg = await ctx.reply(
            `Korean title not found for "${pending.prefix}) ${pending.englishTitle}".\n\nReply to this message with the Korean title to continue:`,
            skipKoreanKeyboard()
          );
          setPending(pendingKey(chatId, promptMsg.message_id), {
            type: 'awaiting_korean_title',
            prefix: pending.prefix,
            englishTitle: pending.englishTitle,
            lyrics: pending.lyrics,
            fileId: null,
          });
        }
        return;
      }

      // Wrong input — re-prompt (keep pending state)
      await ctx.reply('Please send an audio file, or reply /skip to receive just the formatted lyrics.');
      return;
    }

    if (pending?.type === 'awaiting_korean_title') {
      if (msg.text && !isSkip && !fileId && !msg.forward_date) {
        const koreanTitle = msg.text.trim();
        const hasKorean = /[\uAC00-\uD7A3]/.test(koreanTitle);
        if (!hasKorean) {
          await ctx.react('🤔').catch(() => {});
          await ctx.reply(`That doesn't look like a Korean title. Please reply with the Korean title for "${pending.prefix}) ${pending.englishTitle}":`);
          return;
        }
        clearPending(key);
        await ctx.react('✅').catch(() => {});
        if (pending.fileId) {
          await convertAndSend(ctx, pending.fileId, pending.prefix, pending.englishTitle, koreanTitle, pending.lyrics);
        } else {
          await sendLyricsOnly(ctx, pending.prefix, pending.englishTitle, koreanTitle, pending.lyrics);
        }
        return;
      }

      // Wrong input — re-prompt (keep pending state)
      await ctx.react('🤔').catch(() => {});
      await ctx.reply(`Please reply with the Korean title for "${pending.prefix}) ${pending.englishTitle}":`);
      return;
    }

    if (pending?.type === 'awaiting_prefix') {
      if (msg.text && !isSkip && !fileId && !msg.forward_date) {
        clearPending(key);
        const prefix = msg.text.trim();
        const { englishTitle, koreanTitle, lyrics, fileId: pendingFileId } = pending;
        if (pendingFileId) {
          await convertAndSend(ctx, pendingFileId, prefix, englishTitle, koreanTitle, lyrics);
        } else {
          const promptMsg = await ctx.reply(
            `No audio file found for "${prefix}) ${englishTitle}".\n\nReply to this message with the audio file, or tap below for lyrics only.`,
            skipAudioKeyboard()
          );
          setPending(pendingKey(chatId, promptMsg.message_id), {
            type: 'awaiting_audio',
            prefix,
            englishTitle,
            koreanTitle,
            lyrics,
          });
        }
        return;
      }

      await ctx.reply(`Please reply with the prefix for "${pending.englishTitle}" (e.g. G, SP, 42):`);
      return;
    }
  }

  // ── Normal flow ─────────────────────────────────────────────────────────
  const text = (msg.caption || msg.text || '').trim();
  if (!text) return;
  console.log(`[msg] raw text:\n${text}\n---`);

  // ── Parse text ──────────────────────────────────────────────────────────
  let parsed;
  try {
    parsed = parseSongMessage(text);
  } catch (err) {
    if (err instanceof ParseError) {
      await ctx.reply(`Parse error: ${err.message}`);
    } else {
      await ctx.reply(`Unexpected error while parsing message: ${err.message}`);
    }
    return;
  }

  let { prefix, englishTitle, koreanTitle, lyrics } = parsed;

  // Fill in missing title and/or prefix from audio file metadata
  if (fileId && (!englishTitle || !prefix)) {
    const audioMeta = getAudioMeta(msg);
    if (!englishTitle && audioMeta.title) englishTitle = audioMeta.title;
    if (!prefix && audioMeta.prefix) prefix = audioMeta.prefix;
    if (audioMeta.title || audioMeta.prefix) {
      console.log(`[msg] audio metadata: prefix=${audioMeta.prefix} title=${audioMeta.title}`);
    }
  }

  console.log(`[msg] parsed: prefix=${prefix} title=${englishTitle} korean=${koreanTitle} fileId=${fileId} hasLyrics=${!!lyrics}`);
  if (lyrics) console.log(`[msg] lyrics:\n${lyrics}\n---`);

  // ── Validate: must look like a song, not a command or empty message ─────
  const hasNumericPrefix = /^\d+$/.test(prefix || '');
  if (!englishTitle && !hasNumericPrefix) return;
  if (englishTitle?.startsWith('/')) return;
  if (!fileId && !lyrics && !hasNumericPrefix) {
    await ctx.reply(`Skipped: no audio or lyrics found in this message.`);
    return;
  }

  // Korean title fallback via Excel lookup — try English title, then numeric prefix
  if (!koreanTitle) {
    koreanTitle = (englishTitle && lookupKoreanTitle(englishTitle))
               || (/^\d+$/.test(prefix || '') && lookupKoreanTitle(prefix))
               || null;
  }

  // ── Queue the song — merge if same title already queued ────────────────
  const queue = getQueue(chatId);
  const songKey = (s) => (s.englishTitle || s.prefix || '').toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').trim();
  const matchKey = songKey({ englishTitle, prefix });
  const existing = queue.find(s => songKey(s) === matchKey && matchKey !== '');

  if (existing) {
    if (!existing.fileId && fileId) { existing.fileId = fileId; }
    if (!existing.lyrics && lyrics) existing.lyrics = lyrics;
    if (!existing.koreanTitle && koreanTitle) existing.koreanTitle = koreanTitle;
    if (!existing.prefix && prefix) existing.prefix = prefix;

    const title = existing.prefix && existing.englishTitle ? `${existing.prefix}) ${existing.englishTitle}` : (existing.englishTitle || existing.prefix || '?');
    const ackText = `Queued: ${title} (${queue.length} total) — detected 2 related messages, merged into one.`;

    if (existing.ackMessageId) {
      await ctx.telegram.editMessageText(chatId, existing.ackMessageId, null, ackText, queueKeyboard()).catch(() => {});
    } else {
      await ctx.reply(ackText, queueKeyboard());
    }
  } else {
    const song = { prefix, englishTitle, koreanTitle, lyrics, fileId: fileId || null, ackMessageId: null };
    queue.push(song);
    const title = prefix && englishTitle ? `${prefix}) ${englishTitle}` : (englishTitle || prefix || '?');
    const ackMsg = await ctx.reply(`Queued: ${title} (${queue.length} total).`, queueKeyboard());
    song.ackMessageId = ackMsg.message_id;
  }
});

// ─── Button actions ───────────────────────────────────────────────────────────

bot.action('cmd:done', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await processDone(ctx.chat.id, ctx);
});

bot.action('cmd:clear', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await processClear(ctx.chat.id, ctx);
});

bot.action(/^p:(.+)$/, async (ctx) => {
  const prefix = ctx.match[1];
  const msgId = ctx.callbackQuery.message.message_id;
  const chatId = ctx.chat.id;
  const key = pendingKey(chatId, msgId);
  const pending = getPending(key);

  if (!pending || pending.type !== 'awaiting_prefix') {
    await ctx.answerCbQuery('This prompt has expired.').catch(() => {});
    return;
  }

  await ctx.answerCbQuery().catch(() => {});
  clearPending(key);

  const { englishTitle, koreanTitle, lyrics, fileId: pendingFileId } = pending;
  if (pendingFileId) {
    await convertAndSend(ctx, pendingFileId, prefix, englishTitle, koreanTitle, lyrics);
  } else {
    const promptMsg = await ctx.reply(
      `No audio file found for "${prefix}) ${englishTitle}".\n\nReply to this message with the audio file, or tap below for lyrics only.`,
      skipAudioKeyboard()
    );
    setPending(pendingKey(chatId, promptMsg.message_id), {
      type: 'awaiting_audio', prefix, englishTitle, koreanTitle, lyrics,
    });
  }
});

bot.action('skip_korean', async (ctx) => {
  const msgId = ctx.callbackQuery.message.message_id;
  const chatId = ctx.chat.id;
  const key = pendingKey(chatId, msgId);
  const pending = getPending(key);

  if (!pending || pending.type !== 'awaiting_korean_title') {
    await ctx.answerCbQuery('This prompt has expired.').catch(() => {});
    return;
  }

  await ctx.answerCbQuery().catch(() => {});
  clearPending(key);

  if (pending.fileId) {
    await convertAndSend(ctx, pending.fileId, pending.prefix, pending.englishTitle, null, pending.lyrics);
  } else {
    await sendLyricsOnly(ctx, pending.prefix, pending.englishTitle, null, pending.lyrics);
  }
});

bot.action('skip_audio', async (ctx) => {
  const msgId = ctx.callbackQuery.message.message_id;
  const chatId = ctx.chat.id;
  const key = pendingKey(chatId, msgId);
  const pending = getPending(key);

  if (!pending || pending.type !== 'awaiting_audio') {
    await ctx.answerCbQuery('This prompt has expired.').catch(() => {});
    return;
  }

  await ctx.answerCbQuery().catch(() => {});
  clearPending(key);

  if (pending.koreanTitle) {
    await sendLyricsOnly(ctx, pending.prefix, pending.englishTitle, pending.koreanTitle, pending.lyrics);
  } else {
    const promptMsg = await ctx.reply(
      `Korean title not found for "${pending.prefix}) ${pending.englishTitle}".\n\nReply to this message with the Korean title to continue:`,
      skipKoreanKeyboard()
    );
    setPending(pendingKey(chatId, promptMsg.message_id), {
      type: 'awaiting_korean_title',
      prefix: pending.prefix,
      englishTitle: pending.englishTitle,
      lyrics: pending.lyrics,
      fileId: null,
    });
  }
});

// ─── Launch ───────────────────────────────────────────────────────────────────

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err?.message || err);
});

async function launch() {
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.launch();
      console.log('ChanYangBot started.');
      return;
    } catch (err) {
      const is409 = err.message?.includes('409');
      const delay = is409 ? 46000 : 3000;
      console.error(`[launch] attempt ${attempt} failed: ${err.message} — retrying in ${delay / 1000}s`);
      bot.stop().catch(() => {});
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

launch();
