"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * One guard for unsaved edits across the workspace. A page registers its
 * edits with `useUnsavedChanges`; while any registered page is dirty, every
 * way out asks first: workspace links, the command menu and other
 * programmatic navigation (`useGuardedNavigation().push`), actions that end
 * the page such as switching organization or signing out (`confirmLeave`),
 * the browser's Back button, reload, and closing the tab.
 */

type Guard = { dirty: boolean; changes?: readonly string[] };

type Leave =
  | { kind: "push"; href: string }
  | { kind: "back" }
  | { kind: "action"; run: () => unknown };

type GuardContext = {
  setGuard: (id: string, guard: Guard | null) => void;
  request: (leave: Leave) => void;
  dirty: boolean;
};

const UnsavedChangesContext = React.createContext<GuardContext | null>(null);

/** Marks the extra history entry that keeps Back on a page with edits. */
const HISTORY_GUARD = "cupboardUnsavedGuard";

const guarded = () => window.history.state?.[HISTORY_GUARD] === true;

/**
 * Takes the extra Back entry off once edits are saved or discarded. The
 * browser restores the scroll position the page had when the first edit
 * pushed that entry, which threw the operator away from the field they had
 * just saved, so the position they saved at comes back in the same frame,
 * before it is painted. (`scrollRestoration` can't prevent it: it belongs to
 * each history entry, and the entry restored is the page's own.)
 */
function popHistoryGuard() {
  const x = window.scrollX;
  const y = window.scrollY;
  const done = () => {
    window.removeEventListener("popstate", done);
    window.requestAnimationFrame(() => {
      if (window.scrollX !== x || window.scrollY !== y) window.scrollTo(x, y);
    });
  };
  window.addEventListener("popstate", done);
  window.history.back();
}

function pushHistoryGuard() {
  // Keep the router's own state on the entry so it treats it as this page.
  window.history.pushState(
    { ...window.history.state, [HISTORY_GUARD]: true },
    "",
    window.location.href,
  );
}

/**
 * Where Cancel puts focus back. A menu item closes with its menu, so a
 * leave chosen from a menu (sign out, switch organization) returns to the
 * button that opened the menu, which labels the menu.
 */
function focusToRestore() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return null;
  const menu = active.closest('[role="menu"]');
  const trigger = menu?.getAttribute("aria-labelledby");
  if (trigger) {
    const button = document.getElementById(trigger);
    if (button) return button;
  }
  return active;
}

function UnsavedChangesProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [guards, setGuards] = React.useState<ReadonlyMap<string, Guard>>(
    () => new Map(),
  );
  const [pending, setPendingState] = React.useState<Leave | null>(null);
  // The prompt has no trigger, so Cancel returns focus here itself.
  const returnTo = React.useRef<HTMLElement | null>(null);
  const setPending = React.useCallback((leave: Leave | null) => {
    if (leave) returnTo.current = focusToRestore();
    setPendingState(leave);
  }, []);
  const dirtyGuards = [...guards.values()].filter((guard) => guard.dirty);
  const dirty = dirtyGuards.length > 0;
  const dirtyRef = React.useRef(dirty);
  // Set once the operator chose to leave, so nothing asks again on the way out.
  const leaving = React.useRef(false);

  React.useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  // A finished navigation re-arms the guard for the next page.
  React.useEffect(() => {
    leaving.current = false;
  }, [pathname]);

  const setGuard = React.useCallback((id: string, guard: Guard | null) => {
    setGuards((current) => {
      const existing = current.get(id);
      if (
        guard &&
        existing?.dirty === guard.dirty &&
        existing.changes?.join("\n") === guard.changes?.join("\n")
      )
        return current;
      if (!guard && !existing) return current;
      const next = new Map(current);
      if (guard) next.set(id, guard);
      else next.delete(id);
      return next;
    });
  }, []);

  const perform = React.useCallback(
    (leave: Leave) => {
      if (leave.kind === "push") {
        if (dirtyRef.current) leaving.current = true;
        // Take the place of the page's extra Back entry, so Back from the
        // next page returns here once, not twice.
        if (guarded()) router.replace(leave.href);
        else router.push(leave.href);
      } else if (leave.kind === "back") {
        leaving.current = true;
        window.history.back();
      } else {
        leaving.current = true;
        // An action that fails without leaving (a refused organization
        // switch) puts the guard back.
        void Promise.resolve()
          .then(leave.run)
          .finally(() => {
            leaving.current = false;
          });
      }
    },
    [router],
  );

  const request = React.useCallback(
    (leave: Leave) => {
      if (!dirtyRef.current || leaving.current) perform(leave);
      else setPending(leave);
    },
    [perform, setPending],
  );

  React.useEffect(() => {
    if (!dirty) return;
    if (!guarded()) pushHistoryGuard();
    const popState = () => {
      if (leaving.current || guarded()) return;
      setPending({ kind: "back" });
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (leaving.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const click = (event: MouseEvent) => {
      if (
        leaving.current ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (
        url.pathname === window.location.pathname &&
        url.search === window.location.search
      )
        return;
      // Capture phase on the document runs before React and Next's Link.
      event.preventDefault();
      event.stopPropagation();
      setPending({
        kind: "push",
        href: `${url.pathname}${url.search}${url.hash}`,
      });
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("popstate", popState);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("popstate", popState);
      document.removeEventListener("click", click, true);
      // Saved or discarded: take the extra Back entry off again. Only while it
      // is the current entry: after a navigation away the current entry
      // belongs to the next page and must not be popped.
      if (!leaving.current && guarded()) popHistoryGuard();
    };
  }, [dirty, setPending]);

  const context = React.useMemo(
    () => ({ setGuard, request, dirty }),
    [setGuard, request, dirty],
  );
  const changes = dirtyGuards.flatMap((guard) => guard.changes ?? []);

  return (
    <UnsavedChangesContext.Provider value={context}>
      {children}
      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (open) return;
          // Staying after Back: put the extra entry back for the next Back.
          if (pending?.kind === "back" && !leaving.current) pushHistoryGuard();
          setPending(null);
        }}
      >
        <AlertDialogContent
          data-slot="unsaved-changes-prompt"
          // Without a list of changes the title says it all.
          {...(changes.length ? {} : { "aria-describedby": undefined })}
          onCloseAutoFocus={(event) => {
            const target = returnTo.current;
            returnTo.current = null;
            if (leaving.current || !target?.isConnected) return;
            event.preventDefault();
            target.focus({ preventScroll: true });
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            {changes.length > 0 && (
              <AlertDialogDescription asChild>
                <div>
                  <p>
                    {changes.length === 1 ? "Your change:" : "Your changes:"}
                  </p>
                  <ul className="mt-1 list-disc pl-5 text-foreground">
                    {changes.map((change) => (
                      <li key={change}>{change}</li>
                    ))}
                  </ul>
                </div>
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive-solid"
              onClick={() => {
                const leave = pending;
                leaving.current = true;
                setPending(null);
                if (leave) perform(leave);
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </UnsavedChangesContext.Provider>
  );
}

/**
 * Registers a page's unsaved edits with the workspace guard. While `dirty`,
 * leaving the page asks first. `changes` names what is pending, one item
 * each ("Footer text", "Logo"), listed in the prompt.
 */
function useUnsavedChanges(
  dirty: boolean,
  { changes }: { changes?: readonly string[] } = {},
) {
  const context = React.useContext(UnsavedChangesContext);
  const id = React.useId();
  const setGuard = context?.setGuard;
  React.useEffect(() => {
    setGuard?.(id, { dirty, changes });
  }, [setGuard, id, dirty, changes]);
  React.useEffect(() => () => setGuard?.(id, null), [setGuard, id]);
}

/**
 * Navigation that respects unsaved edits. `push` is router navigation within
 * the app; `confirmLeave` runs an action that ends the page (switching
 * organization, signing out) once the operator agrees. Outside the provider
 * both act at once.
 */
function useGuardedNavigation() {
  const context = React.useContext(UnsavedChangesContext);
  const router = useRouter();
  const request = context?.request;
  const push = React.useCallback(
    (href: string) =>
      request ? request({ kind: "push", href }) : router.push(href),
    [request, router],
  );
  const confirmLeave = React.useCallback(
    (run: () => unknown) =>
      request ? request({ kind: "action", run }) : void run(),
    [request],
  );
  return { dirty: context?.dirty ?? false, push, confirmLeave };
}

export { UnsavedChangesProvider, useGuardedNavigation, useUnsavedChanges };
