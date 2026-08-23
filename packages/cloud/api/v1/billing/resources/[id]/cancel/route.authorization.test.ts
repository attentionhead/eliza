/**
 * Proves the billable-resource cancellation route reaches its effect only
 * after the current OWNER/ADMIN session boundary authorizes the exact tenant.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { ApiError } from "@/lib/api/cloud-worker-errors";

const requireCurrentBillingManagerSession = mock();
const requestCancellation = mock();
const readReceipt = mock();

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireCurrentBillingManagerSession,
}));

mock.module("@/lib/services/active-billing", () => ({
  activeBillingService: { requestCancellation },
}));

mock.module("@/lib/services/billing-resource-cancellations", () => ({
  billingResourceCancellationsService: { readReceipt },
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  moneyRateLimit:
    () =>
    async (_context: unknown, next: () => Promise<void>): Promise<void> =>
      await next(),
  RateLimitPresets: { STANDARD: {} },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(), warn: mock(), info: mock(), debug: mock() },
}));

const { default: route } = await import("./route");
const app = new Hono();
app.route("/api/v1/billing/resources/:id/cancel", route);

beforeEach(() => {
  requireCurrentBillingManagerSession.mockReset();
  requestCancellation.mockReset();
  readReceipt.mockReset();
  requestCancellation.mockResolvedValue({
    disposition: "accepted",
    receipt: {
      receiptId: "00000000-0000-4000-8000-000000000002",
      jobId: "00000000-0000-4000-8000-000000000003",
      resourceId: "00000000-0000-4000-8000-000000000001",
      resourceType: "container",
      action: "stop",
      expectedLifecycleRevision: 7,
      status: "accepted",
      billingStopped: false,
      infrastructureStatus: "queued",
      acceptedAt: "2026-08-23T00:00:00.000Z",
      pollEndpoint:
        "/api/v1/billing/resources/00000000-0000-4000-8000-000000000001/cancel?receiptId=00000000-0000-4000-8000-000000000002",
    },
  });
  readReceipt.mockResolvedValue({
    receiptId: "00000000-0000-4000-8000-000000000002",
    jobId: "00000000-0000-4000-8000-000000000003",
    resourceId: "00000000-0000-4000-8000-000000000001",
    resourceType: "container",
    action: "stop",
    expectedLifecycleRevision: 7,
    status: "accepted",
    billingStopped: false,
    infrastructureStatus: "queued",
    acceptedAt: "2026-08-23T00:00:00.000Z",
    pollEndpoint:
      "/api/v1/billing/resources/00000000-0000-4000-8000-000000000001/cancel?receiptId=00000000-0000-4000-8000-000000000002",
  });
});

describe("billing resource cancellation authorization", () => {
  test("uses the freshly authorized organization at the final effect boundary", async () => {
    requestCancellation.mockImplementation(async (options) => {
      await options.authorizeInfrastructureMutation();
      return {
        disposition: "accepted",
        receipt: {
          receiptId: "00000000-0000-4000-8000-000000000002",
          jobId: "00000000-0000-4000-8000-000000000003",
          resourceId: "00000000-0000-4000-8000-000000000001",
          resourceType: "container",
          action: "stop",
          expectedLifecycleRevision: 7,
          status: "accepted",
          billingStopped: false,
          infrastructureStatus: "queued",
          acceptedAt: "2026-08-23T00:00:00.000Z",
          pollEndpoint:
            "/api/v1/billing/resources/00000000-0000-4000-8000-000000000001/cancel?receiptId=00000000-0000-4000-8000-000000000002",
        },
      };
    });
    for (const role of ["owner", "admin"]) {
      requireCurrentBillingManagerSession.mockResolvedValue({
        id: `${role}-1`,
        organization_id: "org-current",
        role,
      });

      const response = await app.request(
        "https://api.test/api/v1/billing/resources/00000000-0000-4000-8000-000000000001/cancel",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": "billing-cancel-request-0001",
          },
          body: JSON.stringify({
            resourceType: "container",
            mode: "stop",
            expectedLifecycleRevision: 7,
          }),
        },
      );

      expect(response.status).toBe(202);
    }

    expect(requestCancellation).toHaveBeenCalledTimes(2);
    expect(requireCurrentBillingManagerSession).toHaveBeenCalledTimes(4);
    expect(requestCancellation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        organizationId: "org-current",
        requestedByUserId: "owner-1",
        resourceId: "00000000-0000-4000-8000-000000000001",
        resourceType: "container",
        expectedLifecycleRevision: 7,
        idempotencyKey: "billing-cancel-request-0001",
      }),
    );
  });

  test("makes zero cancellation calls when current authority denies", async () => {
    for (const status of [401, 403, 503]) {
      requireCurrentBillingManagerSession.mockRejectedValueOnce(
        new ApiError(
          status,
          status === 401
            ? "session_auth_required"
            : status === 403
              ? "access_denied"
              : "service_unavailable",
          "denied",
        ),
      );
      const response = await app.request(
        "https://api.test/api/v1/billing/resources/00000000-0000-4000-8000-000000000001/cancel",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": "billing-cancel-request-0001",
          },
          body: JSON.stringify({
            resourceType: "container",
            mode: "stop",
            expectedLifecycleRevision: 7,
          }),
        },
      );
      expect(response.status).toBe(status);
    }

    expect(requestCancellation).not.toHaveBeenCalled();
  });

  test("reads a receipt only in the current organization and path resource scope", async () => {
    requireCurrentBillingManagerSession.mockResolvedValue({
      id: "owner-1",
      organization_id: "org-current",
      role: "owner",
    });

    const response = await app.request(
      "https://api.test/api/v1/billing/resources/00000000-0000-4000-8000-000000000001/cancel?receiptId=00000000-0000-4000-8000-000000000002",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      receipt: {
        receiptId: "00000000-0000-4000-8000-000000000002",
        resourceId: "00000000-0000-4000-8000-000000000001",
      },
    });
    expect(requireCurrentBillingManagerSession).toHaveBeenCalledTimes(1);
    expect(readReceipt).toHaveBeenCalledWith({
      organizationId: "org-current",
      resourceId: "00000000-0000-4000-8000-000000000001",
      receiptId: "00000000-0000-4000-8000-000000000002",
    });
  });

  test("makes zero receipt reads when current authority denies", async () => {
    for (const status of [401, 403, 503]) {
      requireCurrentBillingManagerSession.mockRejectedValueOnce(
        new ApiError(
          status,
          status === 401
            ? "session_auth_required"
            : status === 403
              ? "access_denied"
              : "service_unavailable",
          "denied",
        ),
      );
      const response = await app.request(
        "https://api.test/api/v1/billing/resources/00000000-0000-4000-8000-000000000001/cancel?receiptId=00000000-0000-4000-8000-000000000002",
      );
      expect(response.status).toBe(status);
    }

    expect(readReceipt).not.toHaveBeenCalled();
  });

  test("returns the same not-found envelope for every scoped receipt miss", async () => {
    requireCurrentBillingManagerSession.mockResolvedValue({
      id: "owner-1",
      organization_id: "org-current",
      role: "owner",
    });
    readReceipt.mockRejectedValue(
      new ApiError(
        404,
        "resource_not_found",
        "Billing cancellation receipt not found",
      ),
    );

    const response = await app.request(
      "https://api.test/api/v1/billing/resources/00000000-0000-4000-8000-000000000001/cancel?receiptId=00000000-0000-4000-8000-000000000099",
    );

    expect(response.status).toBe(404);
    expect((await response.json()) as Record<string, unknown>).toEqual({
      success: false,
      error: "Billing cancellation receipt not found",
      code: "resource_not_found",
    });
  });
});
