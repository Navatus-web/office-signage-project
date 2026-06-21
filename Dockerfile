FROM node:20-alpine

# Create app directory inside container
WORKDIR /app

# Copy dependency files first (better caching)
COPY package*.json ./

# Install dependencies from the lockfile for reproducible builds
RUN npm ci --omit=dev

# Copy the rest of the project
COPY . .

# App runs on port 3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

# Start the app
CMD ["npm", "start"]
