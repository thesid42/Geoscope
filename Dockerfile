FROM node:24-alpine AS frontend
WORKDIR /frontend
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY --from=frontend /frontend/dist ./web/dist
COPY data/real ./data/real
COPY data/real-nyc ./data/real-nyc
COPY data/real-nyc-land ./data/real-nyc-land
COPY data/real-scenario ./data/real-scenario
RUN useradd --uid 10001 --create-home app \
    && mkdir -p /data \
    && chown -R app:app /app /data
USER app
ENV APP_DATA_DIR=/data
EXPOSE 8000
CMD ["uvicorn", "app.controller:app", "--host", "0.0.0.0", "--port", "8000"]
