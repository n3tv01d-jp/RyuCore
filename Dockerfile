# RyuCore 竜核 — AI command core.
# Node.js (npx) and uv (uvx) are included so stdio MCP servers such as
# `npx -y @modelcontextprotocol/server-filesystem` or `uvx mcp-server-fetch` run inside the container.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 RYU_DATA=/data RYU_PORT=8090 \
    NPM_CONFIG_UPDATE_NOTIFIER=false
RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs npm git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
COPY app/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt
RUN useradd -m -u 1000 ryu && mkdir -p /data && chown ryu:ryu /data
WORKDIR /app
COPY app/ .
USER ryu
EXPOSE 8090
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["python", "healthcheck.py"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "main.py"]
