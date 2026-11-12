FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 TZ=America/Sao_Paulo
# tzdata: sem ele o TZ é ignorado e o sistema grava datas/horas em UTC (3 h à frente do Brasil)
RUN apt-get update && apt-get install -y --no-install-recommends tzdata && rm -rf /var/lib/apt/lists/*
RUN useradd --system --uid 10001 --home /app nexarpay
WORKDIR /app
COPY server.py ./
COPY static ./static
RUN mkdir -p /app/data && chown -R nexarpay:nexarpay /app/data
USER nexarpay
EXPOSE 8765
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8765/')" || exit 1
CMD ["python", "server.py"]
