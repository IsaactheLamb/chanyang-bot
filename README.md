# Chanyang Bot 🎵

A Telegram bot that helps church members share and format hymn lyrics with ease. Forward any church song post, and the bot processes the audio and lyrics, extracting metadata and delivering a beautifully formatted result.

## Features

✨ **Automatic Metadata Extraction**
- Extracts hymn numbers and song titles from audio file metadata
- Looks up Korean translations from a comprehensive hymn database
- Supports both English and Korean hymn collections (including green book songs)

🎼 **Smart Lyrics Processing**
- Detects and fixes syllable breaks (words split by `|`, `/`, or `\`)
- Preserves compound words and hyphenated numbers (e.g., forty-four, hundred-forty-four)
- Automatically formats verses, choruses, bridges, and pre-choruses
- Cleans up special characters while maintaining readability

🔊 **Audio Conversion**
- Converts OGG/Telegram voice files to MP3 format
- Embeds lyrics with song title for easy playback
- Supports both audio files and voice messages

📋 **User-Friendly Interface**
- Simple inline buttons for common actions
- Prompts for missing information (prefix/title/Korean translation)
- Progress indicators while processing

## Installation

### Prerequisites
- Node.js v16+
- FFmpeg with libmp3lame support
- A Telegram bot token (from @BotFather)

### Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/chanyang-bot.git
   cd chanyang-bot
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment**
   Create a `.env` file with your bot token:
   ```
   BOT_TOKEN=your_telegram_bot_token_here
   ```

4. **Set up the hymn database**
   - Place a `titles.xlsx` file in the project root with three columns:
     - Column A: English song title
     - Column B: Korean translation
     - Column C (green book only): Hymn number

5. **Start the bot**
   ```bash
   node index.js
   ```

## Usage

### Basic Workflow

1. **Forward a song post** to the bot's chat
   - The bot recognizes messages with audio or captions containing song information

2. **Provide missing information** if prompted
   - Song prefix (e.g., G, SP, 118) — tap the buttons or enter manually
   - Song title (if not detected from audio metadata or message)
   - Korean translation (or skip if not needed)

3. **Receive formatted output**
   - MP3 file with embedded lyrics and metadata
   - Beautifully formatted lyrics with verse/chorus labels

### Message Format

The bot accepts messages in several formats:

**Standard format:**
```
[Prefix] English Title
Korean Title

1. Verse 1 lyrics
...

Chorus:
Chorus lyrics
...
```

**With audio metadata:**
- Just forward the message with audio
- The bot extracts title from the audio file metadata

**Hymn number only:**
- Send just a hymn number (e.g., "224")
- The bot looks up the Korean title automatically

## File Structure

```
chanyang-bot/
├── index.js              # Main bot logic
├── parser.js             # Lyrics parsing and formatting
├── converter.js          # Audio conversion (OGG → MP3)
├── excelLookup.js        # Hymn database lookup
├── config.js             # Configuration loader
├── package.json          # Dependencies
├── titles.xlsx           # Hymn database
├── .env                  # Environment variables (gitignored)
└── README.md             # This file
```

## Core Modules

### Parser (`parser.js`)
Handles all text parsing and formatting:
- `parseSongMessage(text)` — Extracts title, Korean translation, and lyrics
- `buildCaption(prefix, title, korean)` — Formats the song header
- `buildLyricsMessage(lyrics)` — Formats lyrics with section labels
- Smart hyphen handling and syllable-break detection

### Converter (`converter.js`)
Manages audio file processing:
- `processAudio(inputPath)` — Converts OGG to MP3 (192 kbps)
- `cleanupFile(path)` — Removes temporary files

### Excel Lookup (`excelLookup.js`)
Korean translation database:
- `loadTitles()` — Loads hymn data from `titles.xlsx`
- `lookupKoreanTitle(englishTitle)` — Find by English title
- `lookupKoreanByNumber(hymnNumber)` — Find by hymn number

## Title Detection Rules

The bot identifies a valid song title if:
- ✅ Starts with a prefix marker (e.g., "224) Song Title" or "G. Song Title")
- ✅ Extracted from audio file metadata (title or filename)
- ✅ Is a bare title ≤60 characters with at least one letter

Invalid titles are rejected:
- ❌ Symbols-only strings (e.g., ".....")
- ❌ Text without letters
- ❌ Bare text >60 characters (treated as lyrics)

## Lyrics Formatting

### Verse Detection
Verses are recognized by labels:
- `1.` or `1)` (with or without space)
- `Verse 1`, `V1`, `Vs1`

### Section Labels
- **Verse:** `[Verse N]`
- **Chorus:** `[Chorus]` (with italics)
- **Bridge:** `[Bridge]`
- **Pre-Chorus:** `[Pre-Chorus]`

### Syllable Break Fixing
The bot automatically joins syllable fragments split by `|`, `/`, or `\`:
- `Je|sus` → `Jesus`
- `victo/ry` → `victory`

Uses a dictionary to determine if words should be joined:
- If either side isn't a real English word, they're likely fragments → join them
- Otherwise, they're separate words → keep them separate

### Hyphen Handling
- **Syllable breaks:** `recei-ved` → `received`
- **Compound words:** `forty-four` → kept as-is (real dictionary words)
- **Numbers:** `hundred-forty-four` → kept as-is

## Keyboard Shortcuts

When processing queue:
- **▶️ Process all** — Convert all pending songs in the queue
- **🗑️ Clear** — Delete all pending songs without processing

When providing missing info:
- **Button responses** — Tap to select prefix, skip Korean translation, etc.

## Troubleshooting

**Bot doesn't recognize lyrics**
- Ensure message format is correct with clear section labels
- Check that verses are marked with `1.`, `2.`, etc.

**Korean translation not found**
- Verify the song title matches the `titles.xlsx` database
- Update `titles.xlsx` if the song is new
- Manually provide the translation when prompted

**Audio conversion fails**
- Ensure FFmpeg is installed: `ffmpeg -version`
- Verify libmp3lame is available: `ffmpeg -codecs | grep mp3`

**Syllable fragments still split**
- This usually means both fragments are real English words (e.g., "is with")
- Manually edit the lyrics or update the message format

## Contributing

Have suggestions or found a bug? Feel free to open an issue or pull request.

## License

MIT License

## Support

For questions or issues, contact the bot admin or open an issue on GitHub.

---

Made with ❤️ for church musicians
