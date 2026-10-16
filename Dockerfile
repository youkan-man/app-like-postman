FROM python:3.12-slim

WORKDIR /app
COPY app.py network.py .
COPY static ./static

ENV MINIPOST_CONTAINER=1
EXPOSE 8080
CMD ["python", "app.py"]
