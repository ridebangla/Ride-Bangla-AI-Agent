"use client";

/**
 * Dashboard > Catalog (Phase 2).
 * Full CRUD on productCategories + products (tenant-scoped via /api/catalog).
 * Product image: paste a direct URL, or upload a photo and crop it first
 * (ImageCropper) — the cropped result is stored in the same imageUrl field.
 */

import { Header } from "@/components/layout/header";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/empty-state";
import { ImageCropper } from "@/components/ui/image-cropper";
import { cn } from "@/lib/utils";
import {
  Plus,
  Pencil,
  Trash2,
  ShoppingBag,
  CheckCircle,
  AlertCircle,
  Loader2,
  FolderPlus,
  Tag,
  Wand2,
  ImagePlus,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

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

interface Category {
  id: string;
  name: string;
  description?: string;
  products: Product[];
}

interface Product {
  id: string;
  name: string;
  description?: string;
  price: number | null;
  currency?: string;
  imageUrl?: string;
  tags?: string;
  categoryId: string | null;
  isAvailable: boolean;
}

const emptyProduct = {
  name: "",
  description: "",
  price: "",
  currency: "BDT",
  imageUrl: "",
  tags: "",
  categoryId: "",
  isAvailable: true,
};

export default function CatalogPage() {
  const [loading, setLoading] = useState(true);
  const [categories, setCategories] = useState<Category[]>([]);
  const [uncategorized, setUncategorized] = useState<Product[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [filterCat, setFilterCat] = useState<string>("all");

  const [catModal, setCatModal] = useState<null | { id?: string; name: string; description: string }>(null);
  const [prodModal, setProdModal] = useState<null | ({ id?: string } & typeof emptyProduct)>(null);
  const [deleteTarget, setDeleteTarget] = useState<null | { kind: "category" | "product"; id: string; name: string }>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const imageFileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);

  const toast = (type: "success" | "error", message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, type, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  };

  const reload = async () => {
    const res = await fetch("/api/catalog");
    if (!res.ok) throw new Error("Failed to load catalog");
    const json = await res.json();
    setCategories(json.categories ?? []);
    setUncategorized(json.uncategorized ?? []);
  };

  useEffect(() => {
    (async () => {
      try {
        await reload();
      } catch {
        toast("error", "Could not load catalog.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allProducts: Product[] = [
    ...categories.flatMap((c) => c.products ?? []),
    ...uncategorized,
  ];
  const uncategorizedIds = new Set(uncategorized.map((p) => p.id));
  const visibleProducts =
    filterCat === "all"
      ? allProducts
      : filterCat === "none"
        ? allProducts.filter((p) => uncategorizedIds.has(p.id))
        : allProducts.filter((p) => p.categoryId === filterCat);

  const saveCategory = async () => {
    if (!catModal || !catModal.name.trim()) {
      toast("error", "Category name is required.");
      return;
    }
    setBusy(true);
    try {
      if (catModal.id) {
        const res = await fetch(`/api/catalog/${catModal.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "category", name: catModal.name, description: catModal.description }),
        });
        if (!res.ok) throw new Error((await res.json()).error || "Update failed");
        toast("success", "Category updated.");
      } else {
        const res = await fetch("/api/catalog", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "category", name: catModal.name, description: catModal.description }),
        });
        if (!res.ok) throw new Error((await res.json()).error || "Create failed");
        toast("success", "Category created.");
      }
      setCatModal(null);
      await reload();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "Failed.");
    } finally {
      setBusy(false);
    }
  };

  const saveProduct = async () => {
    if (!prodModal || !prodModal.name.trim()) {
      toast("error", "Product name is required.");
      return;
    }
    setBusy(true);
    try {
      const payload = {
        kind: "product",
        name: prodModal.name,
        description: prodModal.description,
        price: prodModal.price === "" ? null : Number(prodModal.price),
        currency: prodModal.currency || "BDT",
        imageUrl: prodModal.imageUrl,
        tags: prodModal.tags,
        categoryId: prodModal.categoryId || null,
        isAvailable: prodModal.isAvailable,
      };
      const url = prodModal.id ? `/api/catalog/${prodModal.id}` : "/api/catalog";
      const res = await fetch(url, {
        method: prodModal.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      toast("success", prodModal.id ? "Product updated." : "Product created.");
      setProdModal(null);
      await reload();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "Failed.");
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/catalog/${deleteTarget.id}?kind=${deleteTarget.kind}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error((await res.json()).error || "Delete failed");
      toast("success", `${deleteTarget.kind === "category" ? "Category" : "Product"} deleted.`);
      setDeleteTarget(null);
      if (filterCat === deleteTarget.id) setFilterCat("all");
      await reload();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "Failed.");
    } finally {
      setBusy(false);
    }
  };

  // Phase 3 refinement (a): one click builds beautiful categories from the
  // product list — rule-based grouping (AI-refined names when the business
  // has an OpenAI key). Only uncategorized products are touched.
  const autoBuildCategories = async () => {
    if (allProducts.length === 0) {
      toast("error", "Add some products first.");
      return;
    }
    setAutoBusy(true);
    try {
      const res = await fetch("/api/catalog/auto-categorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "fill" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to build categories");
      const parts = [
        `${json.groups?.length ?? 0} categories`,
        `${json.assigned ?? 0} products assigned`,
      ];
      if ((json.created?.length ?? 0) > 0) parts.push(`${json.created.length} new`);
      toast("success", `Categories built: ${parts.join(", ")}.`);
      await reload();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "Failed.");
    } finally {
      setAutoBusy(false);
    }
  };

  const openEditProduct = (p: Product) => {
    const cat = categories.find((c) => c.id === p.categoryId);
    setProdModal({
      id: p.id,
      name: p.name,
      description: p.description ?? "",
      price: p.price === null || p.price === undefined ? "" : String(p.price),
      currency: p.currency ?? "BDT",
      imageUrl: p.imageUrl ?? "",
      tags: p.tags ?? "",
      categoryId: cat ? cat.id : "",
      isAvailable: p.isAvailable,
    });
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <Header
        title="Catalog"
        description="Products and services your AI can recommend and sell"
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={autoBuildCategories}
              disabled={autoBusy}
              title="Automatically build categories from your products"
              className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-rbai-border text-rbai-text hover:bg-rbai-bg transition-colors disabled:opacity-50"
            >
              {autoBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Wand2 className="h-4 w-4" />
              )}
              Auto-build categories
            </button>
            <button
              onClick={() => setCatModal({ name: "", description: "" })}
              className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-rbai-border text-rbai-text hover:bg-rbai-bg transition-colors"
            >
              <FolderPlus className="h-4 w-4" /> New category
            </button>
            <button
              onClick={() => setProdModal({ ...emptyProduct })}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-rbai-primary text-white hover:bg-rbai-primary-dark transition-colors"
            >
              <Plus className="h-4 w-4" /> New product
            </button>
          </div>
        }
      />

      <div className="p-6 max-w-6xl space-y-6">
        {/* Category chips */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setFilterCat("all")}
            className={cn(
              "px-3 py-1.5 text-sm rounded-full border transition-colors",
              filterCat === "all"
                ? "bg-rbai-primary text-white border-rbai-primary"
                : "border-rbai-border text-rbai-text hover:bg-rbai-bg"
            )}
          >
            All ({allProducts.length})
          </button>
          {categories.map((c) => (
            <div key={c.id} className="flex items-center">
              <button
                onClick={() => setFilterCat(c.id)}
                className={cn(
                  "px-3 py-1.5 text-sm rounded-l-full border transition-colors",
                  filterCat === c.id
                    ? "bg-rbai-primary text-white border-rbai-primary"
                    : "border-rbai-border text-rbai-text hover:bg-rbai-bg"
                )}
              >
                {c.name} ({(c.products ?? []).length})
              </button>
              <div
                className={cn(
                  "flex items-center rounded-r-full border border-l-0",
                  filterCat === c.id ? "bg-rbai-primary border-rbai-primary" : "border-rbai-border"
                )}
              >
                <button
                  title="Edit category"
                  onClick={() => setCatModal({ id: c.id, name: c.name, description: c.description ?? "" })}
                  className={cn("p-1.5", filterCat === c.id ? "text-white/80 hover:text-white" : "text-rbai-text-light hover:text-rbai-text")}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  title="Delete category"
                  onClick={() => setDeleteTarget({ kind: "category", id: c.id, name: c.name })}
                  className={cn("p-1.5 pr-2.5", filterCat === c.id ? "text-white/80 hover:text-white" : "text-rbai-text-light hover:text-rbai-danger")}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
          <button
            onClick={() => setFilterCat("none")}
            className={cn(
              "px-3 py-1.5 text-sm rounded-full border transition-colors",
              filterCat === "none"
                ? "bg-rbai-primary text-white border-rbai-primary"
                : "border-rbai-border text-rbai-text hover:bg-rbai-bg"
            )}
          >
            Uncategorized ({uncategorized.length})
          </button>
        </div>

        {/* Products table */}
        {loading ? (
          <div className="flex items-center gap-2 text-rbai-text-light py-10">
            <Loader2 className="h-5 w-5 animate-spin" /> Loading catalog…
          </div>
        ) : visibleProducts.length === 0 ? (
          <EmptyState
            icon={ShoppingBag}
            title="No products yet"
            description="Add your first product or service so the AI can recommend it to customers."
            action={{ label: "Add product", onClick: () => setProdModal({ ...emptyProduct }) }}
          />
        ) : (
          <div className="rounded-xl border border-rbai-border bg-rbai-surface overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-rbai-border text-left text-rbai-text-light">
                  <th className="px-4 py-3 font-medium">Product</th>
                  <th className="px-4 py-3 font-medium">Category</th>
                  <th className="px-4 py-3 font-medium">Price</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleProducts.map((p) => {
                  const cat = categories.find((c) => c.id === p.categoryId);
                  return (
                    <tr key={p.id} className="border-b border-rbai-border last:border-0 hover:bg-rbai-bg/50">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          {p.imageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={p.imageUrl} alt="" className="w-10 h-10 rounded-lg object-cover bg-rbai-bg" />
                          ) : (
                            <div className="w-10 h-10 rounded-lg bg-rbai-bg flex items-center justify-center">
                              <Tag className="h-4 w-4 text-rbai-text-light" />
                            </div>
                          )}
                          <div>
                            <div className="font-medium text-rbai-text">{p.name}</div>
                            {p.description && (
                              <div className="text-xs text-rbai-text-light truncate max-w-xs">{p.description}</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-rbai-text-light">{cat?.name ?? "Uncategorized"}</td>
                      <td className="px-4 py-3 text-rbai-text">
                        {p.price != null ? `${p.currency ?? "BDT"} ${p.price}` : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            "inline-flex px-2 py-0.5 rounded-full text-xs font-medium",
                            p.isAvailable ? "bg-rbai-success/10 text-rbai-success" : "bg-rbai-border/40 text-rbai-text-light"
                          )}
                        >
                          {p.isAvailable ? "Available" : "Hidden"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            title="Edit"
                            onClick={() => openEditProduct(p)}
                            className="p-1.5 rounded text-rbai-text-light hover:text-rbai-text hover:bg-rbai-bg"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            title="Delete"
                            onClick={() => setDeleteTarget({ kind: "product", id: p.id, name: p.name })}
                            className="p-1.5 rounded text-rbai-text-light hover:text-rbai-danger hover:bg-rbai-bg"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Category modal */}
      <Modal
        open={catModal !== null}
        onClose={() => setCatModal(null)}
        title={catModal?.id ? "Edit category" : "New category"}
        footer={
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setCatModal(null)}
              className="px-4 py-2 text-sm rounded-lg border border-rbai-border text-rbai-text hover:bg-rbai-bg"
            >
              Cancel
            </button>
            <button
              onClick={saveCategory}
              disabled={busy}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-rbai-primary text-white hover:bg-rbai-primary-dark disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-rbai-text">Name</label>
            <input
              value={catModal?.name ?? ""}
              onChange={(e) => setCatModal((m) => (m ? { ...m, name: e.target.value } : m))}
              placeholder="e.g. Cakes"
              className={inputClasses}
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-rbai-text">Description (optional)</label>
            <input
              value={catModal?.description ?? ""}
              onChange={(e) => setCatModal((m) => (m ? { ...m, description: e.target.value } : m))}
              className={inputClasses}
            />
          </div>
        </div>
      </Modal>

      {/* Product modal */}
      <Modal
        open={prodModal !== null}
        onClose={() => setProdModal(null)}
        title={prodModal?.id ? "Edit product" : "New product"}
        size="lg"
        footer={
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setProdModal(null)}
              className="px-4 py-2 text-sm rounded-lg border border-rbai-border text-rbai-text hover:bg-rbai-bg"
            >
              Cancel
            </button>
            <button
              onClick={saveProduct}
              disabled={busy}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-rbai-primary text-white hover:bg-rbai-primary-dark disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        }
      >
        {prodModal && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5 md:col-span-2">
              <label className="block text-sm font-medium text-rbai-text">Name *</label>
              <input
                value={prodModal.name}
                onChange={(e) => setProdModal({ ...prodModal, name: e.target.value })}
                placeholder="e.g. Chocolate Fudge Cake"
                className={inputClasses}
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <label className="block text-sm font-medium text-rbai-text">Description</label>
              <textarea
                value={prodModal.description}
                onChange={(e) => setProdModal({ ...prodModal, description: e.target.value })}
                rows={3}
                className={inputClasses}
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-rbai-text">Price</label>
              <input
                type="number"
                min={0}
                value={prodModal.price}
                onChange={(e) => setProdModal({ ...prodModal, price: e.target.value })}
                placeholder="Leave empty for no fixed price"
                className={inputClasses}
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-rbai-text">Currency</label>
              <select
                value={prodModal.currency}
                onChange={(e) => setProdModal({ ...prodModal, currency: e.target.value })}
                className={inputClasses}
              >
                <option value="BDT">BDT</option>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="INR">INR</option>
              </select>
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <label className="block text-sm font-medium text-rbai-text">Product image</label>
              <div className="flex items-start gap-3">
                {prodModal.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={prodModal.imageUrl}
                    alt=""
                    className="h-14 w-14 rounded-lg object-cover border border-rbai-border bg-rbai-bg flex-shrink-0"
                  />
                ) : null}
                <div className="flex-1 space-y-2">
                  <input
                    value={prodModal.imageUrl.startsWith("data:") ? "" : prodModal.imageUrl}
                    onChange={(e) => setProdModal({ ...prodModal, imageUrl: e.target.value })}
                    placeholder="https://…/cake.jpg"
                    className={inputClasses}
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => imageFileRef.current?.click()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-rbai-border text-rbai-text hover:border-rbai-primary/50 transition-colors"
                    >
                      <ImagePlus className="h-3.5 w-3.5" /> Upload &amp; crop a photo
                    </button>
                    {prodModal.imageUrl.startsWith("data:") && (
                      <span className="text-xs text-rbai-text-light">Cropped photo attached</span>
                    )}
                    <input
                      ref={imageFileRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = "";
                        if (f) setCropFile(f);
                      }}
                    />
                  </div>
                </div>
              </div>
              <p className="text-xs text-rbai-text-light">
                Paste a direct image URL, or upload a photo and crop it so the product fits perfectly.
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-rbai-text">Category</label>
              <select
                value={prodModal.categoryId}
                onChange={(e) => setProdModal({ ...prodModal, categoryId: e.target.value })}
                className={inputClasses}
              >
                <option value="">Uncategorized</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-rbai-text">Tags (comma separated)</label>
              <input
                value={prodModal.tags}
                onChange={(e) => setProdModal({ ...prodModal, tags: e.target.value })}
                placeholder="birthday, chocolate"
                className={inputClasses}
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-rbai-text md:col-span-2">
              <input
                type="checkbox"
                checked={prodModal.isAvailable}
                onChange={(e) => setProdModal({ ...prodModal, isAvailable: e.target.checked })}
                className="h-4 w-4 accent-[var(--rbai-primary)]"
              />
              Available (visible to the AI and on the landing page)
            </label>
          </div>
        )}
      </Modal>

      {/* Delete confirm */}
      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={`Delete ${deleteTarget?.kind}`}
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setDeleteTarget(null)}
              className="px-4 py-2 text-sm rounded-lg border border-rbai-border text-rbai-text hover:bg-rbai-bg"
            >
              Cancel
            </button>
            <button
              onClick={doDelete}
              disabled={busy}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-rbai-danger text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Deleting…" : "Delete"}
            </button>
          </div>
        }
      >
        <p className="text-sm text-rbai-text">
          Delete <strong>{deleteTarget?.name}</strong>?
          {deleteTarget?.kind === "category" && " Products in it become uncategorized."} This cannot be undone.
        </p>
      </Modal>

      {/* Image crop step — opens after a photo is picked for a product;
          Confirm feeds the cropped image into the product form's imageUrl. */}
      <ImageCropper
        open={cropFile !== null}
        file={cropFile}
        title="Crop product photo"
        defaultAspectId="square"
        onConfirm={(dataUrl) => {
          setCropFile(null);
          setProdModal((m) => (m ? { ...m, imageUrl: dataUrl } : m));
        }}
        onCancel={() => setCropFile(null)}
      />

      <ToastContainer toasts={toasts} />
    </div>
  );
}

