import json

from kafka import KafkaProducer

from app.config import KAFKA_BROKERS

_producer = KafkaProducer(bootstrap_servers=KAFKA_BROKERS)


def publish(topic, payload):
    _producer.send(topic, json.dumps(payload).encode("utf-8"))
    _producer.flush()
