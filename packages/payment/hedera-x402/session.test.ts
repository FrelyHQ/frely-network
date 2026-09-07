import { expect, test } from "bun:test";
import { createHarness } from "./test-support.ts";
test("one logical request pays once and returns cached synthetic output", async () => {
  const h = createHarness();
  try {
    const first = await h.session.execute(h.request);
    expect(first.paymentStatus).toBe("settled");
    expect(first.serviceStatus).toBe("succeeded");
    expect(first.evidence?.source).toBe("synthetic");
    expect(await h.session.execute(h.request)).toEqual(first);
    expect(h.counts).toEqual({ http: 2, sign: 1, verify: 1 });
  } finally {
    h.close();
  }
});

test("quote and dispatch intents commit before outbound and Capture commits before Verify", async () => {
  const h = createHarness();
  const fetch = h.ports.fetcher;
  const verify = h.ports.verify;
  h.ports.fetcher = async (request) => {
    expect(h.journal.read(h.request.payment.requestId)?.phase).toBe(
      h.counts.http === 0 ? "quote-intent" : "dispatch-intent",
    );
    expect(await request.clone().text()).toBe(h.request.body);
    expect(request.redirect).toBe("error");
    expect(request.headers.get("authorization")).toBe("test-secret");
    return fetch(request);
  };
  h.ports.verify = async (evidence) => {
    expect(h.journal.read(h.request.payment.requestId)).toMatchObject({
      phase: "captured",
      serviceStatus: "succeeded",
      output: { output_text: "synthetic output" },
    });
    return verify(evidence);
  };
  try {
    expect((await h.session.execute(h.request)).paymentStatus).toBe("settled");
  } finally {
    h.close();
  }
});
for (const fault of [
  "dispatch_timeout",
  "service_failure",
  "wrong_receipt",
  "verify_failure",
] as const)
  test(
    fault + " preserves independent payment and service knowledge",
    async () => {
      const h = createHarness({ fault });
      try {
        const r = await h.session.execute(h.request);
        expect(r.paymentStatus).toBe(
          fault === "wrong_receipt" || fault === "verify_failure"
            ? "unknown"
            : "settled",
        );
        expect(r.serviceStatus).toBe(
          fault === "dispatch_timeout"
            ? "unknown"
            : fault === "service_failure"
              ? "failed"
              : "succeeded",
        );
        expect(h.counts.verify).toBe(1);
        if (fault === "verify_failure")
          expect(h.journal.read(h.request.payment.requestId)?.output).toEqual({
            output_text: "synthetic output",
          });
        if (fault === "wrong_receipt")
          expect(
            h.journal.read(h.request.payment.requestId)?.responseConflict,
          ).toBe(true);
      } finally {
        h.close();
      }
    },
  );
test("zero cap rejects before signing", async () => {
  const h = createHarness();
  try {
    h.request.payment.budget.maxAmountAtomic = "0";
    expect((await h.session.execute(h.request)).reason).toBe(
      "NO_ACCEPTABLE_QUOTE",
    );
    expect(h.counts.sign).toBe(0);
  } finally {
    h.close();
  }
});
test("same ID different body or budget conflicts without outbound", async () => {
  const h = createHarness();
  try {
    await h.session.execute(h.request);
    expect(
      (await h.session.execute({ ...h.request, body: "changed" })).reason,
    ).toBe("REQUEST_ID_CONFLICT");
    expect(
      (
        await h.session.execute({
          ...h.request,
          payment: {
            ...h.request.payment,
            budget: { ...h.request.payment.budget, maxAmountAtomic: "2000" },
          },
        })
      ).reason,
    ).toBe("REQUEST_ID_CONFLICT");
    expect(h.counts.http).toBe(2);
  } finally {
    h.close();
  }
});
test("expired cache retains success knowledge and never repays", async () => {
  const h = createHarness();
  try {
    await h.session.execute(h.request);
    const expiry = h.journal.read(h.request.payment.requestId)!.outputExpiresAt;
    h.advance(24 * 60 * 60 * 1000);
    expect(await h.session.execute(h.request)).toMatchObject({
      paymentStatus: "settled",
      serviceStatus: "succeeded",
      output: null,
      reason: "OUTPUT_UNAVAILABLE",
    });
    expect(h.journal.read(h.request.payment.requestId)!.outputExpiresAt).toBe(
      expiry,
    );
    expect(h.counts).toEqual({ http: 2, sign: 1, verify: 1 });
  } finally {
    h.close();
  }
});
test("caller payment header rejected without outbound", async () => {
  const h = createHarness();
  try {
    h.request.headers["pAyMeNt-SiGnAtUrE"] = "fake";
    expect((await h.session.execute(h.request)).reason).toBe(
      "INPUT_UNSUPPORTED",
    );
    expect(h.counts.http).toBe(0);
  } finally {
    h.close();
  }
});
test("redirect response is rejected without signing", async () => {
  const h = createHarness();
  h.ports.fetcher = async () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://elsewhere.example" },
    });
  try {
    expect((await h.session.execute(h.request)).reason).toBe(
      "REDIRECT_REJECTED",
    );
    expect(h.counts.sign).toBe(0);
  } finally {
    h.close();
  }
});
test("Capture failure stops before verification and preserves dispatch uncertainty", async () => {
  const h = createHarness();
  const update = h.journal.update;
  h.journal.update = (id, change) => {
    if (change.phase === "captured") throw new Error("disk full");
    return update(id, change);
  };
  try {
    expect(await h.session.execute(h.request)).toMatchObject({
      paymentStatus: "unknown",
      serviceStatus: "unknown",
      reason: "JOURNAL_UNAVAILABLE",
    });
    expect(h.counts.verify).toBe(0);
    expect(h.journal.read(h.request.payment.requestId)?.phase).toBe(
      "dispatch-intent",
    );
  } finally {
    h.close();
  }
});
test("dispatch-intent write failure prevents paid outbound", async () => {
  const h = createHarness();
  const update = h.journal.update;
  h.journal.update = (id, change) => {
    if (change.phase === "dispatch-intent") throw new Error("disk full");
    return update(id, change);
  };
  try {
    expect((await h.session.execute(h.request)).paymentStatus).toBe("not_paid");
    expect(h.counts.http).toBe(1);
  } finally {
    h.close();
  }
});
test("active duplicate cannot trigger a second payment", async () => {
  const h = createHarness();
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  const check = h.ports.checkNetwork;
  h.ports.checkNetwork = async (s) => {
    await wait;
    return check(s);
  };
  try {
    const first = h.session.execute(h.request);
    await new Promise((r) => setTimeout(r, 5));
    expect((await h.session.execute(h.request)).reason).toBe(
      "REQUEST_IN_PROGRESS",
    );
    release();
    await first;
    expect(h.counts.sign).toBe(1);
  } finally {
    release();
    h.close();
  }
});
test("free response is captured without signing or verification", async () => {
  const h = createHarness();
  h.ports.fetcher = async () =>
    new Response(JSON.stringify({ output_text: "free" }));
  try {
    expect(await h.session.execute(h.request)).toMatchObject({
      paymentStatus: "not_paid",
      serviceStatus: "succeeded",
      output: { output_text: "free" },
    });
    expect(h.counts.sign).toBe(0);
    expect(h.counts.verify).toBe(0);
  } finally {
    h.close();
  }
});
test("request and policy mutation during network check cannot change signed or dispatched request", async () => {
  const h = createHarness();
  const originalUrl = h.request.url;
  const originalBody = h.request.body;
  const originalPayTo = h.policy.payTo;
  h.ports.checkNetwork = async () => {
    h.request.url = "https://evil.example";
    h.request.body = "mutated";
    h.policy.payTo = "0.0.999999";
  };
  const fetch = h.ports.fetcher;
  h.ports.fetcher = async (req) => {
    expect(req.url).toBe(originalUrl);
    expect(await req.clone().text()).toBe(originalBody);
    return fetch(req);
  };
  try {
    const r = await h.session.execute(h.request);
    expect(r.paymentStatus).toBe("settled");
    expect(r.evidence?.payTo).toBe(originalPayTo);
  } finally {
    h.close();
  }
});
test("malformed optional receipt cannot prevent querying the original transaction", async () => {
  const h = createHarness();
  const fetch = h.ports.fetcher;
  h.ports.fetcher = async (req) => {
    const r = await fetch(req);
    if (h.counts.http === 2) r.headers.set("PAYMENT-RESPONSE", "garbage");
    return r;
  };
  try {
    expect((await h.session.execute(h.request)).paymentStatus).toBe("settled");
    expect(h.counts.verify).toBe(1);
  } finally {
    h.close();
  }
});
test("wrong independently verified transfer cannot become settled", async () => {
  const h = createHarness();
  h.ports.verify = async (evidence) => ({
    verified: true,
    evidence: { ...evidence, amountAtomic: "999999" },
  });
  try {
    expect((await h.session.execute(h.request)).paymentStatus).toBe("unknown");
  } finally {
    h.close();
  }
});
test("quote-intent write failure prevents any outbound", async () => {
  const h = createHarness();
  const update = h.journal.update;
  h.journal.update = (id, change) => {
    if (change.phase === "quote-intent") throw new Error("disk full");
    return update(id, change);
  };
  try {
    expect((await h.session.execute(h.request)).reason).toBe(
      "JOURNAL_UNAVAILABLE",
    );
    expect(h.counts.http).toBe(0);
  } finally {
    h.close();
  }
});
test("quote transport failure retains unknown service knowledge without signing", async () => {
  const h = createHarness();
  h.ports.fetcher = async () => {
    throw new Error("timeout");
  };
  try {
    expect(await h.session.execute(h.request)).toMatchObject({
      paymentStatus: "not_paid",
      serviceStatus: "unknown",
    });
    expect(h.counts.sign).toBe(0);
  } finally {
    h.close();
  }
});

test("unreadable journal after dispatch retains original transaction and unknown payment", async () => {
  const h = createHarness();
  const update = h.journal.update;
  const read = h.journal.read;
  let broken = false;
  h.journal.update = (id, change) => {
    if (change.phase === "captured") {
      broken = true;
      throw new Error("offline");
    }
    return update(id, change);
  };
  h.journal.read = (id) => {
    if (broken) throw new Error("offline");
    return read(id);
  };
  try {
    expect(await h.session.execute(h.request)).toMatchObject({
      decision: "paused",
      paymentStatus: "unknown",
      serviceStatus: "unknown",
      reason: "JOURNAL_UNAVAILABLE",
      retryAction: "query_original",
      evidence: { transactionId: "synthetic-tx" },
    });
    expect(h.counts).toEqual({ http: 2, sign: 1, verify: 0 });
  } finally {
    h.close();
  }
});
test("unreadable initial lookup never claims a historical request was unpaid", async () => {
  const h = createHarness();
  h.journal.read = () => {
    throw new Error("offline");
  };
  try {
    expect(await h.session.execute(h.request)).toMatchObject({
      paymentStatus: "unknown",
      serviceStatus: "unknown",
      reason: "JOURNAL_UNAVAILABLE",
      retryAction: "query_original",
    });
    expect(h.counts.http).toBe(0);
  } finally {
    h.close();
  }
});
for (const error of [
  new DOMException("receive timed out", "TimeoutError"),
  new Error("broken stream"),
])
  test(
    "incomplete response stream is unknown even after settlement: " +
      error.name,
    async () => {
      const h = createHarness();
      const fetch = h.ports.fetcher;
      h.ports.fetcher = async (req) => {
        const response = await fetch(req);
        return h.counts.http === 2
          ? new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(error);
                },
              }),
              { status: 200 },
            )
          : response;
      };
      try {
        expect(await h.session.execute(h.request)).toMatchObject({
          paymentStatus: "settled",
          serviceStatus: "unknown",
          reason: "OUTPUT_UNAVAILABLE",
          output: null,
        });
        expect(h.counts.verify).toBe(1);
      } finally {
        h.close();
      }
    },
  );
test("complete invalid response is a known service failure", async () => {
  const h = createHarness();
  const fetch = h.ports.fetcher;
  h.ports.fetcher = async (req) => {
    const response = await fetch(req);
    return h.counts.http === 2
      ? new Response("invalid json", { status: 200 })
      : response;
  };
  try {
    expect(await h.session.execute(h.request)).toMatchObject({
      paymentStatus: "settled",
      serviceStatus: "failed",
      reason: "SERVICE_FAILED_AFTER_PAYMENT",
    });
  } finally {
    h.close();
  }
});
test("cached request with acceptIndex rejects selector while preserving settled evidence", async () => {
  const h = createHarness();
  try {
    await h.session.execute(h.request);
    h.request.payment.acceptIndex = 0;
    expect(await h.session.execute(h.request)).toMatchObject({
      decision: "blocked",
      reason: "INPUT_UNSUPPORTED",
      paymentStatus: "settled",
      serviceStatus: "succeeded",
      evidence: { transactionId: "synthetic-tx" },
    });
    expect(h.counts).toEqual({ http: 2, sign: 1, verify: 1 });
  } finally {
    h.close();
  }
});
test("oversized response reception is bounded, cancelled, and never parsed", async () => {
  const h = createHarness();
  let cancelled = false;
  let parsed = 0;
  const fetch = h.ports.fetcher;
  h.ports.fetcher = async (req) => {
    const response = await fetch(req);
    return h.counts.http === 2
      ? new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024 + 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
        )
      : response;
  };
  h.ports.parseService = async () => {
    parsed++;
    return {};
  };
  try {
    expect(await h.session.execute(h.request)).toMatchObject({
      paymentStatus: "settled",
      serviceStatus: "unknown",
      output: null,
    });
    expect(parsed).toBe(0);
    expect(cancelled).toBe(true);
  } finally {
    h.close();
  }
});

test("live respects ownership held by a separate journal connection", async () => {
  const h = createHarness();
  const { openJournal } = await import("./journal.ts");
  const other = openJournal(h.policy.journalPath);
  const token = other.claimRun();
  try {
    const result = await h.session.execute(h.request);
    expect(result.reason).toBe("REQUEST_IN_PROGRESS");
    expect(h.counts.http).toBe(0);
    expect(h.counts.sign).toBe(0);
  } finally { other.releaseRun(token); other.close(); h.close(); }
});
test("lease expiry during signing fences paid dispatch", async () => {
  const h = createHarness();
  const sign = h.ports.sign;
  h.ports.sign = async selection => { const result = await sign(selection); h.advance(60_001); return result; };
  try {
    const result = await h.session.execute(h.request);
    expect(result.reason).toBe("JOURNAL_UNAVAILABLE");
    expect(h.counts.http).toBe(1);
    expect(result.paymentStatus).toBe("not_paid");
  } finally { h.close(); }
});

for (const phase of ["signed", "finished"]) {
  test(`${phase} write failure retains recoverable facts and never adds paid sends`, async () => {
    const h = createHarness(); const update = h.journal.update;
    h.journal.update = (id, change, token) => { if (change.phase === phase) throw new Error("disk full"); return update(id, change, token); };
    try {
      const result = await h.session.execute(h.request);
      expect(result.reason).toBe("JOURNAL_UNAVAILABLE");
      expect(h.counts.http).toBe(phase === "signed" ? 1 : 2);
      expect(result.paymentStatus).toBe(phase === "signed" ? "not_paid" : "unknown");
      if (phase === "finished") expect(result.evidence?.transactionId).toBe("synthetic-tx");
    } finally { h.close(); }
  });
}
test("signing is bounded at ten seconds and cannot dispatch a late result", async () => {
  const h = createHarness();
  h.ports.sign = () => new Promise(() => {});
  try {
    const result = await h.session.execute(h.request);
    expect(result.reason).toBe("SIGNING_FAILED");
    expect(result.paymentStatus).toBe("not_paid");
    expect(h.counts.http).toBe(1);
  } finally { h.close(); }
}, 15_000);
