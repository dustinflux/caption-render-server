FROM node:20-slim

# Install FFmpeg (the whole reason this server exists)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Verify FFmpeg installed
RUN ffmpeg -version

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy server code
COPY . .

# Create temp directory
RUN mkdir -p /app/tmp

# Railway sets PORT env var automatically
EXPOSE ${PORT:-3001}

CMD ["node", "server.js"]
