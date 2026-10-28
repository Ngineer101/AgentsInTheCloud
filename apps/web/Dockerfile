ARG ATELIER_RUNTIME_IMAGE=ghcr.io/lucasmeijer/agents-in-the-cloud-docker@sha256:aad5d19c57d57e670508b44e4cbf9cb3f41082e92c1a1e09858f35010b39a820
FROM oven/bun:1.4.4 AS bun-dist

FROM ubuntu:26.04 AS transcription-runtime
ARG TARGETARCH
ARG NEMO_SPEECH_VERSION=0.1.0
COPY packages/dictation/install-runtime.sh /tmp/install-transcription-runtime.sh
RUN sh /tmp/install-transcription-runtime.sh "$TARGETARCH" "$NEMO_SPEECH_VERSION"

FROM ubuntu:26.04 AS deps
ARG DEBIAN_FRONTEND=noninteractive
COPY --from=bun-dist /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun-dist /usr/local/bin/bunx /usr/local/bin/bunx
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates
WORKDIR /app

# Development's helper binary stays out; each platform's is copied below.
COPY --exclude=packages/workspace-helper/dist --exclude=packages/workspace-helper/workspace_tools . .

# Claude Code runs in workspaces; the Agent SDK's bundled platform binaries are never used here.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile \
    && rm -rf node_modules/.bun/@anthropic-ai+claude-agent-sdk-*

FROM deps AS build
RUN bun run --cwd apps/web build:client

FROM ${ATELIER_RUNTIME_IMAGE} AS runtime
ARG DEBIAN_FRONTEND=noninteractive
WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      git-lfs \
      gosu \
      libcap2-bin \
      openssh-client \
      sudo \
      socat \
      util-linux \
      tmux

# Template clones of entire:// repositories run here, through Entire's git remote helper.
ARG TARGETARCH
RUN set -eux; entire_version=0.12.2; \
    case "$TARGETARCH" in amd64) entire_sha256=bfc5c8d5b599f328775b89b735db020c963e307b6a324fc30ce371fe8fa789e8 ;; arm64) entire_sha256=f08a1b8c6352d3f78076268dc67b0b273d7f62dbab94b15aec028e7b4257ad0c ;; *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; esac; \
    curl -fsSL "https://github.com/entireio/cli/releases/download/v${entire_version}/entire_linux_${TARGETARCH}.tar.gz" -o /tmp/entire.tar.gz; \
    echo "${entire_sha256}  /tmp/entire.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/entire.tar.gz -C /usr/local/bin git-remote-entire; \
    rm /tmp/entire.tar.gz; \
    git-remote-entire --version

COPY --from=bun-dist /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun-dist /usr/local/bin/bunx /usr/local/bin/bunx
RUN setcap cap_net_bind_service=+ep /usr/local/bin/bun
COPY --from=transcription-runtime /opt/nemo-speech /opt/nemo-speech
RUN ln -s /opt/nemo-speech/bin/nemo-speech /usr/local/bin/nemo-speech

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV ATELIER_NAMESPACE=default
ENV ATELIER_DATA_DIR=/data/app

COPY --from=deps /app/node_modules /app/node_modules
COPY --from=build --exclude=node_modules /app /app
# Built beforehand with local Go by scripts/build-agents-in-the-cloud-image.ts.
COPY packages/workspace-helper/dist/linux-${TARGETARCH}/aitc-workspace-helper /app/packages/workspace-helper/workspace_tools/aitc-workspace-helper
RUN printf '%s\n' '#!/usr/bin/env sh' 'exec /usr/local/bin/bun /app/packages/proxy-ingress/src/ingress/tailscale-serve-helper.ts "$@"' > /usr/local/bin/agents-in-the-cloud-tailscale-serve-helper \
 && chmod 755 /usr/local/bin/agents-in-the-cloud-tailscale-serve-helper /app/apps/web/docker-entrypoint.sh

ARG ATELIER_COMMIT_ID
ARG ATELIER_DEFAULT_WORKSPACE_IMAGE
ARG ATELIER_EAGERLY_PRELOAD="[]"
ENV ATELIER_COMMIT_ID=${ATELIER_COMMIT_ID}
LABEL org.opencontainers.image.source="https://github.com/lucasmeijer/atelier" \
      org.opencontainers.image.revision="${ATELIER_COMMIT_ID}" \
      eagerly-preload="${ATELIER_EAGERLY_PRELOAD}"
RUN printf '%s\n' "$ATELIER_DEFAULT_WORKSPACE_IMAGE" > /app/.agents-in-the-cloud-default-workspace-image

EXPOSE 3000

ENTRYPOINT ["/app/apps/web/docker-entrypoint.sh"]
CMD ["bun", "run", "apps/web/src/server/main.ts"]
