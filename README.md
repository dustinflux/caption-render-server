# Caption Render Server

Fast server-side video caption overlay using native FFmpeg. Designed to connect to a Lovable-built frontend app.

## What it does
- Accepts a video URL + caption text/style
- Downloads the video
- Burns the caption onto the video using FFmpeg (10-50x faster than browser-based FFmpeg/WASM)
- Returns the processed video file

## Endpoints

### `GET /health`
Health check. Returns server status.

### `POST /render`
Render a single video with caption overlay.

```json
{
  "videoUrl": "https://example.com/video.mp4",
  "caption": {
    "text": "Your caption text here",
    "fontSize": 42,
    "fontColor": "white",
    "bgColor": "black@0.6",
    "position": "bottom",
    "borderWidth": 2,
    "borderColor": "black",
    "paddingX": 20,
    "paddingY": 10
  }
}
```

Returns: The rendered MP4 file as a download.

### `POST /render/batch`
Render multiple videos in parallel (up to 20, 4 concurrent).

```json
{
  "videos": [
    { "videoUrl": "https://...", "caption": { "text": "Cap 1", ... } },
    { "videoUrl": "https://...", "caption": { "text": "Cap 2", ... } }
  ]
}
```

Returns: JSON with download URLs for each video.

### `GET /download/:jobId`
Download a batch-rendered video. Links expire after 5 minutes.

## Deploy to Railway

1. Push this repo to GitHub
2. Go to https://railway.app
3. Click "New Project" → "Deploy from GitHub repo"
4. Select this repo
5. Railway auto-detects the Dockerfile and deploys
6. Add env var: `ALLOWED_ORIGINS=https://your-lovable-app.lovable.app`
7. Done — your server URL will be something like `https://caption-render-server-production.up.railway.app`

## Local Development

```bash
npm install
node server.js
```

Requires FFmpeg installed locally (`brew install ffmpeg` on Mac, `apt install ffmpeg` on Linux).
