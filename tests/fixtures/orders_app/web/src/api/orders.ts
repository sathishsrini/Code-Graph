export interface OrderLine {
  sku: string;
  qty: number;
}

export async function submitOrder(customerId: number, lines: OrderLine[]) {
  const resp = await fetch("/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customer_id: customerId, lines }),
  });
  if (!resp.ok) {
    throw new Error(`order failed: ${resp.status}`);
  }
  return resp.json();
}

export async function loadOrder(orderId: number) {
  const resp = await fetch(`/api/orders/${orderId}`);
  return resp.json();
}

export async function checkHealth() {
  const resp = await fetch("/api/health");
  return resp.ok;
}
