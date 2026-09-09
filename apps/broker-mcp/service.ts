const SERVICE = "frely-network-broker-mcp";
const NOT_IMPLEMENTED = "BROKER_EXECUTION_NOT_IMPLEMENTED";
const PAYMENT_ADMISSION_NOT_CONFIGURED = "PAYMENT_ADMISSION_NOT_CONFIGURED";

export interface BrokerMcpServiceOptions {
  readonly paymentAdmission?: (request: Request) => Response | Promise<Response>;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export function brokerMcpFetch(request: Request): Response {
  const url = new URL(request.url);
  if (url.pathname === "/a2a/payment/requirements" || url.pathname === "/a2a/payment/verify") {
    return json({ code: PAYMENT_ADMISSION_NOT_CONFIGURED }, 503);
  }
  if (request.method === "GET" && url.pathname === "/healthz") {
    return json({ service: SERVICE, status: "ok" }, 200);
  }
  if (request.method === "GET" && url.pathname === "/readyz") {
    return json({
      service: SERVICE,
      status: "not_ready",
      code: NOT_IMPLEMENTED,
    }, 503);
  }
  if (request.method === "POST" && url.pathname === "/mcp") {
    return json({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32004,
        message: NOT_IMPLEMENTED,
      },
    }, 503);
  }
  return json({ code: "NOT_FOUND" }, 404);
}

/** Compose the fail-closed Broker routes with an explicitly configured payment boundary. */
export function createBrokerMcpFetch(options: BrokerMcpServiceOptions = {}): (request: Request) => Response | Promise<Response> {
  return (request) => {
    const pathname = new URL(request.url).pathname;
    if ((pathname === "/a2a/payment/requirements" || pathname === "/a2a/payment/verify") && options.paymentAdmission) {
      return options.paymentAdmission(request);
    }
    return brokerMcpFetch(request);
  };
}
