import { submitOrder, OrderLine } from "../api/orders";

export function Checkout(props: { customerId: number; cart: OrderLine[] }) {
  async function onPay() {
    const order = await submitOrder(props.customerId, props.cart);
    window.location.href = `/orders/${order.id}`;
  }
  return <button onClick={onPay}>Pay</button>;
}
