FROM python:3.12-slim

# The Docker CLI is only used when DRIVE_SOURCE=docker:<container>:<path> — an
# existing install whose documents still live inside the server container.
# Fresh installs read the shared volume and never touch Docker.
ARG DOCKER_VERSION=27.3.1
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz" -o /tmp/docker.tgz \
 && tar -xzf /tmp/docker.tgz -C /tmp \
 && mv /tmp/docker/docker /usr/local/bin/docker \
 && chmod +x /usr/local/bin/docker \
 && rm -rf /tmp/docker /tmp/docker.tgz \
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
      google-api-python-client==2.149.0 \
      google-auth==2.35.0 \
      google-auth-httplib2==0.2.0

WORKDIR /app
COPY scripts/drive-sync/drive_sync.py /app/drive_sync.py

# Mount the platform's files at /data/files (shared volume) — or set
# DRIVE_SOURCE=docker:<container>:<path> and mount /var/run/docker.sock.
VOLUME ["/data/files"]

ENV DRIVE_SOURCE=/data/files \
    DRIVE_INTERVAL=600 \
    PYTHONUNBUFFERED=1

CMD ["python", "/app/drive_sync.py"]
