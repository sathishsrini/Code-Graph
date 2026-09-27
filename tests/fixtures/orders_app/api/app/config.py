import os

DATABASE_URL = os.environ["DATABASE_URL"]
PAYMENT_URL = os.getenv("PAYMENT_URL", "http://localhost:8080")
KAFKA_BROKERS = os.getenv("KAFKA_BROKERS", "localhost:9092")
