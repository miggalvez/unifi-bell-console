import { Agent } from "undici";
import { env } from "@/env";

// Consoles ship self-signed certs; verification is opt-in via PROTECT_TLS_VERIFY.
export const dispatcher = new Agent({
  connect: { rejectUnauthorized: env.protectTlsVerify },
});

// api.ui.com has a real certificate — always verify.
export const cloudDispatcher = new Agent({});
