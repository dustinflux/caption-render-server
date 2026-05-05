FROM node:20-slim

# Install FFmpeg with ALL common codecs
# The default Debian ffmpeg package includes:
# h264/libx264 (encode+decode), hevc/h265 (decode), vp8/vp9 (decode),
# aac (encode+decode), mp3, opus, and more.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      && rm -rf /var/lib/apt/lists/*

# Verify FFmpeg and key codecs
RUN ffmpeg -version && \
    echo "--- Checking codecs ---" && \
    ffmpeg -codecs 2>/dev/null | grep -E "libx264|hevc|vp9|aac" && \
    echo "--- All critical codecs available ---"

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY . .

RUN mkdir -p /app/tmp

EXPOSE ${PORT:-3001}

CMD ["node", "server.js"]
