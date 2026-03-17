# Build stage — install dependencies in full Node.js image
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY . .

# Runtime stage — truly distroless (no shell, no package manager)
FROM cgr.dev/chainguard/node:latest
WORKDIR /app
COPY --from=build /app /app

# The workspace (skills-BP) is mounted as a volume at /workspace
# The config (.env, config.json overrides) is mounted at /config
ENV CSKILLBP_DIR=/workspace

# pipeline-utils.js resolves CSKILLBP_DIR from env var (fallback: ../../cSkillBP symlink)
# With CSKILLBP_DIR set above, the symlink is no longer needed

# Redirect Claude config/auth to a path we'll mount as a volume
ENV CLAUDE_CONFIG_DIR=/claude-config

# Don't let the container auto-update the binary — image is source of truth
ENV DISABLE_AUTOUPDATER=1

# Chainguard runs as nonroot (uid 65532) by default
# Override with user: "1001" in docker-compose.yml if volume permissions require it

CMD ["src/index.js"]
