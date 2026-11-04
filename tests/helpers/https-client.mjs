import { request } from "node:https";

// Trust is supplied per request by the test. Never disable TLS validation globally.
export function httpsJson(url, { ca, method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers };
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded !== undefined) requestHeaders["Content-Type"] = "application/json";
    const outgoing = request(url, {
      method, ca, headers: requestHeaders, signal: AbortSignal.timeout(5000),
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: response.statusCode, headers: response.headers, body: text ? JSON.parse(text) : undefined });
        } catch (error) { reject(error); }
      });
    });
    outgoing.on("error", reject);
    outgoing.end(encoded);
  });
}
