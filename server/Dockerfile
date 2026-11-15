FROM nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    MODELS_DIR=/models DATA_DIR=/data HF_HOME=/models/hf \
    PATH=/opt/venv/bin:$PATH

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv python3-pip ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv \
    && groupadd --gid 10001 eventscribe \
    && useradd --uid 10001 --gid 10001 --create-home eventscribe \
    && mkdir -p /models /data /app \
    && chown eventscribe:eventscribe /models /data /app

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY --chown=eventscribe:eventscribe app/ ./app/
USER eventscribe
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3).close()"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-server-header", "--no-proxy-headers"]
