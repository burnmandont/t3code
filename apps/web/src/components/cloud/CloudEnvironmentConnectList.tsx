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
import { type ReactNode, useCallback, useEffect, useEffectEvent, useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { cn } from "~/lib/utils";
import { relayEnvironmentDiscovery } from "~/state/relay";
import { useRelayEnvironmentDiscovery } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "../settings/itemRows";
import { Checkbox } from "../ui/checkbox";
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
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { presentSavedCloudEnvironmentConnection } from "./cloudEnvironmentConnectionPresentation";

const EMPTY_DISCOVERY_REFRESH_INTERVAL_MS = 5_000;

export interface SavedCloudEnvironmentConnection {
  readonly environmentId: EnvironmentId;
  readonly connection: EnvironmentConnectionPresentation;
}

function RemoteEnvironmentRowsSkeleton() {
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
  refreshWhileEmpty = false,
  empty = null,
  selection,
  onDiscoveryReady,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly savedEnvironments: ReadonlyArray<SavedCloudEnvironmentConnection>;
  readonly showSavedEnvironments?: boolean;
  readonly refreshWhileEmpty?: boolean;
  readonly empty?: ReactNode;
  readonly onDiscoveryReady?: () => void;
  readonly selection?: {
    readonly autoSelectedComputers?: Set<EnvironmentId>;
    readonly selectedIds: ReadonlySet<EnvironmentId>;
    readonly onChange: (environmentId: EnvironmentId, selected: boolean) => void;
  };
}) {
  const environmentsState = useRelayEnvironmentDiscovery();
  const registerEnvironment = useAtomCommand(environmentCatalog.register, {
    reportFailure: false,
  });
  const refreshRelayEnvironments = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const refreshDiscoveryWhenIdle = useEffectEvent(async () => {
    if (environmentsState.refreshing || environmentsState.offline) return;
    await refreshRelayEnvironments();
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
  const [connectingEnvironmentIds, setConnectingEnvironmentIds] = useState<
    ReadonlySet<EnvironmentId>
  >(new Set());
  const savedById = new Map(
    savedEnvironments.map((environment) => [environment.environmentId, environment]),
  );

  useEffect(() => {
    let active = true;
    if (onDiscoveryReady || !refreshWhileEmpty || document.visibilityState === "visible") {
      void refreshRelayEnvironments().then(() => {
        if (active) onDiscoveryReady?.();
      });
    }
    return () => {
      active = false;
    };
  }, [refreshRelayEnvironments, refreshWhileEmpty, onDiscoveryReady]);

  const connectEnvironment = async (environment: RelayClientEnvironmentRecord) => {
    setConnectingEnvironmentIds((current) => new Set([...current, environment.environmentId]));
    const result = await connectRelayEnvironment(environment);
    setConnectingEnvironmentIds((current) => {
      const next = new Set(current);
      next.delete(environment.environmentId);
      return next;
    });
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: "Environment added",
        description: `Connecting to ${environment.label} through Sovereign Relay.`,
      });
      return true;
    }
    if (isAtomCommandInterrupted(result)) {
      return false;
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
    return false;
  };

  const visibleEnvironments = [...environmentsState.environments.values()].filter(
    ({ environment }) =>
      environment.environmentId !== primaryEnvironmentId &&
      (showSavedEnvironments || !savedById.has(environment.environmentId)),
  );
  const selectNewComputers = useEffectEvent(() => {
    const seen = selection?.autoSelectedComputers;
    if (!selection || !seen) return;
    for (const { environment } of visibleEnvironments) {
      const id = environment.environmentId;
      if (seen.has(id)) continue;
      seen.add(id);
      selection.onChange(id, true);
      if (!savedById.has(id)) {
        void connectEnvironment(environment).then((connected) => {
          if (!connected) selection.onChange(id, false);
        });
      }
    }
  });
  useEffect(() => {
    selectNewComputers();
  }, [environmentsState.environments]);

  // Discovery clears its list on refresh, so poll only until a machine appears.
  const shouldRefreshWhileEmpty =
    refreshWhileEmpty && visibleEnvironments.length === 0 && !environmentsState.offline;

  useEffect(() => {
    if (!shouldRefreshWhileEmpty) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let pending = false;
    const visible = () => document.visibilityState === "visible";
    const schedule = () => {
      clearTimeout(timer);
      if (!disposed && visible()) {
        timer = setTimeout(() => void refresh(), EMPTY_DISCOVERY_REFRESH_INTERVAL_MS);
      }
    };
    const refresh = async () => {
      if (disposed || pending || !visible()) return;
      clearTimeout(timer);
      pending = true;
      try {
        await refreshDiscoveryWhenIdle();
      } finally {
        pending = false;
        schedule();
      }
    };
    const onFocus = () => void refresh();
    const onVisibilityChange = () => {
      clearTimeout(timer);
      if (visible()) void refresh();
    };

    schedule();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [shouldRefreshWhileEmpty]);

  const standalone = showSavedEnvironments || savedEnvironments.length === 0;

  if (
    !refreshWhileEmpty &&
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
    if (selection) {
      return (
        <label
          key={environment.environmentId}
          className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5 has-disabled:cursor-default"
        >
          <Checkbox
            checked={selection.selectedIds.has(environment.environmentId)}
            disabled={connectingEnvironmentIds.has(environment.environmentId)}
            onCheckedChange={async (checked) => {
              selection.onChange(environment.environmentId, checked);
              if (checked && !savedEnvironment) {
                const connected = await connectEnvironment(environment);
                if (!connected) selection.onChange(environment.environmentId, false);
              }
            }}
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{environment.label}</span>
          <Tooltip>
            <TooltipTrigger
              render={<span tabIndex={0} />}
              className={cn(
                "max-w-[45%] shrink-0 truncate text-xs",
                savedConnection?.tone === "error" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {connectingEnvironmentIds.has(environment.environmentId)
                ? "Connecting…"
                : (savedConnection?.buttonLabel ??
                  (availability === "online"
                    ? "Available"
                    : availability === "offline"
                      ? "Offline"
                      : availability === "error"
                        ? "Unavailable"
                        : "Checking…"))}
            </TooltipTrigger>
            <TooltipPopup className="max-w-80 break-words">{statusText}</TooltipPopup>
          </Tooltip>
        </label>
      );
    }
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
                disabled={connectingEnvironmentIds.size > 0}
                onClick={() => void connectEnvironment(environment)}
              >
                {connectingEnvironmentIds.has(environment.environmentId)
                  ? "Connecting…"
                  : "Connect"}
              </Button>
            )}
            <CloudEnvironmentRevocationAction
              environment={environment}
              availability={availability}
              disabled={connectingEnvironmentIds.size > 0}
            />
          </div>
        </div>
      </div>
    );
  });
}
