// Simulated, vendor-neutral model provider for tests.
// It records every serialized request sent to the "model" and every raw
// response returned, so tests can assert on the full model channel.
export class RecordingModelProvider {
  constructor(respond) {
    this.id = "recording-mock";
    this.respond = respond;
    this.requests = [];
    this.responses = [];
  }

  async complete(request, options) {
    this.requests.push(JSON.stringify(request));
    const raw = await this.respond(request, options);
    this.responses.push(raw);
    return raw;
  }

  channel() {
    return JSON.stringify({ requests: this.requests, responses: this.responses });
  }
}

export function layoutResponse(layout) {
  return () => JSON.stringify(layout);
}
