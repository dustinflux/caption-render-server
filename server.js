// ============================================================
// Caption Render Server v3.0.0 — Production Grade
// Handles: iPhone .mov, Android .mp4, HEVC, VP9, AV1, WebM,
// MKV, AVI, ProRes, variable frame rate, HDR, rotation,
// odd resolutions, missing audio, multi-stream, and more.
//
// Strategy: Accept ANY video → normalize to clean H.264/AAC
// intermediate → composite overlay → output MP4.
// ============================================================

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
const TEMP_DIR = path.join(__dirname, "tmp");

// --- Limits ---
const MAX_VIDEO_DURATION_SEC = 180;      // 3 minutes max
const MAX_FILE_SIZE_MB = 500;            // 500MB max input
const DOWNLOAD_TIMEOUT_MS = 60000;       // 60s to download source
const NORMALIZE_TIMEOUT_MS = 120000;     // 2min to normalize
const RENDER_TIMEOUT_MS = 120000;        // 2min to render overlay
const MAX_BODY_SIZE = "250mb";           // for base64 overlay PNG

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim())
  : ["*"];

// Supported input formats (ffmpeg handles all of these)
const SUPPORTED_EXTENSIONS = new Set([
  ".mp4", ".mov", ".m4v",       // Apple / generic MP4
  ".webm",                       // Google / web
  ".mkv",                        // Matroska
  ".avi",                        // Legacy Windows
  ".flv", ".f4v",               // Flash legacy
  ".wmv",                        // Windows Media
  ".mts", ".m2ts",              // AVCHD (cameras)
  ".3gp", ".3g2",               // Mobile legacy
  ".ts", ".mxf",                // Broadcast
  ".ogv",                        // Ogg video
]);

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// --- Middleware ---
app.use(cors({
  origin: (origin, cb) => cb(null, true),
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json({ limit: MAX_BODY_SIZE }));

// ============================================================
// Health check — also verifies FFmpeg codecs are available
// ============================================================
app.get("/health", async (req, res) => {
  let ffmpegVersion = "unknown";
  let codecs = [];
  try {
    const result = await runCommand("ffmpeg", ["-version"]);
    ffmpegVersion = result.stdout.split("\n")[0] || "unknown";
    // Check critical codecs
    const codecCheck = await runCommand("ffmpeg", ["-codecs"]);
    const codecStr = codecCheck.stdout;
    if (codecStr.includes("libx264")) codecs.push("h264-encode");
    if (codecStr.includes("hevc") || codecStr.includes("h265")) codecs.push("hevc-decode");
    if (codecStr.includes("vp9")) codecs.push("vp9-decode");
    if (codecStr.includes("aac")) codecs.push("aac");
  } catch (e) { /* ignore */ }

  res.json({
    status: "ok",
    version: "3.3.0",
    ffmpeg: ffmpegVersion,
    codecs,
    uptime: process.uptime(),
    features: [
      "overlay-image-rgba",
      "drawtext-fallback",
      "auto-normalize",
      "iphone-mov",
      "android-mp4",
      "hevc-h265",
      "vp9-webm",
      "variable-framerate-fix",
      "rotation-fix",
      "hdr-to-sdr",
      "odd-resolution-fix",
      "multi-stream-handling",
    ],
    limits: {
      maxDurationSec: MAX_VIDEO_DURATION_SEC,
      maxFileSizeMB: MAX_FILE_SIZE_MB,
    },
  });
});

// ============================================================
// Utility: run a command and capture stdout/stderr
// ============================================================
function runCommand(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    const timeout = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error(cmd + " timed out")); }, timeoutMs);
    proc.on("close", (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

// ============================================================
// Download file from URL with timeout and redirect following
// ============================================================
function downloadFile(url, destPath, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Download timed out after " + (timeoutMs / 1000) + "s")), timeoutMs);
    const proto = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(destPath);

    function doGet(getUrl, redirectCount) {
      if (redirectCount > 5) { clearTimeout(timer); file.close(); reject(new Error("Too many redirects")); return; }
      proto.get(getUrl, (resp) => {
        if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
          file.close();
          if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
          const newFile = fs.createWriteStream(destPath);
          // Recursive redirect with new write stream — simplified: just call downloadFile again
          clearTimeout(timer);
          return downloadFile(resp.headers.location, destPath, timeoutMs).then(resolve).catch(reject);
        }
        if (resp.statusCode !== 200) {
          clearTimeout(timer); file.close();
          if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
          return reject(new Error("HTTP " + resp.statusCode + " downloading video"));
        }
        resp.pipe(file);
        file.on("finish", () => { clearTimeout(timer); file.close(resolve); });
        file.on("error", (err) => { clearTimeout(timer); reject(err); });
      }).on("error", (err) => { clearTimeout(timer); file.close(); reject(err); });
    }

    doGet(url, 0);
  });
}

// ============================================================
// Probe video — extract everything we need
// ============================================================
async function probeVideo(filePath) {
  const result = await runCommand("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath,
  ], 15000);

  if (result.code !== 0) throw new Error("ffprobe failed: " + result.stderr.slice(-200));

  const data = JSON.parse(result.stdout);
  const videoStream = data.streams?.find((s) => s.codec_type === "video");
  const audioStream = data.streams?.find((s) => s.codec_type === "audio");

  if (!videoStream) throw new Error("No video stream found in file");

  const width = videoStream.width || 0;
  const height = videoStream.height || 0;
  const duration = parseFloat(data.format?.duration || videoStream.duration || "0");
  const rotation = parseInt(videoStream.tags?.rotate || videoStream.side_data_list?.[0]?.rotation || "0", 10);
  const pixFmt = videoStream.pix_fmt || "unknown";
  const videoCodec = videoStream.codec_name || "unknown";
  const audioCodec = audioStream?.codec_name || "none";
  const fps = eval(videoStream.r_frame_rate || "30/1") || 30; // e.g. "30/1" → 30
  const isVFR = videoStream.r_frame_rate !== videoStream.avg_frame_rate; // variable frame rate hint

  // Detect HDR: 10-bit or specific color spaces
  const isHDR = pixFmt.includes("10") || pixFmt.includes("12") ||
    (videoStream.color_transfer === "smpte2084") ||
    (videoStream.color_transfer === "arib-std-b67");

  // Detect if resolution is odd (not divisible by 2 — h264 requires even)
  const isOddRes = (width % 2 !== 0) || (height % 2 !== 0);

  // Actual display dimensions after rotation
  const isRotated = Math.abs(rotation) === 90 || Math.abs(rotation) === 270;
  const displayWidth = isRotated ? height : width;
  const displayHeight = isRotated ? width : height;

  return {
    width, height,
    displayWidth, displayHeight,
    duration, rotation, isRotated,
    pixFmt, videoCodec, audioCodec,
    hasAudio: !!audioStream,
    fps: Math.round(fps),
    isVFR,
    isHDR,
    isOddRes,
    fileSize: parseInt(data.format?.size || "0", 10),
    formatName: data.format?.format_name || "unknown",
    needsNormalization: (
      videoCodec !== "h264" ||     // Not already H.264
      isHDR ||                      // HDR needs tonemapping
      isOddRes ||                   // Odd resolution needs padding
      isVFR ||                      // VFR needs CFR conversion
      pixFmt !== "yuv420p"          // Non-standard pixel format
    ),
  };
}

// ============================================================
// Normalize video — convert ANY input to clean H.264/AAC/MP4
// This guarantees the overlay step always works.
// ============================================================
function normalizeVideo(inputPath, outputPath, probe, log) {
  return new Promise((resolve, reject) => {
    const filters = [];

    // Fix odd resolution (h264 needs even dimensions)
    if (probe.isOddRes) {
      filters.push("pad=ceil(iw/2)*2:ceil(ih/2)*2");
      log("  → Fixing odd resolution: " + probe.width + "x" + probe.height);
    }

    // Convert HDR to SDR with tonemapping
    if (probe.isHDR) {
      filters.push("zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p");
      log("  → Converting HDR to SDR");
    } else if (probe.pixFmt !== "yuv420p") {
      filters.push("format=yuv420p");
      log("  → Converting pixel format: " + probe.pixFmt + " → yuv420p");
    }

    // Fix variable frame rate
    if (probe.isVFR) {
      const targetFps = Math.min(probe.fps || 30, 60); // cap at 60fps
      filters.push("fps=" + targetFps);
      log("  → Fixing VFR → " + targetFps + "fps CFR");
    }

    const args = ["-y", "-i", inputPath];

    // Video filtering
    if (filters.length > 0) {
      args.push("-vf", filters.join(","));
    }

    // Video codec
    args.push("-c:v", "libx264", "-preset", "fast", "-crf", "23");

    // Audio: always re-encode to AAC for compatibility
    if (probe.hasAudio) {
      args.push("-c:a", "aac", "-b:a", "128k", "-ac", "2"); // stereo AAC
    } else {
      args.push("-an");
    }

    args.push(
      "-movflags", "+faststart",
      "-map_metadata", "-1",       // strip metadata (avoid rotation double-apply)
      "-map", "0:v:0",             // first video stream only
    );
    if (probe.hasAudio) {
      args.push("-map", "0:a:0?"); // first audio stream only (optional)
    }
    args.push("-shortest", outputPath);

    log("  → Normalizing: " + probe.videoCodec + "/" + probe.audioCodec + " → h264/aac");

    const startTime = Date.now();
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("Normalization timed out after " + (NORMALIZE_TIMEOUT_MS / 1000) + "s"));
    }, NORMALIZE_TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (code !== 0) {
        log("  ✗ Normalize failed (" + elapsed + "s): " + stderr.slice(-400));
        return reject(new Error("Normalization failed (code " + code + "): " + stderr.slice(-200)));
      }
      // Verify output
      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) {
        return reject(new Error("Normalization produced empty output"));
      }
      log("  ✓ Normalized in " + elapsed + "s → " + (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1) + "MB");
      resolve();
    });

    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

// ============================================================
// Composite overlay PNG onto normalized video
//
// KEY FIX: Do NOT use -loop 1 or -shortest. When FFmpeg receives
// a single PNG as input #1, it automatically uses it as a still
// image overlay for the entire duration of input #0. The -loop 1
// flag creates an INFINITE video stream that confuses the muxer
// into producing 0-byte output with code null.
//
// format=yuv420p inside the filter chain strips the alpha channel
// from the overlay output before libx264 (which can't encode alpha).
// ============================================================
function compositeOverlay(videoPath, overlayPath, outputPath, videoWidth, videoHeight, hasAudio, log) {
  return new Promise((resolve, reject) => {
    const filterComplex = "[1:v]scale=" + videoWidth + ":" + videoHeight + "[ovr];[0:v][ovr]overlay=0:0,format=yuv420p";

    const args = [
      "-y",
      "-i", videoPath,
      "-i", overlayPath,
      "-filter_complex", filterComplex,
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "23",
      "-movflags", "+faststart",
    ];

    if (hasAudio) {
      args.push("-c:a", "aac", "-b:a", "128k");
    } else {
      args.push("-an");
    }

    args.push(outputPath);

    log("  → Compositing overlay at " + videoWidth + "x" + videoHeight);
    const startTime = Date.now();
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("Render timed out after " + (RENDER_TIMEOUT_MS / 1000) + "s"));
    }, RENDER_TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      // Accept code 0, or code null with valid output
      const outputExists = fs.existsSync(outputPath);
      const outputSize = outputExists ? fs.statSync(outputPath).size : 0;

      if (outputSize < 1000) {
        log("  ✗ Composite failed: output=" + outputSize + "bytes code=" + code);
        log("  stderr: " + stderr.slice(-500));
        return reject(new Error("Composite produced empty output (code " + code + "): " + stderr.slice(-200)));
      }

      log("  ✓ Composite done in " + elapsed + "s → " + (outputSize / 1024 / 1024).toFixed(1) + "MB");
      resolve({ elapsed: parseFloat(elapsed) });
    });

    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

// ============================================================
// Drawtext fallback (simple text, no PNG overlay)
// ============================================================
function compositeDrawtext(videoPath, outputPath, caption, hasAudio, log) {
  return new Promise((resolve, reject) => {
    const { text = "", fontSize = 42, fontColor = "white", bgColor = "black@0.6", position = "bottom", borderWidth = 2, borderColor = "black", paddingX = 20, paddingY = 10 } = caption;
    const escaped = text.replace(/\\/g, "\\\\\\\\").replace(/'/g, "'\\\\\\''").replace(/:/g, "\\\\:").replace(/%/g, "\\\\%").replace(/\n/g, "\\n");
    let yExpr;
    switch (position) { case "top": yExpr = "" + (paddingY + 20); break; case "center": yExpr = "(h-text_h)/2"; break; default: yExpr = "h-text_h-" + (paddingY + 40); break; }
    const filter = "drawtext=text='" + escaped + "':fontsize=" + fontSize + ":fontcolor=" + fontColor + ":borderw=" + borderWidth + ":bordercolor=" + borderColor + ":x=(w-text_w)/2:y=" + yExpr + ":box=1:boxcolor=" + bgColor + ":boxborderw=" + paddingX;

    const args = ["-y", "-i", videoPath, "-vf", filter + ",format=yuv420p"];
    if (hasAudio) { args.push("-c:a", "aac", "-b:a", "128k"); } else { args.push("-an"); }
    args.push("-c:v", "libx264", "-preset", "fast", "-crf", "23", "-movflags", "+faststart", "-shortest", outputPath);

    log("  → Drawtext fallback");
    const startTime = Date.now();
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    const timeout = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("Drawtext timed out")); }, RENDER_TIMEOUT_MS);
    proc.on("close", (code) => {
      clearTimeout(timeout);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (code !== 0) { return reject(new Error("Drawtext failed (code " + code + "): " + stderr.slice(-200))); }
      log("  ✓ Drawtext done in " + elapsed + "s");
      resolve({ elapsed: parseFloat(elapsed) });
    });
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

// ============================================================
// Cleanup helper
// ============================================================
function cleanup() {
  for (let i = 0; i < arguments.length; i++) {
    try { if (arguments[i] && fs.existsSync(arguments[i])) fs.unlinkSync(arguments[i]); } catch (e) {}
  }
}

// ============================================================
// POST /render — Main endpoint
//
// Accepts either:
//   { videoUrl, overlayImageBase64 }  — PNG overlay mode (preferred)
//   { videoUrl, caption: {...} }      — drawtext mode (fallback)
//
// Pipeline: download → probe → normalize (if needed) → composite → stream
// ============================================================
app.post("/render", async (req, res) => {
  const jobId = uuidv4().slice(0, 8);
  const log = (msg) => console.log("[" + jobId + "] " + msg);
  const startTotal = Date.now();

  // File paths for this job
  const inputPath = path.join(TEMP_DIR, jobId + "-input");
  const normalizedPath = path.join(TEMP_DIR, jobId + "-normalized.mp4");
  const overlayPath = path.join(TEMP_DIR, jobId + "-overlay.png");
  const outputPath = path.join(TEMP_DIR, jobId + "-output.mp4");

  try {
    const { videoUrl, overlayImageBase64, caption } = req.body;

    // --- Validate ---
    if (!videoUrl) return res.status(400).json({ error: "videoUrl is required" });
    if (!overlayImageBase64 && (!caption || !caption.text)) {
      return res.status(400).json({ error: "Either overlayImageBase64 or caption.text is required" });
    }

    const useOverlay = !!overlayImageBase64;
    log("═══ NEW RENDER JOB ═══");
    log("Mode: " + (useOverlay ? "OVERLAY-IMAGE" : "DRAWTEXT"));
    log("URL: " + videoUrl.substring(0, 100) + (videoUrl.length > 100 ? "..." : ""));

    // --- Step 1: Download ---
    log("Step 1: Downloading source video...");
    await downloadFile(videoUrl, inputPath);
    const inputSize = fs.statSync(inputPath).size;
    log("  ✓ Downloaded: " + (inputSize / 1024 / 1024).toFixed(1) + "MB");

    if (inputSize > MAX_FILE_SIZE_MB * 1024 * 1024) {
      cleanup(inputPath);
      return res.status(400).json({ error: "File too large: " + (inputSize / 1024 / 1024).toFixed(0) + "MB (max " + MAX_FILE_SIZE_MB + "MB)" });
    }

    // --- Step 2: Probe ---
    log("Step 2: Probing video...");
    let probe;
    try {
      probe = await probeVideo(inputPath);
    } catch (probeErr) {
      cleanup(inputPath);
      return res.status(400).json({
        error: "Could not read video file. It may be corrupt or in an unsupported format.",
        detail: probeErr.message,
      });
    }

    log("  Format: " + probe.formatName);
    log("  Video: " + probe.videoCodec + " " + probe.width + "x" + probe.height + " " + probe.fps + "fps" + (probe.isVFR ? " (VFR)" : ""));
    log("  Audio: " + probe.audioCodec);
    log("  Duration: " + probe.duration.toFixed(1) + "s");
    log("  Display: " + probe.displayWidth + "x" + probe.displayHeight + (probe.isRotated ? " (rotated " + probe.rotation + "°)" : ""));
    log("  HDR: " + probe.isHDR + " | Odd res: " + probe.isOddRes + " | Needs normalize: " + probe.needsNormalization);

    if (probe.duration > MAX_VIDEO_DURATION_SEC) {
      cleanup(inputPath);
      return res.status(400).json({ error: "Video is " + probe.duration.toFixed(0) + "s — max allowed is " + MAX_VIDEO_DURATION_SEC + "s" });
    }

    // Use display dimensions (after rotation) for overlay
    const renderWidth = probe.displayWidth;
    const renderHeight = probe.displayHeight;

    // --- Step 3: Normalize (if needed) ---
    let videoForComposite = inputPath;

    if (probe.needsNormalization) {
      log("Step 3: Normalizing video...");
      await normalizeVideo(inputPath, normalizedPath, probe, log);
      videoForComposite = normalizedPath;
    } else {
      log("Step 3: Skipped — video is already clean H.264/AAC/yuv420p");
    }

    // --- Step 4: Composite ---
    log("Step 4: Compositing...");

    if (useOverlay) {
      // Decode and save overlay PNG
      let b64 = overlayImageBase64;
      if (b64.includes(",")) b64 = b64.split(",")[1];
      const pngBuffer = Buffer.from(b64, "base64");
      fs.writeFileSync(overlayPath, pngBuffer);
      log("  Overlay PNG: " + (pngBuffer.length / 1024).toFixed(0) + "KB");

      // Make sure dimensions are even for h264
      const safeWidth = renderWidth % 2 === 0 ? renderWidth : renderWidth + 1;
      const safeHeight = renderHeight % 2 === 0 ? renderHeight : renderHeight + 1;

      await compositeOverlay(videoForComposite, overlayPath, outputPath, safeWidth, safeHeight, probe.hasAudio, log);
    } else {
      await compositeDrawtext(videoForComposite, outputPath, caption, probe.hasAudio, log);
    }

    // --- Step 5: Validate and stream ---
    if (!fs.existsSync(outputPath)) throw new Error("Output file was not created");
    const outSize = fs.statSync(outputPath).size;
    if (outSize < 1000) throw new Error("Output file is empty (" + outSize + " bytes)");

    const totalElapsed = ((Date.now() - startTotal) / 1000).toFixed(1);
    log("Step 5: Streaming result");
    log("  Output: " + (outSize / 1024 / 1024).toFixed(1) + "MB");
    log("  Total time: " + totalElapsed + "s");
    log("═══ JOB COMPLETE ═══\n");

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", outSize);
    res.setHeader("Content-Disposition", 'attachment; filename="captioned-' + jobId + '.mp4"');
    res.setHeader("X-Job-Id", jobId);
    res.setHeader("X-Render-Mode", useOverlay ? "overlay-image" : "drawtext");
    res.setHeader("X-Total-Time", totalElapsed + "s");
    res.setHeader("X-Normalized", String(probe.needsNormalization));
    res.setHeader("X-Source-Codec", probe.videoCodec);

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on("end", () => cleanup(inputPath, normalizedPath, overlayPath, outputPath));
    stream.on("error", (err) => {
      log("Stream error: " + err.message);
      cleanup(inputPath, normalizedPath, overlayPath, outputPath);
      if (!res.headersSent) res.status(500).json({ error: "Stream failed" });
    });

  } catch (err) {
    const totalElapsed = ((Date.now() - startTotal) / 1000).toFixed(1);
    log("✗ FAILED after " + totalElapsed + "s: " + err.message);
    cleanup(inputPath, normalizedPath, overlayPath, outputPath);

    if (!res.headersSent) {
      // User-friendly error messages
      let userMessage = err.message;
      if (err.message.includes("timed out")) {
        userMessage = "Processing took too long. Try with a shorter video (under " + MAX_VIDEO_DURATION_SEC + " seconds).";
      } else if (err.message.includes("HTTP 4")) {
        userMessage = "Could not download the video. The URL may have expired — try re-uploading.";
      } else if (err.message.includes("No video stream")) {
        userMessage = "The uploaded file does not contain a video stream. Please upload a valid video file.";
      } else if (err.message.includes("corrupt")) {
        userMessage = "The video file appears to be corrupt. Try re-recording or re-exporting it.";
      }

      res.status(500).json({ error: userMessage, detail: err.message, jobId });
    }
  }
});

// ============================================================
// GET /download/:jobId — Serve batch-rendered files
// ============================================================
app.get("/download/:jobId", (req, res) => {
  const fp = path.join(TEMP_DIR, req.params.jobId + "-output.mp4");
  if (!fs.existsSync(fp)) return res.status(404).json({ error: "File not found or expired (files expire after 10 minutes)" });
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", 'attachment; filename="captioned-' + req.params.jobId + '.mp4"');
  fs.createReadStream(fp).pipe(res);
});

// ============================================================
// Periodic cleanup — remove stale temp files every 5 min
// ============================================================
setInterval(() => {
  if (!fs.existsSync(TEMP_DIR)) return;
  const now = Date.now();
  let cleaned = 0;
  for (const f of fs.readdirSync(TEMP_DIR)) {
    const fp = path.join(TEMP_DIR, f);
    try {
      if (now - fs.statSync(fp).mtimeMs > 10 * 60 * 1000) {
        fs.unlinkSync(fp);
        cleaned++;
      }
    } catch (e) {}
  }
  if (cleaned > 0) console.log("[cleanup] Removed " + cleaned + " stale temp files");
}, 5 * 60 * 1000);

// ============================================================
// Start
// ============================================================
app.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("╔═══════════════════════════════════════╗");
  console.log("║  Caption Render Server v3.3.0         ║");
  console.log("║  Port: " + PORT + "                            ║");
  console.log("║                                       ║");
  console.log("║  Supported: MP4, MOV, WebM, MKV, AVI  ║");
  console.log("║  Codecs: H.264, HEVC, VP9, AV1, AAC   ║");
  console.log("║  Fixes: VFR, HDR, rotation, odd-res   ║");
  console.log("╚═══════════════════════════════════════╝");
  console.log("");
});
