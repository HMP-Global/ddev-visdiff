FROM mcr.microsoft.com/playwright:v1.60.0-noble

USER root

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    default-mysql-client \
    git \
    libnss-wrapper \
    openssh-client \
    php-cli \
    php-curl \
    php-mbstring \
    php-xml \
    php-zip \
    postgresql-client \
    rsync \
    unzip \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://raw.githubusercontent.com/platformsh/cli/main/installer.sh | INSTALL_METHOD=raw INSTALL_DIR=/usr/local/bin bash
