import { createStripeTransfer } from "@/lib/partners/create-stripe-transfer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  partnerFindUniqueOrThrow: vi.fn(),
  payoutFindMany: vi.fn(),
  payoutUpdateMany: vi.fn(),
  commissionFindMany: vi.fn(),
  commissionUpdateMany: vi.fn(),
  accountsRetrieve: vi.fn(),
  transfersList: vi.fn(),
  transfersCreate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    partner: {
      findUniqueOrThrow: mocks.partnerFindUniqueOrThrow,
      update: vi.fn(),
    },
    payout: {
      findMany: mocks.payoutFindMany,
      updateMany: mocks.payoutUpdateMany,
    },
    commission: {
      findMany: mocks.commissionFindMany,
      updateMany: mocks.commissionUpdateMany,
    },
  },
}));

vi.mock("@/lib/stripe", () => ({
  stripe: {
    accounts: { retrieve: mocks.accountsRetrieve },
    transfers: { list: mocks.transfersList, create: mocks.transfersCreate },
  },
}));

vi.mock("@dub/email", () => ({ sendEmail: vi.fn() }));
vi.mock("@dub/email/templates/partner-payout-force-withdrawal", () => ({
  default: vi.fn(),
}));
vi.mock("@dub/email/templates/partner-payout-processed", () => ({
  default: vi.fn(),
}));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@/lib/api/commissions/track-commission-update-activity-log", () => ({
  trackCommissionStatusUpdatesByProgram: vi.fn(),
}));
vi.mock("@/lib/cron/enqueue-batch-jobs", () => ({
  enqueueBatchJobs: vi.fn(),
}));
vi.mock("@dub/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dub/utils")>()),
  log: vi.fn(),
}));

const PARTNER_ID = "pn_1";
const STRIPE_CONNECT_ID = "acct_1";

function payout(id: string, amount: number, invoiceId: string) {
  return {
    id,
    amount,
    invoiceId,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    program: { id: "prog_1", name: "Acme", logo: null, workspaceId: "ws_1" },
  };
}

// a Stripe list whose auto-pagination yields the given transfers
function transferList(transfers: object[]) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* transfers;
    },
  };
}

describe("createStripeTransfer", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.partnerFindUniqueOrThrow.mockResolvedValue({
      id: PARTNER_ID,
      email: null,
      stripeConnectId: STRIPE_CONNECT_ID,
      payoutsEnabledAt: new Date(),
    });
    mocks.accountsRetrieve.mockResolvedValue({
      payouts_enabled: true,
      capabilities: { transfers: "active" },
    });
    mocks.commissionFindMany.mockResolvedValue([]);
    mocks.payoutUpdateMany.mockResolvedValue({ count: 1 });
    mocks.transfersCreate.mockResolvedValue({ id: "tr_new" });
  });

  it("marks processed payouts as sent when Stripe already has their transfer", async () => {
    const old = payout("po_old", 12000, "inv_old");
    mocks.payoutFindMany.mockResolvedValueOnce([old]);
    mocks.transfersList.mockReturnValue(
      transferList([
        {
          id: "tr_lost",
          created: 1767225600,
          amount_reversed: 0,
          metadata: { dubPayoutIds0: "po_old" },
        },
      ]),
    );

    await createStripeTransfer({
      partnerId: PARTNER_ID,
      forceWithdrawal: true,
    });

    expect(mocks.transfersList).toHaveBeenCalledWith(
      expect.objectContaining({ destination: STRIPE_CONNECT_ID }),
    );
    expect(mocks.transfersCreate).not.toHaveBeenCalled();
    expect(mocks.payoutUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["po_old"] } },
      data: expect.objectContaining({
        stripeTransferId: "tr_lost",
        status: "sent",
      }),
    });
  });

  it("transfers only the payouts Stripe has no transfer for", async () => {
    const old = payout("po_old", 12000, "inv_old");
    const current = payout("po_new", 3000, "inv_new");
    mocks.payoutFindMany
      .mockResolvedValueOnce([old])
      .mockResolvedValueOnce([current]);
    mocks.transfersList.mockReturnValue(
      transferList([
        {
          id: "tr_lost",
          created: 1767225600,
          amount_reversed: 0,
          metadata: { dubPayoutIds0: "po_old" },
        },
      ]),
    );

    await createStripeTransfer({
      partnerId: PARTNER_ID,
      invoiceId: "inv_new",
    });

    expect(mocks.transfersCreate).toHaveBeenCalledTimes(1);
    expect(mocks.transfersCreate.mock.calls[0][0]).toMatchObject({
      amount: 3000,
      metadata: { dubPayoutIds0: "po_new" },
    });
    expect(mocks.payoutUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["po_new"] } },
      data: expect.objectContaining({ stripeTransferId: "tr_new" }),
    });
  });

  it("pays again when the earlier transfer was reversed", async () => {
    const old = payout("po_old", 12000, "inv_old");
    mocks.payoutFindMany.mockResolvedValueOnce([old]);
    mocks.transfersList.mockReturnValue(
      transferList([
        {
          id: "tr_reversed",
          created: 1767225600,
          amount_reversed: 12000,
          metadata: { dubPayoutIds0: "po_old" },
        },
      ]),
    );

    await createStripeTransfer({
      partnerId: PARTNER_ID,
      forceWithdrawal: true,
    });

    expect(mocks.transfersCreate).toHaveBeenCalledTimes(1);
    expect(mocks.transfersCreate.mock.calls[0][0]).toMatchObject({
      amount: 12000,
      metadata: { dubPayoutIds0: "po_old" },
    });
  });

  it("doesn't look up transfers when there are no previously processed payouts", async () => {
    mocks.payoutFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([payout("po_new", 15000, "inv_new")]);

    await createStripeTransfer({
      partnerId: PARTNER_ID,
      invoiceId: "inv_new",
    });

    expect(mocks.transfersList).not.toHaveBeenCalled();
    expect(mocks.transfersCreate).toHaveBeenCalledTimes(1);
  });

  it("splits the payout ids across metadata keys under Stripe's 500-character limit", async () => {
    const payouts = Array.from({ length: 20 }, (_, i) =>
      payout(`po_${String(i).padStart(26, "0")}`, 1000, "inv_old"),
    );
    mocks.payoutFindMany.mockResolvedValueOnce(payouts);
    mocks.transfersList.mockReturnValue(transferList([]));

    await createStripeTransfer({
      partnerId: PARTNER_ID,
      forceWithdrawal: true,
    });

    const { metadata } = mocks.transfersCreate.mock.calls[0][0];
    expect(Object.keys(metadata)).toEqual(["dubPayoutIds0", "dubPayoutIds1"]);
    for (const value of Object.values<string>(metadata)) {
      expect(value.length).toBeLessThanOrEqual(500);
    }
    expect(
      Object.values<string>(metadata)
        .flatMap((v) => v.split(","))
        .sort(),
    ).toEqual(payouts.map((p) => p.id).sort());
  });
});
