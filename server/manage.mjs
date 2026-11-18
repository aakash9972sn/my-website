import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
const db = new DatabaseSync(
  process.env.DATABASE_PATH || resolve("var/store.sqlite"),
);
db.exec("PRAGMA busy_timeout=5000");
const [command, id, value] = process.argv.slice(2);
try {
  if (command === "inventory")
    console.table(db.prepare("SELECT * FROM inventory ORDER BY sku").all());
  else if (command === "stock") {
    if (!/^\d+$/.test(value || "") || Number(value) > 100000)
      throw new Error("Use: npm run store -- stock product:variant QUANTITY");
    const result = db
      .prepare("UPDATE inventory SET stock=? WHERE sku=?")
      .run(Number(value), id);
    if (!result.changes)
      throw new Error(
        "Unknown SKU. Run the server once to initialise inventory.",
      );
    console.log(
      "Available stock updated. Existing order reservations are separate.",
    );
  } else if (command === "orders")
    console.table(
      db
        .prepare(
          "SELECT id, method, status, fulfillment, created_at FROM orders ORDER BY created_at DESC LIMIT 100",
        )
        .all(),
    );
  else if (command === "order") {
    const row = db.prepare("SELECT * FROM orders WHERE id=?").get(id);
    if (!row) throw new Error("Order not found.");
    console.log(
      JSON.stringify(
        {
          id: row.id,
          status: row.status,
          method: row.method,
          customer: JSON.parse(row.customer),
          items: JSON.parse(row.items),
          totals: JSON.parse(row.totals),
        },
        null,
        2,
      ),
    );
  } else if (command === "confirm-cod") {
    const result = db
      .prepare(
        "UPDATE orders SET status='cod_confirmed', updated_at=? WHERE id=? AND status='cod_pending' AND expires_at>?",
      )
      .run(Date.now(), id, Date.now());
    if (!result.changes)
      throw new Error("Only an unexpired COD request can be confirmed.");
    console.log("COD order confirmed. Payment is due on delivery.");
  } else if (command === "dispatch") {
    if (value && !/^https:\/\//.test(value))
      throw new Error("Tracking link must use HTTPS.");
    const result = db
      .prepare(
        "UPDATE orders SET fulfillment='shipped', tracking=?, updated_at=? WHERE id=? AND status IN ('paid','cod_confirmed') AND fulfillment='unfulfilled'",
      )
      .run(value || null, Date.now(), id);
    if (!result.changes)
      throw new Error("Only a paid or confirmed COD order can be dispatched.");
    console.log("Order marked as dispatched.");
  } else if (command === "deliver") {
    const result = db
      .prepare(
        "UPDATE orders SET fulfillment='delivered', status='paid', updated_at=? WHERE id=? AND status IN ('paid','cod_confirmed') AND fulfillment='shipped'",
      )
      .run(Date.now(), id);
    if (!result.changes)
      throw new Error(
        "Order must be dispatched first. For COD, record delivery only after collecting payment.",
      );
    console.log("Delivery and payment recorded.");
  } else
    console.log(
      "Commands: inventory | stock SKU QUANTITY | orders | order ORDER_ID | confirm-cod ORDER_ID | dispatch ORDER_ID [HTTPS_TRACKING_URL] | deliver ORDER_ID",
    );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
