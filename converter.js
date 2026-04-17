const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const ffmpeg = require('fluent-ffmpeg');

const ipv4Agent = new https.Agent({ keepAlive: true });

class FfmpegError extends Error {
  constructor(stderr) {
    super('ffmpeg conversion failed');
    this.name = 'FfmpegError';
    this.stderr = stderr;
  }
}

async function downloadFile(fileUrl, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const req = https.get(fileUrl, { agent: ipv4Agent }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        file.close();
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', (err) => { file.close(); reject(err); });
    });
    req.setTimeout(10000, () => {
      req.destroy(new Error('Download timed out after 10s'));
    });
    req.on('error', reject);
  });
}

async function getAudioDuration(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      resolve(err ? null : Math.round(meta?.format?.duration || 0));
    });
  });
}

async function generateWaveform(filePath) {
  return new Promise((resolve) => {
    const chunks = [];
    ffmpeg(filePath)
      .audioFrequency(8000)
      .audioChannels(1)
      .format('s16le')
      .on('error', () => resolve(null))
      .pipe()
      .on('data', c => chunks.push(c))
      .on('end', () => {
        const buf = Buffer.concat(chunks);
        const total = buf.length / 2;
        const N = 100;
        const chunkSize = Math.max(1, Math.floor(total / N));
        const amps = [];
        for (let i = 0; i < N; i++) {
          let sum = 0;
          const start = i * chunkSize;
          for (let j = 0; j < chunkSize && (start + j) * 2 + 1 < buf.length; j++) {
            sum += Math.abs(buf.readInt16LE((start + j) * 2));
          }
          amps.push(sum / chunkSize);
        }
        const max = Math.max(...amps, 1);
        const vals = amps.map(a => Math.round((a / max) * 31));
        // Pack 100 x 5-bit values into bytes
        const packed = [];
        let cur = 0, bits = 0;
        for (const v of vals) {
          cur |= (v << bits);
          bits += 5;
          while (bits >= 8) { packed.push(cur & 0xff); cur >>= 8; bits -= 8; }
        }
        if (bits > 0) packed.push(cur & 0xff);
        resolve(Buffer.from(packed).toString('base64'));
      });
  });
}

async function convertToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioCodec('libmp3lame')
      .audioBitrate(192)
      .format('mp3')
      .on('end', () => resolve(outputPath))
      .on('error', (err, _stdout, stderr) => {
        reject(new FfmpegError(stderr || err.message));
      })
      .save(outputPath);
  });
}

function cleanupFile(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (_) {
    // ignore cleanup errors
  }
}

async function withRetry(fn, retries = 3, delayMs = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const transient = err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.message?.includes('timed out');
      if (!transient || i === retries - 1) throw err;
      console.log(`[retry] attempt ${i + 1} failed (${err.code}), retrying in ${delayMs}ms...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

async function processAudio(telegram, fileId) {
  const uniqueId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const inputPath = path.join(os.tmpdir(), `songbot_in_${uniqueId}.audio`);
  const outputPath = path.join(os.tmpdir(), `songbot_out_${uniqueId}.mp3`);

  const fileLink = await withRetry(() => telegram.getFileLink(fileId));

  try {
    await withRetry(() => downloadFile(fileLink.href, inputPath));
    await convertToMp3(inputPath, outputPath);
    const duration = await getAudioDuration(outputPath);
    return { outputPath, duration };
  } finally {
    cleanupFile(inputPath);
  }
}

module.exports = { processAudio, cleanupFile, FfmpegError };
