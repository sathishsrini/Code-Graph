from sqlalchemy import text

from app.models.order import Order


class OrderRepository:
    def __init__(self, session):
        self.session = session

    def save(self, customer_id, total):
        order = Order(customer_id=customer_id, total=total, status="pending")
        self.session.add(order)
        self.session.commit()
        return order

    def get(self, order_id):
        return self.session.query(Order).filter(Order.id == order_id).first()

    def mark_status(self, order_id, status):
        self.session.execute(
            text("UPDATE orders SET status = :status WHERE id = :id"),
            {"status": status, "id": order_id},
        )
        self.session.commit()
