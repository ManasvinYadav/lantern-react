import { request, requestJson } from "./http.ts";
import type {
  SetWebhooksRequest,
  SetWebhooksResponse,
  TestWebhookResponse,
  WebhookChannel,
  WebhookDelivery,
  WebhooksResponse,
} from "./types.ts";

export function getWebhooks(): Promise<WebhooksResponse> {
  return request<WebhooksResponse>("/api/webhooks");
}

/** Accepts either the single-channel form `{channel, url}` or a multi-channel
 * map `{discord: "...", telegram: "..."}` — both are valid request bodies for
 * this endpoint (see SetWebhooksRequest). An empty `url` deletes that
 * channel's saved config. */
export function setWebhooks(config: SetWebhooksRequest): Promise<SetWebhooksResponse> {
  return requestJson<SetWebhooksResponse>("/api/webhooks", "PUT", config);
}

/** Omit `channel` (or pass undefined) to test every configured channel at once. */
export function testWebhook(channel?: WebhookChannel): Promise<TestWebhookResponse> {
  return requestJson<TestWebhookResponse>("/api/webhooks/test", "POST", channel ? { channel } : {});
}

export function getWebhookDeliveries(limit?: number): Promise<WebhookDelivery[]> {
  const qs = limit !== undefined ? `?limit=${limit}` : "";
  return request<WebhookDelivery[]>(`/api/webhooks/deliveries${qs}`);
}
