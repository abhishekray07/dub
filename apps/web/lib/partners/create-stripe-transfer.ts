import { trackCommissionStatusUpdatesByProgram } from "@/lib/api/commissions/track-commission-update-activity-log";
import {
  BELOW_MIN_WITHDRAWAL_FEE_CENTS,
  MIN_FORCE_WITHDRAWAL_AMOUNT_CENTS,
  MIN_WITHDRAWAL_AMOUNT_CENTS,
} from "@/lib/constants/payouts";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { sendEmail } from "@dub/email";
import PartnerPayoutForceWithdrawal from "@dub/email/templates/partner-payout-force-withdrawal";
import PartnerPayoutProcessed from "@dub/email/templates/partner-payout-processed";
import {
  APP_DOMAIN_WITH_NGROK,
  chunk,
  currencyFormatter,
  log,
  pluralize,
} from "@dub/utils";
import { Payout, Prisma, Program, WorkspaceEnvironment } from "@prisma/client";
import { waitUntil } from "@vercel/functions";
import { PARTNER_IDS_TO_LOG_PAYOUTS_FOR } from "../constants/misc";
import { enqueueBatchJobs } from "../cron/enqueue-batch-jobs";
import { createPayoutsIdempotencyKey } from "../payouts/create-payouts-idempotency-key";
import { markPayoutsAsProcessed } from "../payouts/mark-payouts-as-processed";
import {
  findTransferredPayouts,
  payoutIdsToTransferMetadata,
} from "../payouts/transferred-payouts";

export const createStripeTransfer = async ({
  partnerId,
  invoiceId,
  chargeId,
  forceWithdrawal = false,
}: {
  partnerId: string;
  invoiceId?: string;
  chargeId?: string;
  forceWithdrawal?: boolean;
}) => {
  const partner = await prisma.partner.findUniqueOrThrow({
    where: {
      id: partnerId,
    },
    select: {
      id: true,
      email: true,
      stripeConnectId: true,
      payoutsEnabledAt: true,
    },
  });

  const commonInclude: Prisma.PayoutInclude = {
    program: {
      select: {
        id: true,
        name: true,
        logo: true,
        workspaceId: true,
      },
    },
  };

  const [previouslyProcessedPayouts, currentInvoicePayouts] = await Promise.all(
    [
      prisma.payout.findMany({
        where: {
          partnerId: partner.id,
          status: "processed",
          stripeTransferId: null,
          method: "connect",
          program: {
            workspace: {
              environment: WorkspaceEnvironment.production,
            },
          },
        },
        orderBy: {
          id: "asc",
        },
        include: commonInclude,
      }),

      invoiceId
        ? prisma.payout.findMany({
            where: {
              partnerId: partner.id,
              invoiceId,
              status: "processing",
              method: "connect",
              program: {
                workspace: {
                  environment: WorkspaceEnvironment.production,
                },
              },
            },
            orderBy: {
              id: "asc",
            },
            include: commonInclude,
          })
        : Promise.resolve([]),
    ],
  );

  let allPayouts = [...previouslyProcessedPayouts, ...currentInvoicePayouts];

  // this should never happen but just in case
  if (allPayouts.length === 0) {
    console.log(
      `No available payouts found for partner ${partner.email}, skipping...`,
    );
    return;
  }

  // should never happen, but just in case
  if (!partner.stripeConnectId || !partner.payoutsEnabledAt) {
    await markPayoutsAsProcessed(currentInvoicePayouts);
    console.warn(
      `Partner ${partner.email} does not have an active payout account.`,
    );
    return;
  }

  const stripeConnectAccount = await stripe.accounts.retrieve(
    partner.stripeConnectId,
  );

  if (
    !stripeConnectAccount.payouts_enabled ||
    !stripeConnectAccount.capabilities?.transfers ||
    stripeConnectAccount.capabilities.transfers === "inactive"
  ) {
    await prisma.partner.update({
      where: {
        id: partner.id,
      },
      data: {
        payoutsEnabledAt: null,
        defaultPayoutMethod: null,
      },
    });

    console.log(`Updated partner ${partner.email} with payoutsEnabledAt null`);

    await markPayoutsAsProcessed(currentInvoicePayouts);

    const message = `Partner's Stripe Express account (${partner.stripeConnectId}) is not configured to receive transfers`;

    if (forceWithdrawal) {
      throw new Error(message);
    } else {
      console.warn(message);
      return;
    }
  }

  // If a previous run created the transfer but stopped before marking its payouts as sent,
  // those payouts are still "processed". The idempotency key only stops a second transfer
  // within 24 hours and while the set of payouts is unchanged, so check Stripe first.
  if (previouslyProcessedPayouts.length > 0) {
    const transferredPayouts = await findTransferredPayouts({
      stripeConnectId: partner.stripeConnectId,
      payouts: allPayouts,
    });

    if (transferredPayouts.size > 0) {
      const transfers = new Map<
        string,
        { created: number; payouts: typeof allPayouts }
      >();
      for (const payout of allPayouts) {
        const transfer = transferredPayouts.get(payout.id);
        if (!transfer) continue;
        const entry = transfers.get(transfer.id) ?? {
          created: transfer.created,
          payouts: [],
        };
        entry.payouts.push(payout);
        transfers.set(transfer.id, entry);
      }

      for (const [transferId, { created, payouts }] of transfers) {
        const message = `Found existing transfer ${transferId} for partner ${partner.id} covering ${pluralize(
          "payout",
          payouts.length,
        )} ${payouts.map((p) => p.id).join(", ")}, marking them as sent instead of transferring again`;
        console.warn(message);
        await log({ message, type: "alerts" });

        await markPayoutsAsSent({
          payouts,
          transferId,
          paidAt: new Date(created * 1000),
        });
      }

      // leave the payouts that are already paid out of this transfer
      for (const payouts of [
        previouslyProcessedPayouts,
        currentInvoicePayouts,
      ]) {
        payouts.splice(
          0,
          payouts.length,
          ...payouts.filter((p) => !transferredPayouts.has(p.id)),
        );
      }
      allPayouts = [...previouslyProcessedPayouts, ...currentInvoicePayouts];

      if (allPayouts.length === 0) {
        return;
      }
    }
  }

  // total transferable amount is the sum of all previously processed payouts (but not sent yet) and the current invoice payouts
  const totalTransferableAmount = allPayouts.reduce(
    (acc, payout) => acc + payout.amount,
    0,
  );

  // For force-withdrawals, if amount is less than the minimum force withdrawal amount, throw an error
  if (
    forceWithdrawal &&
    totalTransferableAmount < MIN_FORCE_WITHDRAWAL_AMOUNT_CENTS
  ) {
    throw new Error(
      `Total transferable amount (${currencyFormatter(totalTransferableAmount)}) is less than the minimum amount required for withdrawal (${currencyFormatter(MIN_FORCE_WITHDRAWAL_AMOUNT_CENTS)}).`,
    );
  }

  let withdrawalFee = 0;

  // If the total transferable amount is less than the minimum withdrawal amount
  if (totalTransferableAmount < MIN_WITHDRAWAL_AMOUNT_CENTS) {
    // if we're forcing a withdrawal, we need to charge a withdrawal fee
    if (forceWithdrawal) {
      withdrawalFee = BELOW_MIN_WITHDRAWAL_FEE_CENTS;
      // else, we will just update current invoice payouts to "processed" status
    } else {
      await markPayoutsAsProcessed(currentInvoicePayouts);

      const message = `Total processed payouts (${currencyFormatter(totalTransferableAmount)}) for partner ${partner.id} are below ${currencyFormatter(MIN_WITHDRAWAL_AMOUNT_CENTS)}, skipping...`;
      console.log(message);

      if (PARTNER_IDS_TO_LOG_PAYOUTS_FOR.includes(partner.id)) {
        await log({
          message,
          type: "alerts",
          mention: true,
        });
      }

      // skip creating a transfer
      return;
    }
  }

  // Minus the withdrawal fee from the total amount
  const finalTransferableAmount = totalTransferableAmount - withdrawalFee;

  const allPayoutsProgramNames = [
    ...new Set(allPayouts.map((p) => p.program.name)), // deduplicate program names
  ];

  // will be used for transfer_group
  const finalPayoutInvoiceId = allPayouts[allPayouts.length - 1].invoiceId;

  const idempotencyKey = createPayoutsIdempotencyKey({
    partnerId: partner.id,
    invoiceId,
    payoutIds: allPayouts.map((p) => p.id),
  });

  // Create a transfer for the partner combined payouts and update it as sent
  const transfer = await stripe.transfers.create(
    {
      amount: finalTransferableAmount,
      currency: "usd",
      // here, `transfer_group` technically only used to associate the transfer with the invoice
      // (even though the transfer could technically include payouts from multiple invoices)
      transfer_group: finalPayoutInvoiceId!,
      destination: partner.stripeConnectId,
      description: `Dub Partners payout transfer (${allPayoutsProgramNames.join(", ")})`,
      metadata: payoutIdsToTransferMetadata(allPayouts.map((p) => p.id)),
      // Omit `source_transaction` if prior processed payouts exist to ensure this transfer
      // never exceeds the original charge amount.
      ...(previouslyProcessedPayouts.length === 0 &&
        chargeId && {
          source_transaction: chargeId,
        }),
    },
    {
      idempotencyKey,
    },
  );

  const message = `Transfer of ${currencyFormatter(finalTransferableAmount)} (${transfer.id}) created for partner ${partner.id} for ${pluralize(
    "payout",
    allPayouts.length,
  )} ${allPayouts.map((p) => p.id).join(", ")}`;

  console.log(message);

  if (PARTNER_IDS_TO_LOG_PAYOUTS_FOR.includes(partner.id)) {
    waitUntil(
      log({
        message,
        type: "alerts",
        mention: true,
      }),
    );
  }

  await markPayoutsAsSent({
    payouts: allPayouts,
    transferId: transfer.id,
    paidAt: new Date(),
  });

  if (partner.email && (forceWithdrawal || currentInvoicePayouts.length > 0)) {
    const payout = currentInvoicePayouts[0];
    const emailRes = await sendEmail({
      variant: "notifications",
      to: partner.email,
      subject: forceWithdrawal
        ? `A withdrawal of ${currencyFormatter(totalTransferableAmount)} has been initiated from your Dub account`
        : `You've received a ${currencyFormatter(payout.amount)} payout from ${payout.program.name}`,
      react: forceWithdrawal
        ? PartnerPayoutForceWithdrawal({
            email: partner.email,
            payout: {
              amount: totalTransferableAmount,
              method: "connect",
            },
          })
        : PartnerPayoutProcessed({
            email: partner.email,
            program: payout.program,
            payout,
          }),
    });

    console.log(`Resend email sent: ${JSON.stringify(emailRes, null, 2)}`);
  }

  return transfer;
};

// Mark the payouts as sent with the given transfer, and their commissions as paid
async function markPayoutsAsSent({
  payouts,
  transferId,
  paidAt,
}: {
  payouts: (Pick<Payout, "id"> & {
    program: Pick<Program, "id" | "workspaceId">;
  })[];
  transferId: string;
  paidAt: Date;
}) {
  const payoutIds = payouts.map((p) => p.id);

  const commissions = await prisma.commission.findMany({
    where: {
      payoutId: {
        in: payoutIds,
      },
    },
    select: {
      id: true,
      amount: true,
      earnings: true,
      status: true,
      programId: true,
    },
  });

  await prisma.payout.updateMany({
    where: {
      id: {
        in: payoutIds,
      },
    },
    data: {
      stripeTransferId: transferId,
      status: "sent",
      paidAt,
      method: "connect",
    },
  });

  const commissionIds = commissions.map((c) => c.id);

  let totalUpdatedCommissions = 0;
  for (const commissionIdsBatch of chunk(commissionIds, 250)) {
    try {
      const { count } = await prisma.commission.updateMany({
        where: {
          id: {
            in: commissionIdsBatch,
          },
        },
        data: {
          status: "paid",
        },
      });

      totalUpdatedCommissions += count;
      console.log(
        `Marked ${totalUpdatedCommissions}/${commissionIds.length} commissions as paid`,
      );
    } catch (error) {
      await log({
        message: `[createStripeTransfer] Failed to mark commissions as paid for payouts ${payoutIds.join(
          ", ",
        )}: ${error.message}`,
        type: "errors",
        mention: true,
      });
    }
  }

  waitUntil(
    Promise.allSettled([
      trackCommissionStatusUpdatesByProgram({
        commissions,
        payouts,
        newStatus: "paid",
      }),

      enqueueBatchJobs(
        payoutIds.map((payoutId) => ({
          queueName: "create-referral-commissions",
          url: `${APP_DOMAIN_WITH_NGROK}/api/cron/commissions/referrals/queue`,
          body: {
            payoutId,
          },
        })),
      ),
    ]),
  );
}
