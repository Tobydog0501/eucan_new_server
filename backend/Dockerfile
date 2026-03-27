FROM node:20 AS builder

ENV GECKODRIVER_VERSION=v0.33.0

WORKDIR /app
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        wget \
    && rm -rf /var/lib/apt/lists/* \
    && wget -O /tmp/geckodriver.tar.gz https://github.com/mozilla/geckodriver/releases/download/${GECKODRIVER_VERSION}/geckodriver-${GECKODRIVER_VERSION}-linux64.tar.gz \
    && tar -xzf /tmp/geckodriver.tar.gz -C /usr/local/bin/ \
    && chmod +x /usr/local/bin/geckodriver \
    && rm /tmp/geckodriver.tar.gz

COPY ["package.json", "package-lock.json*", "./"]
RUN npm update -g \
  && npm install

COPY . .
RUN npx tsc

FROM node:20-slim
WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        firefox-esr \
        fonts-liberation \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libc6 \
        libcairo2 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libexpat1 \
        libfontconfig1 \
        libgbm1 \
        libgcc1 \
        libglib2.0-0 \
        libgtk-3-0 \
        libnspr4 \
        libnss3 \
        libpango-1.0-0 \
        libx11-6 \
        libx11-xcb1 \
        libxcb1 \
        libxcomposite1 \
        libxcursor1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxi6 \
        libxrandr2 \
        libxrender1 \
        libxss1 \
        libxtst6 \
        lsb-release \
        xdg-utils \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/build /app/package.json .
COPY --from=builder /usr/local/bin/geckodriver /usr/local/bin/geckodriver
RUN npm install
COPY --from=builder --exclude=src/ --exclude=build/ --exclude=node_modules /app .

EXPOSE 3000
ENV TZ Asia/Taipei
CMD [ "node","main.js" ]