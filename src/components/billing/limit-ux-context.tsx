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
  /** True while the tenant's product limit is exhausted. */
  exhausted: boolean;
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
  const openPopup = useCallback(() => setPopupOpen(true), []);
  const closePopup = useCallback(() => setPopupOpen(false), []);

  const value = useMemo(
    () => ({ exhausted, popupOpen, openPopup, closePopup }),
    [exhausted, popupOpen, openPopup, closePopup]
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
      popupOpen: false,
      openPopup: () => {},
      closePopup: () => {},
    };
  }
  return ctx;
}
