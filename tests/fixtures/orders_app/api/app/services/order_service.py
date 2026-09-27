from app.clients.payments import charge_card
from app.events import publish
from app.repositories.order_repo import OrderRepository


class PaymentDeclined(Exception):
    pass


class OrderService:
    def __init__(self, session):
        self.repo = OrderRepository(session)

    def place_order(self, customer_id, lines):
        total = sum(line["qty"] * 10 for line in lines)
        order = self.repo.save(customer_id, total)
        result = charge_card(customer_id, total)
        if not result.get("approved"):
            self.repo.mark_status(order.id, "declined")
            raise PaymentDeclined(result.get("reason", "declined"))
        self.repo.mark_status(order.id, "paid")
        publish("order.created", {"order_id": order.id, "total": total})
        return {"id": order.id, "status": "paid"}

    def find(self, order_id):
        return self.repo.get(order_id)
