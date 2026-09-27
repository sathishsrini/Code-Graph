from fastapi import APIRouter, Depends, HTTPException

from app.db import get_session
from app.services.order_service import OrderService, PaymentDeclined

router = APIRouter()


@router.post("/orders")
def create_order(payload: dict, session=Depends(get_session)):
    service = OrderService(session)
    try:
        return service.place_order(payload["customer_id"], payload["lines"])
    except PaymentDeclined as exc:
        raise HTTPException(status_code=402, detail=str(exc))


@router.get("/orders/{order_id}")
def get_order(order_id: int, session=Depends(get_session)):
    order = OrderService(session).find(order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="order not found")
    return order
