import { stripe } from "@/lib/stripe";
import { chunk } from "@dub/utils";

// Stripe caps a metadata value at 500 characters and an object at 50 keys.
// A payout id is 29 characters, so 15 ids fit in one value.
const PAYOUT_IDS_PER_KEY = 15;
const MAX_METADATA_KEYS = 50;
const METADATA_KEY_PREFIX = "dubPayoutIds";

// Record which payouts a Stripe transfer pays, so a later run can find the transfer
// even if the payouts were never marked as sent.
export function payoutIdsToTransferMetadata(
  payoutIds: string[],
): Record<string, string> {
  const chunks = chunk(payoutIds, PAYOUT_IDS_PER_KEY);

  if (chunks.length > MAX_METADATA_KEYS) {
    console.warn(
      `Too many payouts (${payoutIds.length}) to record in the transfer metadata, skipping...`,
    );
    return {};
  }

  return Object.fromEntries(
    chunks.map((ids, i) => [`${METADATA_KEY_PREFIX}${i}`, ids.join(",")]),
  );
}

function payoutIdsFromTransferMetadata(
  metadata: Record<string, string> | null | undefined,
) {
  return Object.entries(metadata ?? {})
    .filter(([key]) => key.startsWith(METADATA_KEY_PREFIX))
    .flatMap(([, value]) => value.split(","));
}

// Find Stripe transfers that already pay any of the given payouts.
// Returns a map of payout id -> transfer.
export async function findTransferredPayouts({
  stripeConnectId,
  payouts,
}: {
  stripeConnectId: string;
  payouts: { id: string; createdAt: Date }[];
}) {
  const transferredPayouts = new Map<string, { id: string; created: number }>();

  if (payouts.length === 0) {
    return transferredPayouts;
  }

  const payoutIds = new Set(payouts.map((p) => p.id));

  // a transfer for these payouts can't be older than the oldest payout
  const createdAfter = Math.floor(
    Math.min(...payouts.map((p) => p.createdAt.getTime())) / 1000,
  );

  for await (const transfer of stripe.transfers.list({
    destination: stripeConnectId,
    created: {
      gte: createdAfter,
    },
    limit: 100,
  })) {
    // a reversed transfer moves its payouts back to "processed" (see transfer-reversed.ts),
    // so those payouts still need to be paid
    if (transfer.amount_reversed > 0) {
      continue;
    }

    for (const payoutId of payoutIdsFromTransferMetadata(transfer.metadata)) {
      if (payoutIds.has(payoutId)) {
        transferredPayouts.set(payoutId, {
          id: transfer.id,
          created: transfer.created,
        });
      }
    }
  }

  return transferredPayouts;
}
