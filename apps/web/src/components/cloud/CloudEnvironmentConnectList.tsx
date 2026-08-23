import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import {
  type EnvironmentConnectionPresentation,
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import { EllipsisIcon, ShieldOffIcon } from "lucide-react";
import * as Option from "effect/Option";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { cn } from "~/lib/utils";
import { relayEnvironmentDiscovery } from "~/state/relay";
import { useRelayEnvironmentDiscovery } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "../settings/itemRows";
import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { presentSavedCloudEnvironmentConnection } from "./cloudEnvironmentConnectionPresentation";

export interface SavedCloudEnvironmentConnection {
  readonly environmentId: EnvironmentId;
  readonly connection: EnvironmentConnectionPresentation;
}

export function RemoteEnvironmentRowsSkeleton() {
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-4 w-32 rounded-full" />
          <Skeleton className="h-3 w-20 rounded-full" />
        </div>
        <Skeleton className="h-7 w-16 rounded-md" />
      </div>
    </div>
  );
}

function abbreviatedEnvironmentId(environmentId: string): string {
  return environmentId.length > 16
    ? `${environmentId.slice(0, 8)}…${environmentId.slice(-4)}`
    : environmentId;
}

function endpointHostname(environment: RelayClientEnvironmentRecord): string {
  try {
    return new URL(environment.endpoint.httpBaseUrl).hostname;
  } catch {
    return environment.endpoint.httpBaseUrl;
  }
}

function revocationAvailabilityText(
  availability: "checking" | "online" | "offline" | "error",
): string {
  switch (availability) {
    case "online":
      return "online";
    case "offline":
      return "offline";
    case "checking":
      return "being checked";
    case "error":
      return "not currently reachable";
  }
}

export function CloudEnvironmentRevocationAction({
  environment,
  availability,
  disabled = false,
  onRevoked,
}: {
  readonly environment: RelayClientEnvironmentRecord;
  readonly availability: "checking" | "online" | "offline" | "error";
  readonly disabled?: boolean;
  readonly onRevoked?: () => void | Promise<void>;
}) {
  const revokeEnvironment = useAtomCommand(relayEnvironmentDiscovery.revoke, {
    reportFailure: false,
  });
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const confirmRevocation = async () => {
    setRevoking(true);
    const result = await revokeEnvironment(environment.environmentId);
    if (result._tag === "Success") {
      setConfirmationOpen(false);
      await onRevoked?.();
      toastManager.add({
        type: result.value.cleanupPending ? "warning" : "success",
        title: result.value.cleanupPending
          ? "Access revoked; cleanup queued"
          : "Environment access revoked",
        description: result.value.cleanupPending
          ? "This identity cannot relink. Tunnel cleanup will be retried automatically."
          : `${environment.label} can no longer connect with this environment identity.`,
      });
      setRevoking(false);
      return;
    }
    setRevoking(false);
    if (isAtomCommandInterrupted(result)) {
      return;
    }
    const cause = squashAtomCommandFailure(result);
    const message = cause instanceof Error ? cause.message : "Could not revoke the environment.";
    const traceId = findErrorTraceId(cause);
    toastManager.add({
      type: "error",
      title: "Could not revoke environment access",
      description: message,
      data: traceId
        ? {
            secondaryActionProps: {
              children: "Copy trace ID",
              onClick: () => void navigator.clipboard?.writeText(traceId),
            },
          }
        : undefined,
    });
  };

  return (
    <>
      <Menu>
        <MenuTrigger
          disabled={disabled || revoking}
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Actions for ${environment.label}`}
            />
          }
        >
          {revoking ? <Spinner className="size-3.5" /> : <EllipsisIcon className="size-3.5" />}
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-52">
          <MenuItem variant="destructive" onClick={() => setConfirmationOpen(true)}>
            <ShieldOffIcon />
            Remove from Sovereign Relay…
          </MenuItem>
        </MenuPopup>
      </Menu>
      <AlertDialog
        open={confirmationOpen}
        onOpenChange={(open) => {
          if (!revoking) setConfirmationOpen(open);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke “{environment.label}”?</AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <span className="block">
                This environment is currently {revocationAvailabilityText(availability)}. Its relay
                credential and tunnel will be revoked, and the same immutable identity cannot
                relink—even if its server is still running.
              </span>
              <span className="block rounded-md border border-border/60 bg-muted/30 p-2 font-mono text-xs">
                ID {abbreviatedEnvironmentId(environment.environmentId)} ·{" "}
                {endpointHostname(environment)}
              </span>
              <span className="block">
                Files, projects, and agent history on the remote machine are not deleted. Connecting
                it again requires resetting or reinstalling its T3 environment identity.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={revoking}
              render={<Button variant="outline" disabled={revoking} />}
            >
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={revoking} onClick={confirmRevocation}>
              {revoking ? (
                <>
                  <Spinner className="size-3.5" />
                  Revoking…
                </>
              ) : (
                "Revoke access"
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/**
 * The user's Sovereign Relay environments from relay discovery, each with a
 * Connect button. The primary environment is always excluded; already-saved
 * environments are hidden unless `showSavedEnvironments` renders them with
 * their live connection state (used by onboarding, where the full device mesh
 * should be visible).
 */
export function CloudEnvironmentConnectRows({
  primaryEnvironmentId,
  savedEnvironments,
  showSavedEnvironments = false,
  empty = null,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly savedEnvironments: ReadonlyArray<SavedCloudEnvironmentConnection>;
  readonly showSavedEnvironments?: boolean;
  readonly empty?: ReactNode;
}) {
  const environmentsState = useRelayEnvironmentDiscovery();
  const registerEnvironment = useAtomCommand(environmentCatalog.register, {
    reportFailure: false,
  });
  const refreshRelayEnvironments = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const connectRelayEnvironment = useCallback(
    (environment: RelayClientEnvironmentRecord) =>
      registerEnvironment(
        new RelayConnectionRegistration({
          target: new RelayConnectionTarget({
            environmentId: environment.environmentId,
            label: environment.label,
          }),
        }),
      ),
    [registerEnvironment],
  );
  const [connectingEnvironmentId, setConnectingEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const savedById = new Map(
    savedEnvironments.map((environment) => [environment.environmentId, environment]),
  );

  useEffect(() => {
    void refreshRelayEnvironments();
  }, [refreshRelayEnvironments]);

  const connectEnvironment = async (environment: RelayClientEnvironmentRecord) => {
    setConnectingEnvironmentId(environment.environmentId);
    const result = await connectRelayEnvironment(environment);
    setConnectingEnvironmentId(null);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: "Environment added",
        description: `Connecting to ${environment.label} through Sovereign Relay.`,
      });
      return;
    }
    if (isAtomCommandInterrupted(result)) {
      return;
    }
    const cause = squashAtomCommandFailure(result);
    const message =
      cause instanceof Error ? cause.message : "Could not connect the Sovereign Relay environment.";
    const traceId = findErrorTraceId(cause);
    console.error("[t3-connect] Could not connect environment", { message, traceId, cause });
    toastManager.add({
      type: "error",
      title: "Could not connect environment",
      description: message,
      data: traceId
        ? {
            secondaryActionProps: {
              children: "Copy trace ID",
              onClick: () => void navigator.clipboard?.writeText(traceId),
            },
          }
        : undefined,
    });
  };

  const visibleEnvironments = [...environmentsState.environments.values()].filter(
    ({ environment }) =>
      environment.environmentId !== primaryEnvironmentId &&
      (showSavedEnvironments || !savedById.has(environment.environmentId)),
  );

  const standalone = showSavedEnvironments || savedEnvironments.length === 0;

  if (
    standalone &&
    visibleEnvironments.length === 0 &&
    environmentsState.refreshing &&
    environmentsState.environments.size === 0
  ) {
    return <RemoteEnvironmentRowsSkeleton />;
  }

  if (standalone && visibleEnvironments.length === 0) {
    // A failed or offline discovery is not "no environments" — misreporting it
    // as empty would read as the user's devices having disappeared.
    const discoveryProblem = environmentsState.offline
      ? "You appear to be offline."
      : (Option.getOrNull(environmentsState.error)?.message ?? null);
    if (discoveryProblem !== null && !environmentsState.refreshing) {
      return (
        <div className={ITEM_ROW_CLASSNAME}>
          <p className="text-sm font-medium text-destructive">
            Could not load Sovereign Relay environments
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{discoveryProblem}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() => void refreshRelayEnvironments()}
          >
            Try again
          </Button>
        </div>
      );
    }
    return empty;
  }

  return visibleEnvironments.map(({ environment, availability, error }) => {
    const savedEnvironment = savedById.get(environment.environmentId);
    const savedConnection = savedEnvironment
      ? presentSavedCloudEnvironmentConnection(savedEnvironment.connection)
      : null;
    const dotClassName = savedConnection
      ? savedConnection.tone === "connected"
        ? "bg-success"
        : savedConnection.tone === "connecting"
          ? "bg-warning"
          : savedConnection.tone === "error"
            ? "bg-destructive"
            : "bg-muted-foreground/35"
      : availability === "online"
        ? "bg-success"
        : availability === "error"
          ? "bg-destructive"
          : availability === "checking"
            ? "bg-warning"
            : "bg-muted-foreground/35";
    const statusText = savedConnection
      ? savedConnection.statusText
      : availability === "online"
        ? "Available · Relay online"
        : availability === "offline"
          ? "Available · Relay offline"
          : availability === "checking"
            ? "Available · Checking relay status…"
            : (Option.getOrNull(error)?.message ?? "Available · Relay status unavailable");
    return (
      <div key={environment.environmentId} className={ITEM_ROW_CLASSNAME}>
        <div className={ITEM_ROW_INNER_CLASSNAME}>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ConnectionStatusDot
                dotClassName={dotClassName}
                pingClassName={
                  savedConnection?.tone === "connecting" ||
                  (savedConnection === null && availability === "checking")
                    ? "bg-warning/60 duration-2000"
                    : null
                }
                tooltipText={
                  savedConnection
                    ? savedConnection.statusText
                    : availability === "online"
                      ? "Relay online"
                      : availability === "offline"
                        ? "Relay offline"
                        : availability === "checking"
                          ? "Checking relay status"
                          : (Option.getOrNull(error)?.message ?? "Relay status unavailable")
                }
              />
              <p className="truncate text-sm font-medium">{environment.label}</p>
            </div>
            <p
              className={cn(
                "mt-1 truncate text-xs",
                savedConnection?.tone === "error" ||
                  (savedConnection?.tone === "connecting" && savedEnvironment?.connection.error) ||
                  (savedConnection === null && availability === "error")
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {statusText}
            </p>
          </div>
          <div className="flex items-center gap-1">
            {savedConnection ? (
              <Button size="sm" variant="outline" disabled>
                {savedConnection.buttonLabel}
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={connectingEnvironmentId !== null}
                onClick={() => void connectEnvironment(environment)}
              >
                {connectingEnvironmentId === environment.environmentId ? "Connecting…" : "Connect"}
              </Button>
            )}
            <CloudEnvironmentRevocationAction
              environment={environment}
              availability={availability}
              disabled={connectingEnvironmentId !== null}
            />
          </div>
        </div>
      </div>
    );
  });
}
