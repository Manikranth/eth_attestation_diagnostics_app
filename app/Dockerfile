FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir requests==2.32.3 rich==13.9.4
COPY attmon.py .
ENTRYPOINT ["python", "-u", "attmon.py"]
