from sqlalchemy import Column, Integer, String
from sqlalchemy.orm import relationship

from app.models.base import Base


class Customer(Base):
    __tablename__ = "customers"

    id = Column(Integer, primary_key=True)
    email = Column(String(255), unique=True, nullable=False)

    orders = relationship("Order", back_populates="customer")
