let n = 0;

/** a fresh public address per call: the rate limiter keeps its buckets in module memory, shared by all tests of a file */
export const freshIp = () => `203.0.${Math.floor(++n / 250)}.${(n % 250) + 1}`;

export function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://web.test${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": freshIp(), ...headers },
    body: JSON.stringify(body),
  });
}
