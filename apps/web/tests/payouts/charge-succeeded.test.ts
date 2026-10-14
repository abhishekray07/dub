import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chargeSucceeded } from "../../app/(ee)/api/stripe/webhook/charge-succeeded";

const mocks = vi.hoisted(() => ({
  invoiceFindUnique: vi.fn(),
  invoiceUpdate: vi.fn(),
  payoutCount: vi.fn(),
  publishJSON: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    invoice: {
      findUnique: mocks.invoiceFindUnique,
      update: mocks.invoiceUpdate,
    },
    payout: {
      count: mocks.payoutCount,
    },
  },
}));

vi.mock("@/lib/cron", () => ({
  qstash: { publishJSON: mocks.publishJSON },
}));

vi.mock("@/lib/api/domains/finalize-premium-domain-registration", () => ({
  finalizePremiumDomainRegistration: vi.fn(),
}));

vi.mock("@/lib/api/domains/is-domain-registration-invoice", () => ({
  isDomainRegistrationInvoice: vi.fn(),
  parseRegisteredDomainSlugs: vi.fn(() => []),
}));

function chargeSucceededEvent(invoiceId: string) {
  return {
    data: {
      object: {
        id: "ch_1",
        transfer_group: invoiceId,
        receipt_url: "https://pay.stripe.com/receipts/1",
      },
    },
  } as unknown as Stripe.ChargeSucceededEvent;
}

describe("chargeSucceeded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.publishJSON.mockResolvedValue({ messageId: "msg_1" });
  });

  it("queues the payouts job when it marks a payout invoice completed", async () => {
    const invoice = {
      id: "inv_1",
      type: "partnerPayout",
      status: "processing",
    };
    mocks.invoiceFindUnique.mockResolvedValue(invoice);
    mocks.invoiceUpdate.mockResolvedValue({ ...invoice, status: "completed" });
    mocks.payoutCount.mockResolvedValue(3);

    await chargeSucceeded(chargeSucceededEvent("inv_1"));

    expect(mocks.invoiceUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.publishJSON).toHaveBeenCalledWith(
      expect.objectContaining({ body: { invoiceId: "inv_1" } }),
    );
  });

  it("queues the payouts job again on a redelivery when the payouts are still processing", async () => {
    mocks.invoiceFindUnique.mockResolvedValue({
      id: "inv_1",
      type: "partnerPayout",
      status: "completed",
    });
    mocks.payoutCount.mockResolvedValue(3);

    const result = await chargeSucceeded(chargeSucceededEvent("inv_1"));

    expect(mocks.payoutCount).toHaveBeenCalledWith({
      where: { invoiceId: "inv_1", status: "processing" },
    });
    expect(mocks.invoiceUpdate).not.toHaveBeenCalled();
    expect(mocks.publishJSON).toHaveBeenCalledWith(
      expect.objectContaining({ body: { invoiceId: "inv_1" } }),
    );
    expect(result).toBe("Message sent to Qstash with id msg_1");
  });

  it("skips a redelivery once no payouts are processing", async () => {
    mocks.invoiceFindUnique.mockResolvedValue({
      id: "inv_1",
      type: "partnerPayout",
      status: "completed",
    });
    mocks.payoutCount.mockResolvedValue(0);

    const result = await chargeSucceeded(chargeSucceededEvent("inv_1"));

    expect(mocks.publishJSON).not.toHaveBeenCalled();
    expect(result).toBe("Invoice inv_1 already completed, skipping...");
  });

  it("still skips a redelivery for a completed domain renewal invoice", async () => {
    mocks.invoiceFindUnique.mockResolvedValue({
      id: "inv_2",
      type: "domainRenewal",
      status: "completed",
    });

    const result = await chargeSucceeded(chargeSucceededEvent("inv_2"));

    expect(mocks.payoutCount).not.toHaveBeenCalled();
    expect(mocks.publishJSON).not.toHaveBeenCalled();
    expect(result).toBe("Invoice inv_2 already completed, skipping...");
  });
});
