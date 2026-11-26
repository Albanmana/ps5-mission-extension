export class Client {
  async connect() {}

  async query() {
    throw new Error('dedup query failed');
  }

  async end() {}
}
