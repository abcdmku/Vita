import type { AgentCapabilityState, AgentClient } from "./agent-client.ts";

export interface AgentStateSummary {
  readonly caps: number;
  readonly hostname: string;
}

export type AgentStateSummaryResult =
  | {
      readonly ok: true;
      readonly state: AgentStateSummary;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

const HOSTNAME_CAPABILITY = "hostname.set";

export async function readAgentStateSummary(
  client: Pick<AgentClient, "getOperations" | "getState">,
): Promise<AgentStateSummaryResult> {
  try {
    const operations = await client.getOperations();
    const hostnameState = await client.getState(HOSTNAME_CAPABILITY);
    const hostname = readHostname(hostnameState);

    if (!hostname.ok) {
      return hostname;
    }

    return {
      ok: true,
      state: {
        caps: operations.length,
        hostname: hostname.value,
      },
    };
  } catch (cause) {
    return {
      ok: false,
      reason: describeError(cause),
    };
  }
}

export function formatAgentStateMarker(state: AgentStateSummary): string {
  return `VITA-STATE: caps=${state.caps} hostname=${state.hostname} status=OK`;
}

function readHostname(
  state: AgentCapabilityState,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string } {
  const current = Object.hasOwn(state, "current") ? state["current"] : undefined;

  if (typeof current !== "string" || current.length === 0) {
    return {
      ok: false,
      reason: "hostname.set state is missing current hostname",
    };
  }

  return {
    ok: true,
    value: current,
  };
}

function describeError(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0
    ? cause.message
    : "agent state read failed";
}
