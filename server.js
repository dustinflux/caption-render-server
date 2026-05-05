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
const MAX_VIDEO_DURATION_SEC = 120;
const RENDER_TIMEOUT_MS = 90000;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim())
  : ["*"];

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

app.use(
  cors({
    origin: (origin, cb) => cb(null, true),
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json({ limit: "200mb" }));

app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "2.1.0", ffmpeg: true, uptime: process.uptime(), features: ["overlay-image-rgba", "drawtext", "batch"] });
});

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(destPath);
    proto.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close(); fs.unlinkSync(destPath);
        return downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        file.close(); fs.unlinkSync(destPath);
        return reject(new Error("Download failed: HTTP " + response.statusCode));
      }
      response.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", (err) => { file.close(); if (fs.existsSync(destPath)) fs.unlinkSync(destPath); reject(err); });
  });
}

function probeVideo(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath]);
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error("ffprobe failed: " + stderr));
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error("Parse failed")); }
    });
  });
}

function renderWithOverlayImage(inputPath, overlayPath, outputPath, videoWidth, videoHeight) {
  return new Promise((resolve, reject) => {
    // Force overlay PNG to RGBA so alpha compositing works, then convert final output to yuv420p for h264
    const filterComplex = `[1:v]scale=${videoWidth}:${videoHeight}:flags=lanczos,format=rgba[ovr];[0:v]format=rgba[base];[base][ovr]overlay=0:0,format=yuv420p`;
    const args = ["-y", "-i", inputPath, "-i", overlayPath, "-filter_complex", filterComplex, "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-c:a", "copy", "-movflags", "+faststart", outputPath];
    console.log("[render] Overlay image mode: " + videoWidth + "x" + videoHeight);
    const startTime = Date.now();
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    const timeout = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("Render timed out")); }, RENDER_TIMEOUT_MS);
    proc.on("close", (code) => {
      clearTimeout(timeout);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (code !== 0) { console.error("[render] Overlay failed (" + elapsed + "s): " + stderr.slice(-500)); return reject(new Error("FFmpeg code " + code + ": " + stderr.slice(-200))); }
      console.log("[render] Overlay done in " + elapsed + "s");
      resolve({ elapsed: parseFloat(elapsed) });
    });
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

function renderWithDrawtext(inputPath, outputPath, caption) {
  return new Promise((resolve, reject) => {
    const { text = "", fontSize = 42, fontColor = "white", bgColor = "black@0.6", position = "bottom", borderWidth = 2, borderColor = "black", paddingX = 20, paddingY = 10 } = caption;
    const escaped = text.replace(/\\/g, "\\\\\\\\").replace(/'/g, "'\\\\\\''").replace(/:/g, "\\\\:").replace(/%/g, "\\\\%").replace(/\n/g, "\\n");
    let yExpr;
    switch (position) { case "top": yExpr = "" + (paddingY + 20); break; case "center": yExpr = "(h-text_h)/2"; break; default: yExpr = "h-text_h-" + (paddingY + 40); break; }
    const filter = "drawtext=text='" + escaped + "':fontsize=" + fontSize + ":fontcolor=" + fontColor + ":borderw=" + borderWidth + ":bordercolor=" + borderColor + ":x=(w-text_w)/2:y=" + yExpr + ":box=1:boxcolor=" + bgColor + ":boxborderw=" + paddingX + ":line_spacing=8";
    const args = ["-y", "-i", inputPath, "-vf", filter, "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-c:a", "copy", "-movflags", "+faststart", "-pix_fmt", "yuv420p", outputPath];
    console.log("[render] Drawtext mode");
    const startTime = Date.now();
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    const timeout = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("Render timed out")); }, RENDER_TIMEOUT_MS);
    proc.on("close", (code) => {
      clearTimeout(timeout);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (code !== 0) { console.error("[render] Drawtext failed (" + elapsed + "s): " + stderr.slice(-500)); return reject(new Error("FFmpeg code " + code + ": " + stderr.slice(-200))); }
      console.log("[render] Drawtext done in " + elapsed + "s");
      resolve({ elapsed: parseFloat(elapsed) });
    });
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

function cleanup() { for (const f of arguments) { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {} } }

app.post("/render", async (req, res) => {
  const jobId = uuidv4().slice(0, 8);
  const log = (msg) => console.log("[job:" + jobId + "] " + msg);
  let inputPath = null, outputPath = null, overlayPath = null;
  try {
    const { videoUrl, overlayImageBase64, caption } = req.body;
    if (!videoUrl) return res.status(400).json({ error: "videoUrl is required" });
    if (!overlayImageBase64 && (!caption || !caption.text)) return res.status(400).json({ error: "overlayImageBase64 or caption.text required" });
    const useOverlay = !!overlayImageBase64;
    log("Mode: " + (useOverlay ? "OVERLAY-IMAGE" : "DRAWTEXT"));
    inputPath = path.join(TEMP_DIR, jobId + "-input.mp4");
    outputPath = path.join(TEMP_DIR, jobId + "-output.mp4");
    log("Downloading...");
    await downloadFile(videoUrl, inputPath);
    log("Downloaded: " + (fs.statSync(inputPath).size / 1024 / 1024).toFixed(1) + "MB");
    let videoWidth = 1080, videoHeight = 1920;
    try {
      const probe = await probeVideo(inputPath);
      const vs = probe.streams?.find((s) => s.codec_type === "video");
      if (vs) { videoWidth = vs.width || 1080; videoHeight = vs.height || 1920; }
      const dur = parseFloat(probe.format?.duration || "0");
      log("Video: " + videoWidth + "x" + videoHeight + " " + dur.toFixed(1) + "s");
      if (dur > MAX_VIDEO_DURATION_SEC) { cleanup(inputPath); return res.status(400).json({ error: "Video too long: " + dur.toFixed(0) + "s" }); }
    } catch (e) { log("Probe warn: " + e.message); }
    if (useOverlay) {
      overlayPath = path.join(TEMP_DIR, jobId + "-overlay.png");
      let b64 = overlayImageBase64;
      if (b64.includes(",")) b64 = b64.split(",")[1];
      fs.writeFileSync(overlayPath, Buffer.from(b64, "base64"));
      log("Overlay PNG: " + (fs.statSync(overlayPath).size / 1024).toFixed(0) + "KB");
      await renderWithOverlayImage(inputPath, overlayPath, outputPath, videoWidth, videoHeight);
    } else {
      await renderWithDrawtext(inputPath, outputPath, caption);
    }
    const stat = fs.statSync(outputPath);
    log("Output: " + (stat.size / 1024 / 1024).toFixed(1) + "MB");
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", 'attachment; filename="captioned-' + jobId + '.mp4"');
    res.setHeader("X-Job-Id", jobId);
    res.setHeader("X-Render-Mode", useOverlay ? "overlay-image" : "drawtext");
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on("end", () => cleanup(inputPath, outputPath, overlayPath));
    stream.on("error", (err) => { cleanup(inputPath, outputPath, overlayPath); if (!res.headersSent) res.status(500).json({ error: "Stream failed" }); });
  } catch (err) {
    log("Error: " + err.message);
    cleanup(inputPath, outputPath, overlayPath);
    if (!res.headersSent) res.status(500).json({ error: err.message, jobId });
  }
});

app.get("/download/:jobId", (req, res) => {
  const fp = path.join(TEMP_DIR, req.params.jobId + "-output.mp4");
  if (!fs.existsSync(fp)) return res.status(404).json({ error: "File expired" });
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", 'attachment; filename="captioned-' + req.params.jobId + '.mp4"');
  fs.createReadStream(fp).pipe(res);
});

setInterval(() => {
  if (!fs.existsSync(TEMP_DIR)) return;
  const now = Date.now(); let cleaned = 0;
  for (const f of fs.readdirSync(TEMP_DIR)) {
    const fp = path.join(TEMP_DIR, f);
    try { if (now - fs.statSync(fp).mtimeMs > 10 * 60 * 1000) { fs.unlinkSync(fp); cleaned++; } } catch (e) {}
  }
  if (cleaned > 0) console.log("[cleanup] Removed " + cleaned + " stale files");
}, 10 * 60 * 1000);

app.listen(PORT, "0.0.0.0", () => {
  console.log("\n===================================");
  console.log("  Caption Render Server v2.1.0");
  console.log("  Port: " + PORT);
  console.log("  Features: overlay-image, drawtext");
  console.log("===================================\n");
});
