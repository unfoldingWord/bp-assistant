FROM node:22-slim

# System deps: Python 3, pip, git, curl (for Zulip shell helpers)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Python deps (requests is the only non-stdlib import in skills-BP scripts)
RUN pip3 install --break-system-packages requests

# Create non-root user with uid 1001 (matches host ubuntu user for volume permissions)
# Claude Code refuses bypassPermissions as root
RUN useradd -m -s /bin/bash -u 1001 botuser

# Install Claude Code CLI as botuser
USER botuser
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/botuser/.local/bin:${PATH}"
USER root

# Redirect Claude config/auth to a path we'll mount as a volume
ENV CLAUDE_CONFIG_DIR=/claude-config
RUN mkdir -p /claude-config && chown botuser:botuser /claude-config

# Don't let the container auto-update the binary — image is source of truth
ENV DISABLE_AUTOUPDATER=1

# Bot application
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY . .

# The workspace (skills-BP) is mounted as a volume at /workspace
# The config (.env, config.json overrides) is mounted at /config

# generate.sh resolves workspace as ../../cSkillBP relative to /app/pipelines/
# That resolves to /cSkillBP — symlink it to the mounted workspace
RUN ln -s /workspace /cSkillBP

# Ensure botuser owns app files and can write to data dir
RUN chown -R botuser:botuser /app

# Run as non-root so Claude Code allows bypassPermissions
USER botuser

CMD ["node", "src/index.js"]
