// Orders and notification jobs share the same SQLite transaction. No network
// call is made while stock/order writes are in progress.
export function createNotificationOutbox({
  db,
  channels = [],
  now = Date.now,
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS seller_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL REFERENCES orders(id), event TEXT NOT NULL,
    channel TEXT NOT NULL, payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt INTEGER NOT NULL, locked_at INTEGER, accepted_at INTEGER,
    provider_id TEXT, error_code TEXT, created_at INTEGER NOT NULL,
    UNIQUE(order_id, event, channel)
  ); CREATE INDEX IF NOT EXISTS seller_notifications_due ON seller_notifications(status, next_attempt);`);
  function enqueue(order, event = "order.received") {
    if (event !== "order.received") {
      db.prepare(
        "UPDATE seller_notifications SET status='superseded' WHERE order_id=? AND status IN ('queued','retry') AND event IN ('order.received','order.review')",
      ).run(order.id);
    }
    for (const channel of channels)
      db.prepare(
        `INSERT OR IGNORE INTO seller_notifications
      (order_id,event,channel,payload,next_attempt,created_at) VALUES (?,?,?,?,?,?)`,
      ).run(order.id, event, channel, JSON.stringify(order), now(), now());
  }
  function claim() {
    // After a crash the provider might already have accepted an in-flight
    // message. Keep it for merchant review instead of silently sending twice.
    db.prepare(
      "UPDATE seller_notifications SET status='review', error_code='INTERRUPTED_DELIVERY', locked_at=NULL WHERE status='sending' AND locked_at<?",
    ).run(now() - 120000);
    const row = db
      .prepare(
        "SELECT * FROM seller_notifications WHERE status IN ('queued','retry') AND next_attempt<=? ORDER BY id LIMIT 1",
      )
      .get(now());
    if (!row) return null;
    const claimed = db
      .prepare(
        "UPDATE seller_notifications SET status='sending', attempts=attempts+1, locked_at=? WHERE id=? AND status IN ('queued','retry')",
      )
      .run(now(), row.id);
    if (!claimed.changes) return null;
    return {
      ...row,
      attempts: row.attempts + 1,
      order: JSON.parse(row.payload),
    };
  }
  function accept(job, providerId) {
    db.prepare(
      "UPDATE seller_notifications SET status='accepted',accepted_at=?,provider_id=?,locked_at=NULL,error_code=NULL WHERE id=? AND status='sending'",
    ).run(now(), String(providerId || "").slice(0, 200), job.id);
  }
  function fail(job, error) {
    const uncertain = error.uncertain === true;
    const retry = !uncertain && error.retryable === true && job.attempts < 8;
    const status = uncertain ? "review" : retry ? "retry" : "failed";
    const delay = Math.min(3600000, 30000 * 2 ** Math.max(0, job.attempts - 1));
    const code = /^[A-Z0-9_:-]{1,80}$/.test(error.code || "")
      ? error.code
      : "PROVIDER_ERROR";
    db.prepare(
      "UPDATE seller_notifications SET status=?,next_attempt=?,locked_at=NULL,error_code=? WHERE id=? AND status='sending'",
    ).run(status, now() + delay, code, job.id);
  }
  return { enqueue, claim, accept, fail };
}

export function createNotificationWorker({
  outbox,
  notifier,
  interval = 5000,
  onError = () => {},
}) {
  let running,
    stopped = false,
    timer;
  function run() {
    if (running) return running;
    if (stopped) return Promise.resolve();
    running = (async () => {
      for (let index = 0; index < 20 && !stopped; index++) {
        const job = outbox.claim();
        if (!job) break;
        try {
          outbox.accept(job, await notifier.send(job));
        } catch (error) {
          outbox.fail(job, error);
        }
      }
    })().finally(() => {
      running = null;
    });
    return running;
  }
  function start() {
    if (timer || !notifier.channels.length) return;
    timer = setInterval(() => {
      run().catch(onError);
    }, interval);
    timer.unref();
    run().catch(onError);
  }
  async function close() {
    stopped = true;
    clearInterval(timer);
    if (running) await running;
    notifier.close?.();
  }
  return { start, run, close };
}
