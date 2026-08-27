import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { DesktopSovereignCloudAuthProvider, useCloudAuth } from "./auth";

class TestNode {
  readonly nodeName: string;
  readonly ownerDocument: TestNode;
  readonly nodeType: number;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style = {};
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];

  constructor(name: string, ownerDocument?: TestNode, nodeType = 1) {
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
    this.ownerDocument = ownerDocument ?? this;
    this.nodeType = nodeType;
  }

  set textContent(_value: string) {
    this.childNodes = [];
  }

  appendChild(child: TestNode) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: TestNode) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }

  createElement(name: string) {
    return new TestNode(name, this);
  }

  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
}

function installTestDom() {
  const document = new TestNode("#document", undefined, 9);
  const window = {
    document,
    HTMLIFrameElement: TestNode,
    location: { href: "sovereign://app/" },
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("HTMLIFrameElement", TestNode);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return document;
}

const config = {
  provider: "sovereign" as const,
  issuer: "https://auth.example.test",
  clientId: "t3-code",
  resource: "urn:t3:relay",
};

afterEach(() => vi.unstubAllGlobals());

describe("desktop sovereign auth restoration", () => {
  it("does not publish a transient signed-out event before the restored snapshot", async () => {
    const document = installTestDom();
    let emitStateChange: ((snapshot: DesktopSovereignAuthSnapshot) => void) | undefined;
    let resolveSnapshot: ((snapshot: DesktopSovereignAuthSnapshot) => void) | undefined;
    const getSnapshot = vi.fn(
      () =>
        new Promise<DesktopSovereignAuthSnapshot>((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    Object.assign(window, {
      desktopBridge: {
        sovereignAuth: {
          getSnapshot,
          getToken: vi.fn(async () => "token"),
          beginSignIn: vi.fn(),
          signOut: vi.fn(),
          onStateChange: (listener: (snapshot: DesktopSovereignAuthSnapshot) => void) => {
            emitStateChange = listener;
            return vi.fn();
          },
        },
      },
    });
    const observed: Array<{ readonly isSignedIn: boolean; readonly userId: string | null }> = [];
    function Observer() {
      const auth = useCloudAuth();
      observed.push({ isSignedIn: auth.isSignedIn, userId: auth.userId });
      return null;
    }
    const root = createRoot(document.createElement("div") as unknown as Element);

    try {
      await act(() => {
        root.render(
          <DesktopSovereignCloudAuthProvider config={config}>
            <Observer />
          </DesktopSovereignCloudAuthProvider>,
        );
      });
      await act(() => {
        emitStateChange?.({
          isSignedIn: false,
          userId: null,
          email: null,
          name: null,
        });
      });
      await act(() => {
        resolveSnapshot?.({
          isSignedIn: true,
          userId: "account-1",
          email: "sam@example.test",
          name: "Sam",
        });
      });

      expect(observed).toEqual([{ isSignedIn: true, userId: "account-1" }]);
    } finally {
      await act(() => root.unmount());
    }
  });
});

interface DesktopSovereignAuthSnapshot {
  readonly isSignedIn: boolean;
  readonly userId: string | null;
  readonly email: string | null;
  readonly name: string | null;
}
