"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface LimitUxContextValue {
  /** True while the tenant's product limit is exhausted (server state). */
  exhausted: boolean;
  /**
   * True after a client-side openPopup() (e.g. a 402
   * message_limit_reached / subscription_paused from a dashboard
   * caller mid-session) until closePopup(). This is SEPARATE from
   * `exhausted`: it lets the layout-mounted popup render even when
   * the server-computed state at page load was not exhausted, WITHOUT
   * changing `exhausted` — work-action guards that read `exhausted`
   * keep their exact server semantics and no gate is weakened.
   */
  clientTriggered: boolean;
  /** Popup visibility. */
  popupOpen: boolean;
  openPopup: () => void;
  closePopup: () => void;
}

const LimitUxContext = createContext<LimitUxContextValue | null>(null);

/**
 * Carries the server-computed limit-exhausted state through the
 * dashboard tree: the bar and popup live in the dashboard layout, and
 * the work-action (knowledge test send) consumes `exhausted` to disable
 * itself while the rest of the dashboard stays fully usable.
 */
export function LimitUxProvider({
  exhausted,
  children,
}: {
  exhausted: boolean;
  children: ReactNode;
}) {
  const [popupOpen, setPopupOpen] = useState(false);
  // Client-triggered open: set by openPopup() so the popup can render
  // mid-session even when the server state at page load was not
  // exhausted (limit crossed, or subscription paused, after load via
  // another tab/widget). Cleared by closePopup(), so dismissing the
  // popup really dismisses it; a later 402 re-triggers via openPopup().
  const [clientTriggered, setClientTriggered] = useState(false);
  const openPopup = useCallback(() => {
    setClientTriggered(true);
    setPopupOpen(true);
  }, []);
  const closePopup = useCallback(() => {
    setPopupOpen(false);
    setClientTriggered(false);
  }, []);

  const value = useMemo(
    () => ({ exhausted, clientTriggered, popupOpen, openPopup, closePopup }),
    [exhausted, clientTriggered, popupOpen, openPopup, closePopup]
  );

  return (
    <LimitUxContext.Provider value={value}>
      {children}
    </LimitUxContext.Provider>
  );
}

export function useLimitUx(): LimitUxContextValue {
  const ctx = useContext(LimitUxContext);
  if (!ctx) {
    // Outside the dashboard provider (e.g. isolated render) — the
    // limit UX is inert: nothing exhausted, no popup.
    return {
      exhausted: false,
      clientTriggered: false,
      popupOpen: false,
      openPopup: () => {},
      closePopup: () => {},
    };
  }
  return ctx;
}
