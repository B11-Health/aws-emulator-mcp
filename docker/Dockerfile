# Independent AWS Emulator MCP image built from the official signed AWS Emulator package.
FROM ubuntu:24.04
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends python3 python3-venv ca-certificates curl gnupg dpkg-dev findutils \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --create-home --shell /usr/sbin/nologin emulatormcp
RUN python3 -m venv /opt/aws-emulator-mcp-venv \
 && /opt/aws-emulator-mcp-venv/bin/python -m pip install --no-cache-dir --only-binary=:all: botocore==1.44.2
ENV HOME=/home/emulatormcp PYTHONUNBUFFERED=1 PYTHONPATH=/opt/aws-emulator-mcp/src AWS_EMULATOR_PORT=9297 \
 AWS_EMULATOR_MCP_ISOLATED_LAB=1 PATH=/opt/aws-emulator-mcp-venv/bin:$PATH
WORKDIR /opt/aws-emulator-mcp
COPY --chown=10001:10001 src/aws_emulator_mcp ./src/aws_emulator_mcp
COPY --chown=10001:10001 scripts/install_wsl.sh ./scripts/install_wsl.sh
COPY --chown=10001:10001 docker/entrypoint.sh ./docker/entrypoint.sh
USER 10001:10001
# Verify the official AWS publisher fingerprint and detached package signature first.
RUN bash scripts/install_wsl.sh \
 && python3 -m compileall -q src \
 && /home/emulatormcp/.local/bin/aws-emulator --version
LABEL org.opencontainers.image.source="https://github.com/B11-Health/aws-emulator-mcp" \
      org.opencontainers.image.title="AWS Emulator MCP" \
      org.opencontainers.image.vendor="B11-Health"
ENTRYPOINT ["bash", "docker/entrypoint.sh"]
CMD ["mcp"]
