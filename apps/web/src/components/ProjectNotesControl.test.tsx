import { act, cloneElement, createElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("./ui/button", () => ({
  Button: (props: Record<string, unknown>) => createElement("button", props),
}));

vi.mock("./ui/dialog", () => {
  const Container = ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children);
  return {
    Dialog: ({
      children,
      onOpenChange,
      open,
    }: {
      readonly children?: ReactNode;
      readonly onOpenChange: (open: boolean) => void;
      readonly open: boolean;
    }) => (open ? createElement("section", { "data-dialog": true, onOpenChange }, children) : null),
    DialogDescription: Container,
    DialogHeader: Container,
    DialogPanel: Container,
    DialogPopup: Container,
    DialogTitle: Container,
  };
});

vi.mock("./ui/textarea", () => ({
  Textarea: (props: Record<string, unknown>) => createElement("textarea", props),
}));

vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { readonly children?: ReactNode }) => children,
  TooltipPopup: ({ children }: { readonly children?: ReactNode }) => children,
  TooltipTrigger: ({
    children,
    render,
  }: {
    readonly children?: ReactNode;
    readonly render: ReactNode;
  }) => cloneElement(render as ReactElement, undefined, children),
}));

import { ProjectNotesControl } from "./ProjectNotesControl";

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    clearTimeout: globalThis.clearTimeout,
    setTimeout: globalThis.setTimeout,
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function openNotes(onNotesChange: (notes: string) => void) {
  await act(() => {
    renderer = create(
      <ProjectNotesControl
        projectId="project-notes-test"
        notes="existing note"
        onNotesChange={onNotesChange}
      />,
    );
  });
  await act(() => {
    renderer!.root.findByProps({ "aria-label": "Project notes" }).props.onClick();
  });
  return renderer!.root.findByType("textarea");
}

describe("project notes scratchpad", () => {
  it("opens with saved project notes and persists edits after the debounce", async () => {
    const onNotesChange = vi.fn();
    const textarea = await openNotes(onNotesChange);

    expect(textarea.props.value).toBe("existing note");
    await act(() => {
      textarea.props.onChange({ target: { value: "updated note" } });
    });
    expect(onNotesChange).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(onNotesChange).toHaveBeenCalledOnce();
    expect(onNotesChange).toHaveBeenCalledWith("updated note");
  });

  it("flushes an unsaved edit when the scratchpad closes", async () => {
    const onNotesChange = vi.fn();
    const textarea = await openNotes(onNotesChange);

    await act(() => {
      textarea.props.onChange({ target: { value: "save on close" } });
    });
    await act(() => {
      renderer!.root.findByProps({ "data-dialog": true }).props.onOpenChange(false);
    });

    expect(onNotesChange).toHaveBeenCalledOnce();
    expect(onNotesChange).toHaveBeenCalledWith("save on close");
  });
});
