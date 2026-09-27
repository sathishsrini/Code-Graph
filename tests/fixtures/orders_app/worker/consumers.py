import json
import os

from kafka import KafkaConsumer

consumer = KafkaConsumer("order.created", bootstrap_servers=os.environ["KAFKA_BROKERS"])


def send_receipt_email(order_id, total):
    print(f"receipt for order {order_id}: {total}")


def handle_order_created(message):
    event = json.loads(message.value)
    send_receipt_email(event["order_id"], event["total"])


def run():
    for message in consumer:
        handle_order_created(message)
