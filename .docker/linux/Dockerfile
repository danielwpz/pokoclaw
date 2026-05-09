FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get -o Acquire::Retries=5 update \
  && apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
    bash \
    bubblewrap \
    ca-certificates \
    g++ \
    git \
    make \
    procps \
    python3 \
    ripgrep \
    socat \
  && rm -rf /var/lib/apt/lists/* \
  && chmod u+s /usr/bin/bwrap

RUN npm install -g pnpm@10.15.0 \
  && useradd -m -s /bin/bash tester \
  && mkdir -p /work \
  && chown tester:tester /work

USER tester
WORKDIR /work

ENV PNPM_HOME=/home/tester/.local/share/pnpm
ENV PATH=/home/tester/.local/share/pnpm:$PATH
ENV npm_config_cache=/home/tester/.npm
ENV npm_config_store_dir=/home/tester/.local/share/pnpm/store
