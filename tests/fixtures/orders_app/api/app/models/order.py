from sqlalchemy import Column, ForeignKey, Integer, Numeric, String
from sqlalchemy.orm import relationship

from app.models.base import Base


class Order(Base):
    __tablename__ = "orders"

    id = Column(Integer, primary_key=True)
    customer_id = Column(Integer, ForeignKey("customers.id"), nullable=False)
    total = Column(Numeric(10, 2), nullable=False)
    status = Column(String(20), nullable=False, default="pending")

    customer = relationship("Customer", back_populates="orders")
