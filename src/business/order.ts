export interface OrderItem {
  nombre: string;
  precio: number;
  cantidad: number;
  extras: string[];
  sin: string[];
  nota?: string;
}

export interface OrderData {
  items: OrderItem[];
  pendingCategory?: string; // category currently being browsed
}

export function orderTotal(items: OrderItem[]): number {
  return items.reduce((sum, i) => sum + i.precio * i.cantidad, 0);
}

export function formatOrderSummary(items: OrderItem[]): string {
  const lines = items.map((i) => {
    const mods: string[] = [];
    if (i.extras.length) mods.push(`+ ${i.extras.join(", ")}`);
    if (i.sin.length) mods.push(`sin ${i.sin.join(", ")}`);
    if (i.nota) mods.push(i.nota);
    const modStr = mods.length ? ` _(${mods.join(" · ")})_` : "";
    return `• ${i.cantidad}x ${i.nombre}${modStr} — $${i.precio * i.cantidad}`;
  });
  return lines.join("\n") + `\n\n💰 *Total: $${orderTotal(items)}*`;
}

export function formatOrderId(id: number): string {
  return `#PED-${String(id).padStart(4, "0")}`;
}
