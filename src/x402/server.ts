import http from "node:http";
import type { AddressInfo } from "node:net";
import type { LocalFacilitator } from "./facilitator.js";
import {
  decodeHeader,
  encodeHeader,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  X402_VERSION,
} from "./types.js";

export interface Route {
  /** Body served after payment (or for free routes). */
  body: string;
  mimeType?: string;
  description?: string;
  /** Omit for a free page. */
  price?: { amount: bigint; asset: string; payTo: string; name: string; version: string; maxTimeoutSeconds?: number };
}

export interface PaidServerOptions {
  routes: Record<string, Route>;
  facilitator: LocalFacilitator;
  /** Called with every PAYMENT-SIGNATURE header the server receives (the lab's eavesdropper uses it). */
  onPaymentHeader?: (header: string) => void;
}

/** A small x402 v2 resource server: 402 with PAYMENT-REQUIRED, then verify and settle through a facilitator. */
export class PaidServer {
  private server?: http.Server;
  private base = "";

  constructor(private readonly opts: PaidServerOptions) {}

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`server error: ${(err as Error).message}`);
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.base;
  }

  /** Replace the server's routes (the lab rebuilds pages for each scenario). */
  setRoutes(routes: Record<string, Route>): void {
    for (const k of Object.keys(this.opts.routes)) delete this.opts.routes[k];
    Object.assign(this.opts.routes, routes);
  }

  url(path: string): string {
    return `${this.base}${path}`;
  }

  requirementFor(path: string): PaymentRequirements | undefined {
    const price = this.opts.routes[path]?.price;
    if (!price) return undefined;
    return {
      scheme: "exact",
      network: this.opts.facilitator.network,
      amount: price.amount.toString(),
      asset: price.asset,
      payTo: price.payTo,
      maxTimeoutSeconds: price.maxTimeoutSeconds ?? 60,
      extra: { name: price.name, version: price.version },
    };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const route = this.opts.routes[path];
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const mime = route.mimeType ?? "text/plain; charset=utf-8";
    const requirement = this.requirementFor(path);
    if (!requirement) {
      res.writeHead(200, { "content-type": mime });
      res.end(route.body);
      return;
    }

    const required: PaymentRequired = {
      x402Version: X402_VERSION,
      resource: { url: this.url(path), description: route.description, mimeType: route.mimeType ?? "text/plain" },
      accepts: [requirement],
    };
    const header = req.headers[HEADER_PAYMENT_SIGNATURE.toLowerCase()];
    if (typeof header !== "string") {
      this.send402(res, { ...required, error: "PAYMENT-SIGNATURE header is required" });
      return;
    }
    this.opts.onPaymentHeader?.(header);

    let payload: PaymentPayload;
    try {
      payload = decodeHeader<PaymentPayload>(header);
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("malformed PAYMENT-SIGNATURE header");
      return;
    }
    const a = payload.accepted;
    const matches =
      a?.scheme === requirement.scheme &&
      a.network === requirement.network &&
      a.amount === requirement.amount &&
      a.asset.toLowerCase() === requirement.asset.toLowerCase() &&
      a.payTo.toLowerCase() === requirement.payTo.toLowerCase();
    if (!matches) {
      this.send402(res, { ...required, error: "payment does not match this resource's requirements" });
      return;
    }
    const settlement = await this.opts.facilitator.settle(payload, requirement);
    if (!settlement.success) {
      res.writeHead(402, {
        "content-type": "application/json",
        [HEADER_PAYMENT_REQUIRED]: encodeHeader({ ...required, error: settlement.errorReason }),
        [HEADER_PAYMENT_RESPONSE]: encodeHeader(settlement),
      });
      res.end(JSON.stringify({ ...required, error: settlement.errorReason }));
      return;
    }
    res.writeHead(200, { "content-type": mime, [HEADER_PAYMENT_RESPONSE]: encodeHeader(settlement) });
    res.end(route.body);
  }

  private send402(res: http.ServerResponse, body: PaymentRequired): void {
    res.writeHead(402, { "content-type": "application/json", [HEADER_PAYMENT_REQUIRED]: encodeHeader(body) });
    res.end(JSON.stringify(body));
  }
}
