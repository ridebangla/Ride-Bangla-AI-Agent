"use client";

/**
 * Dashboard > Orders (Phase 2).
 * Tab 1 — Orders: tenant-scoped order list from the `orders` collection,
 *   with confirm/cancel actions and an expandable detail view.
 * Tab 2 — Order Settings: the per-business order-flow builder
 *   (businesses.orderFields) — add/remove/reorder custom fields the AI
 *   must collect before recording an order.
 */

import { Header } from "@/components/layout/header";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import {
  ClipboardList,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  CheckCircle,
  AlertCircle,
  Loader2,
  Save,
  Sparkles,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { useEffect, useState, Fragment } from "react";

const inputClasses =
  "w-full px-3 py-2 text-sm border border-rbai-border rounded-lg bg-rbai-bg text-rbai-text placeholder:text-rbai-text-light/60 focus:outline-none focus:ring-2 focus:ring-rbai-primary/30 focus:border-rbai-primary transition-colors";

interface Toast {
  id: number;
  type: "success" | "error";
  message: string;
}

function ToastContainer({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg text-sm font-medium",
            t.type === "success" ? "bg-rbai-success text-white" : "bg-rbai-danger text-white"
          )}
        >
          {t.type === "success" ? (
            <CheckCircle className="h-4 w-4 flex-shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
          )}
          {t.message}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OrderItem {
  name: string;
  qty: number;
  price?: number | null;
  productId?: string | null;
}

interface CourierBookingView {
  state: string;
  courierOrderId?: string;
  missing?: string[];
  opsStatus?: string;
}

interface CourierDeliveryView {
  opsStatus: string | null;
  dispatchStatus: string | null;
  riderAssigned: boolean;
  phase: string;
}

interface Order {
  id: string;
  conversationId: string | null;
  customerId: string | null;
  items: OrderItem[];
  customFields: Record<string, unknown>;
  status: "pending" | "confirmed" | "cancelled";
  total: number | null;
  summary?: string;
  createdAt: string;
  courierBooking?: CourierBookingView | null;
  courierDelivery?: CourierDeliveryView | null;
}

function courierBookingLabel(b: CourierBookingView): string {
  switch (b.state) {
    case "booked":
      return "Booked with Ride Bangla Courier";
    case "needs_info":
      return `Needs info${b.missing?.length ? ` (missing: ${b.missing.join(", ")})` : ""}`;
    case "cancelled":
      return "Cancelled";
    case "cancel_requested":
      return "Cancel requested";
    case "failed":
      return "Booking failed";
    default:
      return b.state;
  }
}

type FieldType = "text" | "select" | "date" | "number" | "textarea";

interface OrderField {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[];
}

const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: "text", label: "Short text" },
  { value: "textarea", label: "Long text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "select", label: "Dropdown" },
];

const statusStyles: Record<Order["status"], string> = {
  pending: "bg-rbai-warning/10 text-rbai-warning",
  confirmed: "bg-rbai-success/10 text-rbai-success",
  cancelled: "bg-rbai-border/40 text-rbai-text-light",
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OrdersPage() {
  const [tab, setTab] = useState<"orders" | "settings">("orders");
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = (type: "success" | "error", message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, type, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <Header
        title="Orders"
        description="Orders captured by your AI, and the fields it must collect"
        actions={
          <div className="flex items-center gap-1 rounded-lg border border-rbai-border p-1">
            {(
              [
                { key: "orders", label: "Orders" },
                { key: "settings", label: "Order Settings" },
              ] as const
            ).map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  "px-3 py-1.5 text-sm rounded-md transition-colors",
                  tab === t.key
                    ? "bg-rbai-primary text-white font-medium"
                    : "text-rbai-text-light hover:text-rbai-text"
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        }
      />
      {tab === "orders" ? <OrdersTab toast={toast} /> : <OrderSettingsTab toast={toast} />}
      <ToastContainer toasts={toasts} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Orders tab
// ---------------------------------------------------------------------------

function OrdersTab({ toast }: { toast: (t: "success" | "error", m: string) => void }) {
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<Order[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const reload = async (status = statusFilter) => {
    const q = status === "all" ? "" : `?status=${status}`;
    const res = await fetch(`/api/orders${q}`);
    if (!res.ok) throw new Error("Failed to load orders");
    const json = await res.json();
    setOrders(json.orders ?? []);
  };

  useEffect(() => {
    (async () => {
      try {
        await reload("all");
      } catch {
        toast("error", "Could not load orders.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeFilter = async (s: string) => {
    setStatusFilter(s);
    try {
      await reload(s);
    } catch {
      toast("error", "Could not load orders.");
    }
  };

  const setStatus = async (order: Order, status: Order["status"]) => {
    setActing(order.id);
    try {
      const res = await fetch(`/api/orders/${order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Update failed");
      toast("success", `Order ${status}.`);
      await reload();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "Failed.");
    } finally {
      setActing(null);
    }
  };

  const customerLabel = (o: Order) => {
    const cf = o.customFields ?? {};
    const name = cf.customer_name ?? cf.name;
    const phone = cf.phone;
    if (name || phone) return [name, phone].filter(Boolean).join(" · ");
    return "—";
  };

  const itemsLabel = (o: Order) => {
    if (o.summary) return o.summary;
    if (o.items?.length) return o.items.map((i) => `${i.qty}× ${i.name}`).join(", ");
    return "—";
  };

  return (
    <div className="p-6 max-w-6xl space-y-4">
      <div className="flex items-center gap-2">
        {["all", "pending", "confirmed", "cancelled"].map((s) => (
          <button
            key={s}
            onClick={() => changeFilter(s)}
            className={cn(
              "px-3 py-1.5 text-sm rounded-full border capitalize transition-colors",
              statusFilter === s
                ? "bg-rbai-primary text-white border-rbai-primary"
                : "border-rbai-border text-rbai-text hover:bg-rbai-bg"
            )}
          >
            {s}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-rbai-text-light py-10">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading orders…
        </div>
      ) : orders.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No orders yet"
          description="When your AI collects an order in chat, it appears here for your team to confirm."
        />
      ) : (
        <div className="rounded-xl border border-rbai-border bg-rbai-surface overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-rbai-border text-left text-rbai-text-light">
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">Items</th>
                <th className="px-4 py-3 font-medium">Total</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <Fragment key={o.id}>
                  <tr className="border-b border-rbai-border last:border-0 hover:bg-rbai-bg/50">
                    <td className="px-4 py-3 text-rbai-text-light whitespace-nowrap">
                      {new Date(o.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-rbai-text">{String(customerLabel(o))}</td>
                    <td className="px-4 py-3 text-rbai-text-light max-w-xs truncate">{itemsLabel(o)}</td>
                    <td className="px-4 py-3 text-rbai-text font-medium">
                      {o.total != null ? o.total : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn("inline-flex px-2 py-0.5 rounded-full text-xs font-medium capitalize", statusStyles[o.status])}>
                        {o.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          title="Details"
                          onClick={() => setExpanded(expanded === o.id ? null : o.id)}
                          className="p-1.5 rounded text-rbai-text-light hover:text-rbai-text hover:bg-rbai-bg"
                        >
                          {expanded === o.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </button>
                        {o.status === "pending" && (
                          <>
                            <button
                              onClick={() => setStatus(o, "confirmed")}
                              disabled={acting === o.id}
                              className="px-2.5 py-1 text-xs font-medium rounded-lg bg-rbai-success/10 text-rbai-success hover:bg-rbai-success/20 disabled:opacity-50"
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => setStatus(o, "cancelled")}
                              disabled={acting === o.id}
                              className="px-2.5 py-1 text-xs font-medium rounded-lg bg-rbai-danger/10 text-rbai-danger hover:bg-rbai-danger/20 disabled:opacity-50"
                            >
                              Cancel
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                  {expanded === o.id && (
                    <tr className="bg-rbai-bg/40">
                      <td colSpan={6} className="px-6 py-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                          <div>
                            <div className="font-medium text-rbai-text mb-2">Collected details</div>
                            {Object.keys(o.customFields ?? {}).length === 0 ? (
                              <div className="text-rbai-text-light">No extra fields.</div>
                            ) : (
                              <dl className="space-y-1">
                                {Object.entries(o.customFields).map(([k, v]) => (
                                  <div key={k} className="flex gap-2">
                                    <dt className="text-rbai-text-light min-w-32">{k.replace(/_/g, " ")}:</dt>
                                    <dd className="text-rbai-text">{String(v)}</dd>
                                  </div>
                                ))}
                              </dl>
                            )}
                          </div>
                          <div>
                            <div className="font-medium text-rbai-text mb-2">Meta</div>
                            <dl className="space-y-1">
                              <div className="flex gap-2">
                                <dt className="text-rbai-text-light min-w-32">Reference:</dt>
                                <dd className="text-rbai-text font-mono text-xs">{o.id.slice(0, 8)}</dd>
                              </div>
                              {o.conversationId && (
                                <div className="flex gap-2">
                                  <dt className="text-rbai-text-light min-w-32">Conversation:</dt>
                                  <dd>
                                    <a href={`/conversations?c=${o.conversationId}`} className="text-rbai-primary hover:underline font-mono text-xs">
                                      {o.conversationId.slice(0, 8)}
                                    </a>
                                  </dd>
                                </div>
                              )}
                              {o.courierBooking && (
                                <div className="flex gap-2">
                                  <dt className="text-rbai-text-light min-w-32">Courier booking:</dt>
                                  <dd className="text-rbai-text">
                                    {courierBookingLabel(o.courierBooking)}
                                    {o.courierBooking.courierOrderId && (
                                      <span className="block font-mono text-xs text-rbai-text-light">
                                        {o.courierBooking.courierOrderId}
                                      </span>
                                    )}
                                  </dd>
                                </div>
                              )}
                              {o.courierDelivery && (
                                <div className="flex gap-2">
                                  <dt className="text-rbai-text-light min-w-32">Delivery status:</dt>
                                  <dd className="text-rbai-text">
                                    {o.courierDelivery.opsStatus ?? o.courierDelivery.phase}
                                    <span className="text-rbai-text-light">
                                      {" "}— {o.courierDelivery.riderAssigned ? "rider assigned" : "waiting for rider"}
                                    </span>
                                  </dd>
                                </div>
                              )}
                            </dl>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Order Settings tab (the flow builder)
// ---------------------------------------------------------------------------

function OrderSettingsTab({ toast }: { toast: (t: "success" | "error", m: string) => void }) {
  const [loading, setLoading] = useState(true);
  const [fields, setFields] = useState<OrderField[]>([]);
  const [saving, setSaving] = useState(false);
  const [modal, setModal] = useState<null | { index: number | null; field: OrderField }>(null);
  const [defaults, setDefaults] = useState<OrderField[]>([]);
  const [courierEnabled, setCourierEnabled] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/order-fields");
        if (!res.ok) throw new Error("Failed to load");
        const json = await res.json();
        setFields(json.orderFields ?? []);
        setDefaults(json.defaults ?? []);
        setCourierEnabled(json.courierDelivery?.enabled ?? false);
      } catch {
        toast("error", "Could not load order fields.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/order-fields", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderFields: fields, courierDeliveryEnabled: courierEnabled }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      toast("success", "Order fields saved. The AI will now collect these on every order.");
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= fields.length) return;
    const next = [...fields];
    [next[i], next[j]] = [next[j], next[i]];
    setFields(next);
  };

  const saveField = () => {
    if (!modal) return;
    const f = modal.field;
    if (!/^[a-z0-9_]{1,40}$/.test(f.key.trim().toLowerCase())) {
      toast("error", "Key must be lowercase letters, digits or underscore (max 40).");
      return;
    }
    if (!f.label.trim()) {
      toast("error", "Label is required.");
      return;
    }
    if (f.type === "select" && (!f.options || f.options.length === 0)) {
      toast("error", "Dropdown fields need at least one option.");
      return;
    }
    const cleaned: OrderField = {
      key: f.key.trim().toLowerCase(),
      label: f.label.trim(),
      type: f.type,
      required: f.required,
      ...(f.type === "select" ? { options: f.options } : {}),
    };
    if (fields.some((x, i) => x.key === cleaned.key && i !== modal.index)) {
      toast("error", `Key "${cleaned.key}" is already used.`);
      return;
    }
    const next = [...fields];
    if (modal.index === null) next.push(cleaned);
    else next[modal.index] = cleaned;
    setFields(next);
    setModal(null);
  };

  return (
    <div className="p-6 max-w-4xl space-y-5">
      <div className="rounded-xl border border-rbai-border bg-rbai-surface p-5">
        <h3 className="font-semibold text-rbai-text">How it works</h3>
        <p className="text-sm text-rbai-text-light mt-1 leading-relaxed">
          Define the details your AI must collect before recording an order — for example a cake
          shop needs the cake flavor, size, delivery date and a phone number. Mark a field{" "}
          <strong>required</strong> and the AI will keep asking the customer until it has it.
          Fields are asked in the order listed below.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-rbai-text-light py-6">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-rbai-border bg-rbai-surface p-5">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={courierEnabled}
                onChange={(e) => setCourierEnabled(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-rbai-primary"
              />
              <span>
                <span className="font-semibold text-rbai-text block">
                  Delivery via Ride Bangla Courier
                </span>
                <span className="text-sm text-rbai-text-light mt-1 leading-relaxed block">
                  When you confirm an order, a courier booking is created automatically in
                  Ride Bangla rider dispatch — no separate courier booking is needed. The
                  booking uses the order&apos;s delivery address and phone; pickup is your
                  profile address unless the order carries its own pickup. Saved together
                  with the fields below.
                </span>
              </span>
            </label>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() =>
                setModal({
                  index: null,
                  field: { key: "", label: "", type: "text", required: false },
                })
              }
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-rbai-primary text-white hover:bg-rbai-primary-dark transition-colors"
            >
              <Plus className="h-4 w-4" /> Add field
            </button>
            {fields.length === 0 && defaults.length > 0 && (
              <button
                onClick={() => setFields(defaults)}
                className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-rbai-border text-rbai-text hover:bg-rbai-bg transition-colors"
              >
                <Sparkles className="h-4 w-4" /> Load starter fields
              </button>
            )}
            <div className="flex-1" />
            <button
              onClick={save}
              disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-rbai-primary text-white hover:bg-rbai-primary-dark transition-colors disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save fields
            </button>
          </div>

          {fields.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="No order fields yet"
              description="Add the details your AI should collect — or load the starter set (name, phone, address…)."
              action={{ label: "Load starter fields", onClick: () => setFields(defaults) }}
            />
          ) : (
            <div className="rounded-xl border border-rbai-border bg-rbai-surface overflow-hidden">
              {fields.map((f, i) => (
                <div
                  key={f.key}
                  className="flex items-center gap-3 px-4 py-3 border-b border-rbai-border last:border-0"
                >
                  <div className="flex flex-col gap-0.5">
                    <button onClick={() => move(i, -1)} disabled={i === 0} className="text-rbai-text-light hover:text-rbai-text disabled:opacity-30">
                      <ArrowUp className="h-3.5 w-3.5" />
                    </button>
                    <button onClick={() => move(i, 1)} disabled={i === fields.length - 1} className="text-rbai-text-light hover:text-rbai-text disabled:opacity-30">
                      <ArrowDown className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-rbai-text">{f.label}</span>
                      <span className="font-mono text-xs text-rbai-text-light bg-rbai-bg px-1.5 py-0.5 rounded">{f.key}</span>
                      <span className="text-xs text-rbai-text-light">
                        {FIELD_TYPES.find((t) => t.value === f.type)?.label}
                      </span>
                      {f.required && (
                        <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-rbai-warning/10 text-rbai-warning">
                          Required
                        </span>
                      )}
                    </div>
                    {f.type === "select" && f.options && (
                      <div className="text-xs text-rbai-text-light mt-0.5 truncate">
                        Options: {f.options.join(", ")}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => setModal({ index: i, field: { ...f, options: f.options ? [...f.options] : undefined } })}
                    className="px-2.5 py-1 text-xs rounded-lg border border-rbai-border text-rbai-text hover:bg-rbai-bg"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => setFields(fields.filter((_, j) => j !== i))}
                    className="p-1.5 rounded text-rbai-text-light hover:text-rbai-danger hover:bg-rbai-bg"
                    title="Remove"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-rbai-text-light">
            Remember to press “Save fields” — reordering, edits and removals only take effect after saving.
          </p>
        </>
      )}

      {/* Field editor modal */}
      <Modal
        open={modal !== null}
        onClose={() => setModal(null)}
        title={modal?.index === null ? "Add field" : "Edit field"}
        footer={
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setModal(null)}
              className="px-4 py-2 text-sm rounded-lg border border-rbai-border text-rbai-text hover:bg-rbai-bg"
            >
              Cancel
            </button>
            <button
              onClick={saveField}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-rbai-primary text-white hover:bg-rbai-primary-dark"
            >
              Done
            </button>
          </div>
        }
      >
        {modal && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-rbai-text">Label *</label>
              <input
                value={modal.field.label}
                onChange={(e) => setModal({ ...modal, field: { ...modal.field, label: e.target.value } })}
                placeholder="e.g. Delivery address"
                className={inputClasses}
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-rbai-text">Key *</label>
              <input
                value={modal.field.key}
                onChange={(e) => setModal({ ...modal, field: { ...modal.field, key: e.target.value } })}
                placeholder="e.g. delivery_address"
                className={cn(inputClasses, "font-mono")}
              />
              <p className="text-xs text-rbai-text-light">Lowercase letters, digits or underscore. Used by the AI internally.</p>
            </div>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-rbai-text">Type</label>
              <select
                value={modal.field.type}
                onChange={(e) => setModal({ ...modal, field: { ...modal.field, type: e.target.value as FieldType } })}
                className={inputClasses}
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            {modal.field.type === "select" && (
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-rbai-text">Options (one per line) *</label>
                <textarea
                  value={(modal.field.options ?? []).join("\n")}
                  onChange={(e) =>
                    setModal({
                      ...modal,
                      field: {
                        ...modal.field,
                        options: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
                      },
                    })
                  }
                  rows={4}
                  placeholder={"Small\nMedium\nLarge"}
                  className={inputClasses}
                />
              </div>
            )}
            <label className="flex items-center gap-2 text-sm text-rbai-text">
              <input
                type="checkbox"
                checked={modal.field.required}
                onChange={(e) => setModal({ ...modal, field: { ...modal.field, required: e.target.checked } })}
                className="h-4 w-4 accent-[var(--rbai-primary)]"
              />
              Required — the AI must collect this before recording the order
            </label>
          </div>
        )}
      </Modal>
    </div>
  );
}
