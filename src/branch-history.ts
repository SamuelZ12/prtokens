import type { CommandRunner } from './git-resolver.js';
import type { UsageEvent } from './types.js';

export interface BranchCheckout {
  timestamp: string;
  fromBranch: string;
  toBranch: string;
}

export async function readBranchCheckouts(input: {
  runner: CommandRunner;
  cwd: string | undefined;
}): Promise<BranchCheckout[]> {
  try {
    const result = await input.runner.run('git', ['reflog', '--date=iso-strict', '--format=%gD%x00%gs'], {
      cwd: input.cwd,
    });

    return parseBranchCheckouts(result.stdout);
  } catch {
    return [];
  }
}

export function parseBranchCheckouts(reflog: string): BranchCheckout[] {
  return reflog
    .split('\n')
    .map((line) => parseBranchCheckoutLine(line))
    .filter((checkout): checkout is BranchCheckout => checkout !== undefined)
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

export function repairStaleCodexBranches(
  events: UsageEvent[],
  checkouts: BranchCheckout[],
  targetBranch: string,
): UsageEvent[] {
  if (checkouts.length === 0) {
    return events;
  }

  return events.map((event) => {
    if (event.agent !== 'codex' || event.gitBranch === targetBranch || event.gitBranch === undefined) {
      return event;
    }

    const activeBranch = branchAtTimestamp(checkouts, event.timestamp);
    if (activeBranch !== targetBranch) {
      return event;
    }

    return { ...event, gitBranch: targetBranch };
  });
}

export function latestCheckoutToBranchBefore(
  checkouts: BranchCheckout[],
  targetBranch: string,
  timestamp: string,
): string | undefined {
  const cutoffTime = Date.parse(timestamp);
  if (Number.isNaN(cutoffTime)) {
    return undefined;
  }

  let latest: string | undefined;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const checkout of checkouts) {
    const checkoutTime = Date.parse(checkout.timestamp);
    if (Number.isNaN(checkoutTime) || checkoutTime > cutoffTime) {
      continue;
    }
    if (checkout.toBranch === targetBranch && checkoutTime >= latestTime) {
      latest = checkout.timestamp;
      latestTime = checkoutTime;
    }
  }

  return latest;
}

function parseBranchCheckoutLine(line: string): BranchCheckout | undefined {
  const [reflogSelector, message] = line.split('\0');
  if (!reflogSelector || !message) {
    return undefined;
  }

  const timestamp = reflogSelector.match(/^HEAD@\{(.+)\}$/)?.[1];
  const checkout = message.match(/^checkout: moving from (.+) to (.+)$/);
  if (!timestamp || !checkout) {
    return undefined;
  }

  return {
    timestamp,
    fromBranch: checkout[1],
    toBranch: checkout[2],
  };
}

function branchAtTimestamp(checkouts: BranchCheckout[], timestamp: string): string | undefined {
  const eventTime = Date.parse(timestamp);
  if (Number.isNaN(eventTime)) {
    return undefined;
  }

  let activeBranch = checkouts[0]?.fromBranch;
  for (const checkout of checkouts) {
    const checkoutTime = Date.parse(checkout.timestamp);
    if (Number.isNaN(checkoutTime)) {
      continue;
    }
    if (checkoutTime > eventTime) {
      break;
    }
    activeBranch = checkout.toBranch;
  }

  return activeBranch;
}
