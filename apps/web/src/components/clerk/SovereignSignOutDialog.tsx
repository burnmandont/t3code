import { useState } from "react";

import { useCloudAuth } from "../../cloud/auth";
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
import { toastManager } from "../ui/toast";

export function SovereignSignOutDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { accountLabel, signOut } = useCloudAuth();
  const [submitting, setSubmitting] = useState(false);

  const confirm = async () => {
    setSubmitting(true);
    try {
      const result = await signOut();
      onOpenChange(false);
      if (!result.revoked) {
        toastManager.add({
          type: "warning",
          title: "Signed out locally",
          description:
            "The account service could not confirm server-side token revocation. The local session was removed.",
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Sign out of Sovereign Relay?</AlertDialogTitle>
          <AlertDialogDescription>
            {accountLabel ? `This signs ${accountLabel} out` : "This signs this account out"} on
            this client and revokes its session. Your remote environments will keep running and
            remain linked to the account.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={submitting} />}>
            Cancel
          </AlertDialogClose>
          <Button variant="destructive" disabled={submitting} onClick={() => void confirm()}>
            {submitting ? "Signing out…" : "Sign out"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
