import { Readable } from 'node:stream';
import { once } from 'node:events';

export async function listenLoopback(server, t) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

// Exercise the actual HTTP handler without opening a socket.
export function request(server, path, { method = 'GET', body, bodyStream, origin, contentType = 'application/json', host = '127.0.0.1:8835' } = {}) {
  return new Promise((resolve, reject) => {
    const incoming = bodyStream ?? Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    const headers = { host, 'content-type': contentType };
    if (origin != null) headers.origin = origin;
    Object.assign(incoming, { method, url: path, headers });
    const response = {
      headersSent: false,
      writeHead(status, headers) {
        this.headersSent = true;
        this.status = status;
        this.headers = headers;
      },
      end(data) { resolve(new Response(data, { status: this.status, headers: this.headers })); },
      destroy() { reject(new Error('Response destroyed')); },
    };
    server.emit('request', incoming, response);
  });
}

export const post = (server, path, body) => request(server, path, { method: 'POST', body });
