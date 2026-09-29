'use strict';

// Server-Sent Events broadcaster.
// Keeps a Set of active response objects and pushes named events to all of them.
// Works with a single-instance Node server; no external pub/sub needed.

const clients = new Set();

/** Attach an SSE response to the broadcast pool. Returns a cleanup function. */
function addClient(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // prevent nginx from buffering SSE
  });
  res.write(': connected\n\n'); // initial flush so the browser knows it's live

  // Keep-alive ping every 25 s (proxy idle timeouts are usually 30 s).
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);

  clients.add(res);
  return () => {
    clearInterval(ping);
    clients.delete(res);
  };
}

/** Broadcast a named event with a JSON payload to every connected client. */
function broadcast(event, data) {
  if (!clients.size) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch { /* client already gone */ }
  }
}

module.exports = { addClient, broadcast };
