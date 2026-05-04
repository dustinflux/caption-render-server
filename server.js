const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3001;

// --- Config ---
const TEMP_DIR = path.join(__dirname, "tmp");
const MAX_VIDEO_DURATION_SEC = 120; // reject videos longer than 2 min
const RENDER_TIMEOUT_MS = 60000; // 60s max per render
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim())
  : ["*"]; // Lock this down to your Lovable domain in production

// Ensure temp dir exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// --- Middleware ---
app.use(
  cors({
    origin: (origin, cb) => {
      if (ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) {
        cb(null, true);
      } else {
        cb(null, true); // permissive for now — lock down after testing
      }
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json({ limit: "100mb" }));

// --- Health check ---
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    version: "1.0.0",
    ffmpeg: true,
    uptime: process.uptime(),
  });
});

// --- Download a file from URL to local path ---
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(destPath);
    proto
      .get(url, (response) => {
        // Follow redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.close();
          fs.unlinkSync(destPath);
          return downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
        }
        if (response.statusCode !== 200) {
          file.close();
          fs.unlinkSync(destPath);
          return reject(new Error(`Download failed: HTTP ${response.statusCode}`));
        }
        response.pipe(file);
        file.on("finish", () => {
          file.close(resolve);
        });
      })
      .on("error", (err) => {
        file.close();
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        reject(err);
      });
  });
}

// --- Probe video duration ---
function probeVideo(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath,
    ]);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed: ${stderr}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error("Failed to parse ffprobe output"));
      }
    });
  });
}

// --- Build FFmpeg drawtext filter ---
function buildCaptionFilter(caption) {
  const {
    text = "",
    fontSize = 42,
    fontColor = "white",
    bgColor = "black@0.6",
    position = "bottom", // top | center | bottom
    fontFamily = "Arial",
    borderWidth = 2,
    borderColor = "black",
    paddingX = 20,
    paddingY = 10,
    maxWidth = 80, // percent of video width
  } = caption;

  // Escape text for FFmpeg drawtext
  const escaped = text
    .replace(/\\/g, "\\\\\\\\")
    .replace(/'/g, "'\\\\\\''")
    .replace(/:/g, "\\\\:")
    .replace(/%/g, "\\\\%")
    .replace(/\n/g, "\\n");

  // Y position mapping
  let yExpr;
  switch (position) {
    case "top":
      yExpr = `${paddingY + 20}`;
      break;
    case "center":
      yExpr = "(h-text_h)/2";
      break;
    case "bottom":
    default:
      yExpr = `h-text_h-${paddingY + 40}`;
      break;
  }

  // Build the drawtext filter
  const filter = [
    `drawtext=text='${escaped}'`,
    `fontsize=${fontSize}`,
    `fontcolor=${fontColor}`,
    `borderw=${borderWidth}`,
    `bordercolor=${borderColor}`,
    `x=(w-text_w)/2`,
    `y=${yExpr}`,
    `box=1`,
    `boxcolor=${bgColor}`,
    `boxborderw=${paddingX}`,
    `line_spacing=8`,
  ].join(":");

  return filter;
}

// --- Run FFmpeg render ---
function renderVideo(inputPath, outputPath, captionFilter) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i", inputPath,
      "-vf", captionFilter,
      "-c:v", "libx264",
      "-preset", "ultrafast", // fastest encoding
      "-crf", "23", // good quality, fast
      "-c:a", "copy", // don't re-encode audio
      "-movflags", "+faststart", // optimize for streaming
      outputPath,
    ];

    console.log(`[render] Starting FFmpeg: ffmpeg ${args.join(" ")}`);
    const startTime = Date.now();

    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("Render timed out"));
    }, RENDER_TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (code !== 0) {
        console.error(`[render] FFmpeg failed (${elapsed}s): ${stderr}`);
        return reject(new Error(`FFmpeg exited with code ${code}`));
      }
      console.log(`[render] Complete in ${elapsed}s`);
      resolve({ elapsed: parseFloat(elapsed) });
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// --- Cleanup helper ---
function cleanup(...files) {
  for (const f of files) {
    try {
      if (f && fs.existsSync(f)) fs.unlinkSync(f);
    } catch (e) {
      console.warn(`[cleanup] Failed to remove ${f}: ${e.message}`);
    }
  }
}

// ============================================================
// POST /render  —  The main endpoint
// ============================================================
// Accepts:
// {
//   videoUrl: "https://...",          // URL to source video
//   caption: {
//     text: "Your caption here",
//     fontSize: 42,
//     fontColor: "white",
//     bgColor: "black@0.6",
//     position: "bottom",             // top | center | bottom
//     borderWidth: 2,
//     borderColor: "black",
//     paddingX: 20,
//     paddingY: 10
//   }
// }
//
// Returns: the rendered video file as a download
// ============================================================
app.post("/render", async (req, res) => {
  const jobId = uuidv4().slice(0, 8);
  const log = (msg) => console.log(`[job:${jobId}] ${msg}`);

  let inputPath = null;
  let outputPath = null;

  try {
    const { videoUrl, caption } = req.body;

    // Validate
    if (!videoUrl) return res.status(400).json({ error: "videoUrl is required" });
    if (!caption || !caption.text) return res.status(400).json({ error: "caption.text is required" });

    log(`Render request: ${videoUrl.substring(0, 80)}...`);
    log(`Caption: "${caption.text.substring(0, 50)}..." pos=${caption.position || "bottom"}`);

    // 1. Download video
    const ext = ".mp4";
    inputPath = path.join(TEMP_DIR, `${jobId}-input${ext}`);
    outputPath = path.join(TEMP_DIR, `${jobId}-output${ext}`);

    log("Downloading video...");
    const dlStart = Date.now();
    await downloadFile(videoUrl, inputPath);
    log(`Downloaded in ${((Date.now() - dlStart) / 1000).toFixed(1)}s (${(fs.statSync(inputPath).size / 1024 / 1024).toFixed(1)}MB)`);

    // 2. Probe video (optional duration check)
    try {
      const probe = await probeVideo(inputPath);
      const duration = parseFloat(probe.format?.duration || "0");
      log(`Video duration: ${duration.toFixed(1)}s`);
      if (duration > MAX_VIDEO_DURATION_SEC) {
        cleanup(inputPath);
        return res.status(400).json({
          error: `Video is ${duration.toFixed(0)}s — max allowed is ${MAX_VIDEO_DURATION_SEC}s`,
        });
      }
    } catch (e) {
      log(`Probe warning (non-fatal): ${e.message}`);
    }

    // 3. Build caption filter
    const filter = buildCaptionFilter(caption);
    log(`Filter: ${filter.substring(0, 100)}...`);

    // 4. Render
    const result = await renderVideo(inputPath, outputPath, filter);
    log(`Render complete: ${result.elapsed}s`);

    // 5. Stream result back
    const stat = fs.statSync(outputPath);
    log(`Output size: ${(stat.size / 1024 / 1024).toFixed(1)}MB`);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", `attachment; filename="captioned-${jobId}.mp4"`);
    res.setHeader("X-Render-Time", `${result.elapsed}s`);
    res.setHeader("X-Job-Id", jobId);

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on("end", () => {
      cleanup(inputPath, outputPath);
    });
    stream.on("error", (err) => {
      log(`Stream error: ${err.message}`);
      cleanup(inputPath, outputPath);
      if (!res.headersSent) res.status(500).json({ error: "Failed to stream result" });
    });
  } catch (err) {
    log(`Error: ${err.message}`);
    cleanup(inputPath, outputPath);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message, jobId });
    }
  }
});

// ============================================================
// POST /render/batch  —  Multiple videos in one request
// ============================================================
// Accepts:
// {
//   videos: [
//     { videoUrl: "...", caption: { text: "...", ... } },
//     { videoUrl: "...", caption: { text: "...", ... } }
//   ]
// }
//
// Returns: JSON with download URLs (short-lived)
// ============================================================
app.post("/render/batch", async (req, res) => {
  const batchId = uuidv4().slice(0, 8);
  const log = (msg) => console.log(`[batch:${batchId}] ${msg}`);

  try {
    const { videos } = req.body;
    if (!Array.isArray(videos) || videos.length === 0) {
      return res.status(400).json({ error: "videos array is required" });
    }
    if (videos.length > 20) {
      return res.status(400).json({ error: "Maximum 20 videos per batch" });
    }

    log(`Batch render: ${videos.length} videos`);

    // Process all in parallel (up to 4 at a time)
    const CONCURRENCY = 4;
    const results = [];
    const queue = [...videos.map((v, i) => ({ ...v, index: i }))];
    const active = [];

    async function processOne(item) {
      const jobId = `${batchId}-${item.index}`;
      const inputPath = path.join(TEMP_DIR, `${jobId}-input.mp4`);
      const outputPath = path.join(TEMP_DIR, `${jobId}-output.mp4`);

      try {
        await downloadFile(item.videoUrl, inputPath);
        const filter = buildCaptionFilter(item.caption);
        const result = await renderVideo(inputPath, outputPath, filter);

        // Keep output file for 5 minutes, then auto-delete
        setTimeout(() => cleanup(outputPath), 5 * 60 * 1000);
        cleanup(inputPath);

        return {
          index: item.index,
          success: true,
          elapsed: result.elapsed,
          downloadUrl: `/download/${jobId}`,
          jobId,
        };
      } catch (err) {
        cleanup(inputPath, outputPath);
        return {
          index: item.index,
          success: false,
          error: err.message,
          jobId,
        };
      }
    }

    // Simple concurrency limiter
    const allResults = [];
    for (let i = 0; i < queue.length; i += CONCURRENCY) {
      const chunk = queue.slice(i, i + CONCURRENCY);
      const chunkResults = await Promise.all(chunk.map(processOne));
      allResults.push(...chunkResults);
      log(`Completed ${Math.min(i + CONCURRENCY, queue.length)}/${queue.length}`);
    }

    allResults.sort((a, b) => a.index - b.index);

    log(`Batch complete: ${allResults.filter((r) => r.success).length}/${allResults.length} succeeded`);

    res.json({
      batchId,
      total: allResults.length,
      succeeded: allResults.filter((r) => r.success).length,
      results: allResults,
    });
  } catch (err) {
    log(`Batch error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// --- Serve batch-rendered files ---
app.get("/download/:jobId", (req, res) => {
  const filePath = path.join(TEMP_DIR, `${req.params.jobId}-output.mp4`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found or expired" });
  }
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="captioned-${req.params.jobId}.mp4"`);
  fs.createReadStream(filePath).pipe(res);
});

// --- Periodic temp cleanup (every 10 min) ---
setInterval(() => {
  if (!fs.existsSync(TEMP_DIR)) return;
  const now = Date.now();
  const files = fs.readdirSync(TEMP_DIR);
  let cleaned = 0;
  for (const f of files) {
    const fp = path.join(TEMP_DIR, f);
    try {
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > 10 * 60 * 1000) {
        fs.unlinkSync(fp);
        cleaned++;
      }
    } catch (e) {}
  }
  if (cleaned > 0) console.log(`[cleanup] Removed ${cleaned} stale temp files`);
}, 10 * 60 * 1000);

// --- Start ---
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n===================================`);
  console.log(`  Caption Render Server v1.0.0`);
  console.log(`  Port: ${PORT}`);
  console.log(`  Temp: ${TEMP_DIR}`);
  console.log(`  Origins: ${ALLOWED_ORIGINS.join(", ")}`);
  console.log(`===================================\n`);
});
