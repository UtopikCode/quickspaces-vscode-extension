FROM mcr.microsoft.com/devcontainers/typescript-node:1-20-bullseye

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libnspr4 libnss3 libdbus-1-3 libgconf-2-4 libgtk-3-0 libxss1 \
      libx11-6 libxext6 libgbm1 libegl1-mesa libdrm2 libasound2 \
      xvfb dbus && \
    rm -rf /var/lib/apt/lists/*

ADD .npmrc /home/node/.npmrc
