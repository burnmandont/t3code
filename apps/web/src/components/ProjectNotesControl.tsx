import { NotebookPenIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const localNotesByProjectId = new Map<string, { value: string; pending: boolean }>();

export function ProjectNotesControl(props: {
  readonly projectId: string;
  readonly notes: string;
  readonly onNotesChange: (notes: string) => void;
}) {
  const localNotes = localNotesByProjectId.get(props.projectId);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(localNotes?.value ?? props.notes);
  const latestSaved = useRef(localNotes?.value ?? props.notes);
  const hasNotes = (localNotes?.value ?? props.notes).length > 0;

  useEffect(() => {
    const local = localNotesByProjectId.get(props.projectId);
    if (local?.pending && local.value !== props.notes) {
      return;
    }
    if (local?.pending) {
      localNotesByProjectId.set(props.projectId, { ...local, pending: false });
    }
    latestSaved.current = props.notes;
    if (!open) setDraft(props.notes);
  }, [open, props.notes, props.projectId]);

  useEffect(() => {
    if (!open || draft === latestSaved.current) return;
    const timeout = window.setTimeout(() => {
      latestSaved.current = draft;
      localNotesByProjectId.set(props.projectId, {
        value: draft,
        pending: true,
      });
      props.onNotesChange(draft);
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [draft, open, props]);

  const flushAndSetOpen = (nextOpen: boolean) => {
    if (!nextOpen && draft !== latestSaved.current) {
      latestSaved.current = draft;
      localNotesByProjectId.set(props.projectId, {
        value: draft,
        pending: true,
      });
      props.onNotesChange(draft);
    }
    setOpen(nextOpen);
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="outline"
              aria-label="Project notes"
              className="relative"
              onClick={() => setOpen(true)}
            />
          }
        >
          <NotebookPenIcon className="size-4" />
          {hasNotes ? (
            <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary" />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="top">Project notes</TooltipPopup>
      </Tooltip>

      <Dialog open={open} onOpenChange={flushAndSetOpen}>
        <DialogPopup className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Project notes</DialogTitle>
            <DialogDescription>
              A scratchpad shared by every thread in this project.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Textarea
              autoFocus
              aria-label="Project notes"
              className="min-h-72 resize-y font-mono"
              placeholder="- [ ] Add a note or to-do…"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  flushAndSetOpen(false);
                }
              }}
            />
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
