FROM python:3.12-slim
WORKDIR /srv
COPY . .
RUN pip install fastapi uvicorn sqlalchemy requests kafka-python
ENV PORT=8000
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
