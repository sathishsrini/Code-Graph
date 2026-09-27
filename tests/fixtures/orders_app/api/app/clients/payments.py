import requests

from app.config import PAYMENT_URL


def charge_card(customer_id, amount):
    resp = requests.post(
        f"{PAYMENT_URL}/charge",
        json={"customer_id": customer_id, "amount": amount},
        timeout=5,
    )
    resp.raise_for_status()
    return resp.json()
