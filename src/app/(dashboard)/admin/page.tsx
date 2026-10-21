"use client";

import { Header } from "@/components/layout/header";
import { cn } from "@/lib/utils";
import {
  Key,
  Plus,
  Pencil,
  Trash2,
  X,
  Loader2,
  Copy,
  Check,
  AlertTriangle,
  Eye,
  EyeOff,
  ToggleLeft,
  ToggleRight,
  Users,
  Hammer,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AdminUser {
  id: string;
  username: string;
  name: string;
  role: string;
  createdAt: string;
  updatedAt: string;
}

interface ApiKeyItem {
  id: string;
  name: string;
  key: string;
  isActive: boolean;
  lastUsed: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Website-creation application (Settings > Websites → IT Team queue). */
interface WebsiteRequestItem {
  id: string;
  businessId: string;
  businessName: string;
  contactName: string;
  contactPhone: string;
  siteType: string;
  notes: string;
  status: string;
  statusHistory: Array<{ status: string; by: string; at: string }>;
  createdAt: string;
  updatedAt: string;
}

const WEBSITE_REQUEST_STATUSES = [
  "new",
  "contacted",
  "in_progress",
  "delivered",
  "closed",
] as const;

// ---------------------------------------------------------------------------
// Role badge helper
// ---------------------------------------------------------------------------

const roleBadgeStyles: Record<string, string> = {
  admin: "bg-rbai-primary-50 text-rbai-primary-dark border border-rbai-primary-100",
  editor: "bg-amber-50 text-amber-700 border border-amber-200",
  viewer: "bg-gray-100 text-gray-600 border border-gray-200",
};

function RoleBadge({ role }: { role: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium capitalize",
        roleBadgeStyles[role] || roleBadgeStyles.viewer
      )}
    >
      {role}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Format date
// ---------------------------------------------------------------------------

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function AdminPage() {
  const [activeTab, setActiveTab] = useState<"users" | "apikeys" | "websites">("users");

  // --- Users state ---
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [showUserModal, setShowUserModal] = useState(false);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [userForm, setUserForm] = useState({
    name: "",
    username: "",
    password: "",
    role: "viewer",
  });
  const [savingUser, setSavingUser] = useState(false);
  const [userError, setUserError] = useState("");

  // --- Delete user state ---
  const [deleteUserTarget, setDeleteUserTarget] = useState<AdminUser | null>(null);
  const [deletingUser, setDeletingUser] = useState(false);
  const [deleteUserError, setDeleteUserError] = useState("");

  // --- API Keys state ---
  const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(true);
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [keyForm, setKeyForm] = useState({ name: "" });
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState("");

  // --- New key display ---
  const [newKeyValue, setNewKeyValue] = useState("");
  const [keyCopied, setKeyCopied] = useState(false);

  // --- Delete key state ---
  const [deleteKeyTarget, setDeleteKeyTarget] = useState<ApiKeyItem | null>(null);
  const [deletingKey, setDeletingKey] = useState(false);

  // --- Show password toggle ---
  const [showPassword, setShowPassword] = useState(false);

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  const fetchUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const res = await fetch("/api/admin/users");
      if (res.ok) {
        const data = await res.json();
        setUsers(data);
      }
    } catch (err) {
      console.error("Failed to fetch users:", err);
    } finally {
      setLoadingUsers(false);
    }
  }, []);

  const fetchApiKeys = useCallback(async () => {
    setLoadingKeys(true);
    try {
      const res = await fetch("/api/admin/api-keys");
      if (res.ok) {
        const data = await res.json();
        setApiKeys(data);
      }
    } catch (err) {
      console.error("Failed to fetch API keys:", err);
    } finally {
      setLoadingKeys(false);
    }
  }, []);

  // --- Website requests state ---
  const [websiteRequests, setWebsiteRequests] = useState<WebsiteRequestItem[]>([]);
  const [loadingRequests, setLoadingRequests] = useState(true);
  const [requestBusy, setRequestBusy] = useState<string | null>(null);
  const [requestError, setRequestError] = useState("");

  const fetchWebsiteRequests = useCallback(async () => {
    setLoadingRequests(true);
    try {
      const res = await fetch("/api/admin/website-requests");
      if (res.ok) {
        const data = await res.json();
        setWebsiteRequests(data.requests || []);
      }
    } catch (err) {
      console.error("Failed to fetch website requests:", err);
    } finally {
      setLoadingRequests(false);
    }
  }, []);

  async function setRequestStatus(req: WebsiteRequestItem, status: string) {
    if (requestBusy || status === req.status) return;
    setRequestBusy(req.id);
    setRequestError("");
    try {
      const res = await fetch("/api/admin/website-requests", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: req.id, status }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRequestError(data.error || "Failed to update the request.");
        return;
      }
      setWebsiteRequests((prev) =>
        prev.map((r) => (r.id === req.id ? data.request : r))
      );
    } catch {
      setRequestError("Failed to update the request.");
    } finally {
      setRequestBusy(null);
    }
  }

  useEffect(() => {
    fetchUsers();
    fetchApiKeys();
    fetchWebsiteRequests();
  }, [fetchUsers, fetchApiKeys, fetchWebsiteRequests]);

  // ---------------------------------------------------------------------------
  // User CRUD
  // ---------------------------------------------------------------------------

  function openUserModal(user?: AdminUser) {
    setUserError("");
    if (user) {
      setEditingUser(user);
      setUserForm({
        name: user.name,
        username: user.username,
        password: "",
        role: user.role,
      });
    } else {
      setEditingUser(null);
      setUserForm({ name: "", username: "", password: "", role: "viewer" });
    }
    setShowPassword(false);
    setShowUserModal(true);
  }

  async function saveUser() {
    setUserError("");
    if (!editingUser && (!userForm.username.trim() || !userForm.password)) {
      setUserError("Username and password are required.");
      return;
    }
    if (!editingUser && userForm.password.length < 6) {
      setUserError("Password must be at least 6 characters.");
      return;
    }

    setSavingUser(true);
    try {
      const url = editingUser
        ? `/api/admin/users/${editingUser.id}`
        : "/api/admin/users";
      const method = editingUser ? "PUT" : "POST";

      const payload: Record<string, string> = {
        name: userForm.name.trim(),
        role: userForm.role,
      };
      if (!editingUser) {
        payload.username = userForm.username.trim();
        payload.password = userForm.password;
      } else if (userForm.password) {
        payload.password = userForm.password;
      }

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        setShowUserModal(false);
        await fetchUsers();
      } else {
        const data = await res.json();
        setUserError(data.error || "Failed to save user.");
      }
    } catch (err) {
      console.error("Failed to save user:", err);
      setUserError("An unexpected error occurred.");
    } finally {
      setSavingUser(false);
    }
  }

  async function deleteUser() {
    if (!deleteUserTarget) return;
    setDeletingUser(true);
    setDeleteUserError("");
    try {
      const res = await fetch(`/api/admin/users/${deleteUserTarget.id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setDeleteUserTarget(null);
        await fetchUsers();
      } else {
        const data = await res.json();
        setDeleteUserError(data.error || "Failed to delete user.");
      }
    } catch (err) {
      console.error("Failed to delete user:", err);
      setDeleteUserError("An unexpected error occurred.");
    } finally {
      setDeletingUser(false);
    }
  }

  // ---------------------------------------------------------------------------
  // API Key CRUD
  // ---------------------------------------------------------------------------

  function openKeyModal() {
    setKeyError("");
    setKeyForm({ name: "" });
    setShowKeyModal(true);
  }

  async function createKey() {
    setKeyError("");
    if (!keyForm.name.trim()) {
      setKeyError("Key name is required.");
      return;
    }

    setSavingKey(true);
    try {
      const res = await fetch("/api/admin/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: keyForm.name.trim() }),
      });

      if (res.ok) {
        const data = await res.json();
        setShowKeyModal(false);
        setNewKeyValue(data.key);
        setKeyCopied(false);
        await fetchApiKeys();
      } else {
        const data = await res.json();
        setKeyError(data.error || "Failed to create API key.");
      }
    } catch (err) {
      console.error("Failed to create API key:", err);
      setKeyError("An unexpected error occurred.");
    } finally {
      setSavingKey(false);
    }
  }

  async function toggleKeyActive(key: ApiKeyItem) {
    try {
      const res = await fetch(`/api/admin/api-keys/${key.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !key.isActive }),
      });
      if (res.ok) {
        await fetchApiKeys();
      }
    } catch (err) {
      console.error("Failed to toggle API key:", err);
    }
  }

  async function deleteKey() {
    if (!deleteKeyTarget) return;
    setDeletingKey(true);
    try {
      const res = await fetch(`/api/admin/api-keys/${deleteKeyTarget.id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setDeleteKeyTarget(null);
        await fetchApiKeys();
      }
    } catch (err) {
      console.error("Failed to delete API key:", err);
    } finally {
      setDeletingKey(false);
    }
  }

  function copyKeyToClipboard() {
    navigator.clipboard.writeText(newKeyValue);
    setKeyCopied(true);
    setTimeout(() => setKeyCopied(false), 2000);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <>
      <Header
        title="Administration"
        description="Manage users and API access"
      />

      <div className="flex-1 overflow-auto p-6 space-y-6">
        {/* Tab switcher */}
        <div className="flex gap-1 bg-rbai-bg rounded-lg p-1 w-fit">
          <button
            onClick={() => setActiveTab("users")}
            className={cn(
              "flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-colors",
              activeTab === "users"
                ? "bg-rbai-surface text-rbai-text shadow-sm"
                : "text-rbai-text-light hover:text-rbai-text"
            )}
          >
            <Users className="h-4 w-4" />
            Users
          </button>
          <button
            onClick={() => setActiveTab("apikeys")}
            className={cn(
              "flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-colors",
              activeTab === "apikeys"
                ? "bg-rbai-surface text-rbai-text shadow-sm"
                : "text-rbai-text-light hover:text-rbai-text"
            )}
          >
            <Key className="h-4 w-4" />
            API Keys
          </button>
          <button
            onClick={() => setActiveTab("websites")}
            className={cn(
              "flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-colors",
              activeTab === "websites"
                ? "bg-rbai-surface text-rbai-text shadow-sm"
                : "text-rbai-text-light hover:text-rbai-text"
            )}
          >
            <Hammer className="h-4 w-4" />
            Website Requests
            {websiteRequests.filter((r) => r.status === "new").length > 0 && (
              <span className="ml-1 rounded-full bg-red-600 text-white text-[10px] font-bold px-1.5 py-0.5">
                {websiteRequests.filter((r) => r.status === "new").length}
              </span>
            )}
          </button>
        </div>

        {/* ================= USERS TAB ================= */}
        {activeTab === "users" && (
          <div className="bg-rbai-surface rounded-xl border border-rbai-border">
            <div className="flex items-center justify-between px-5 py-4 border-b border-rbai-border">
              <div>
                <h3 className="font-semibold text-rbai-text">Admin Users</h3>
                <p className="text-xs text-rbai-text-light mt-0.5">
                  {users.length} user{users.length !== 1 ? "s" : ""} total
                </p>
              </div>
              <button
                onClick={() => openUserModal()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-rbai-primary hover:bg-rbai-primary-dark rounded-lg transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
                Add User
              </button>
            </div>

            {loadingUsers ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-rbai-text-light" />
              </div>
            ) : users.length === 0 ? (
              <div className="px-5 py-12 text-center">
                <Users className="h-10 w-10 mx-auto mb-3 text-rbai-text-light opacity-40" />
                <p className="text-sm font-medium text-rbai-text-light">No users found</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-rbai-border">
                      <th className="text-left text-xs font-medium text-rbai-text-light px-5 py-3">
                        Name
                      </th>
                      <th className="text-left text-xs font-medium text-rbai-text-light px-5 py-3">
                        Username
                      </th>
                      <th className="text-left text-xs font-medium text-rbai-text-light px-5 py-3">
                        Role
                      </th>
                      <th className="text-left text-xs font-medium text-rbai-text-light px-5 py-3">
                        Created
                      </th>
                      <th className="text-right text-xs font-medium text-rbai-text-light px-5 py-3">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-rbai-border">
                    {users.map((user) => (
                      <tr key={user.id} className="hover:bg-rbai-bg/50 transition-colors">
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-3">
                            <div className="flex items-center justify-center w-8 h-8 rounded-full bg-rbai-primary-50 text-rbai-primary text-sm font-semibold">
                              {user.name.charAt(0).toUpperCase()}
                            </div>
                            <span className="text-sm font-medium text-rbai-text">
                              {user.name}
                            </span>
                          </div>
                        </td>
                        <td className="px-5 py-3 text-sm text-rbai-text-light">
                          {user.username}
                        </td>
                        <td className="px-5 py-3">
                          <RoleBadge role={user.role} />
                        </td>
                        <td className="px-5 py-3 text-sm text-rbai-text-light">
                          {formatDate(user.createdAt)}
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => openUserModal(user)}
                              className="p-1.5 text-rbai-text-light hover:text-rbai-primary hover:bg-rbai-primary-50 rounded transition-colors"
                              title="Edit user"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => {
                                setDeleteUserError("");
                                setDeleteUserTarget(user);
                              }}
                              className="p-1.5 text-rbai-text-light hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                              title="Delete user"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ================= API KEYS TAB ================= */}
        {activeTab === "apikeys" && (
          <div className="bg-rbai-surface rounded-xl border border-rbai-border">
            <div className="flex items-center justify-between px-5 py-4 border-b border-rbai-border">
              <div>
                <h3 className="font-semibold text-rbai-text">API Keys</h3>
                <p className="text-xs text-rbai-text-light mt-0.5">
                  Manage API access keys for integrations
                </p>
              </div>
              <button
                onClick={openKeyModal}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-rbai-primary hover:bg-rbai-primary-dark rounded-lg transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
                Generate New Key
              </button>
            </div>

            {loadingKeys ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-rbai-text-light" />
              </div>
            ) : apiKeys.length === 0 ? (
              <div className="px-5 py-12 text-center">
                <Key className="h-10 w-10 mx-auto mb-3 text-rbai-text-light opacity-40" />
                <p className="text-sm font-medium text-rbai-text-light">No API keys yet</p>
                <p className="text-xs text-rbai-text-light mt-1">
                  Generate a key to enable API access for integrations.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-rbai-border">
                      <th className="text-left text-xs font-medium text-rbai-text-light px-5 py-3">
                        Name
                      </th>
                      <th className="text-left text-xs font-medium text-rbai-text-light px-5 py-3">
                        Key
                      </th>
                      <th className="text-left text-xs font-medium text-rbai-text-light px-5 py-3">
                        Status
                      </th>
                      <th className="text-left text-xs font-medium text-rbai-text-light px-5 py-3">
                        Last Used
                      </th>
                      <th className="text-right text-xs font-medium text-rbai-text-light px-5 py-3">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-rbai-border">
                    {apiKeys.map((apiKey) => (
                      <tr
                        key={apiKey.id}
                        className={cn(
                          "hover:bg-rbai-bg/50 transition-colors",
                          !apiKey.isActive && "opacity-60"
                        )}
                      >
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2">
                            <Key className="h-4 w-4 text-rbai-text-light" />
                            <span className="text-sm font-medium text-rbai-text">
                              {apiKey.name}
                            </span>
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          <code className="text-xs bg-rbai-bg px-2 py-1 rounded font-mono text-rbai-text-light">
                            {apiKey.key}
                          </code>
                        </td>
                        <td className="px-5 py-3">
                          <span
                            className={cn(
                              "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium",
                              apiKey.isActive
                                ? "bg-green-50 text-green-700 border border-green-200"
                                : "bg-gray-100 text-gray-500 border border-gray-200"
                            )}
                          >
                            {apiKey.isActive ? "Active" : "Inactive"}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-sm text-rbai-text-light">
                          {apiKey.lastUsed ? formatDate(apiKey.lastUsed) : "Never"}
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => toggleKeyActive(apiKey)}
                              className={cn(
                                "p-1.5 rounded transition-colors",
                                apiKey.isActive
                                  ? "text-rbai-primary hover:bg-rbai-primary-50"
                                  : "text-rbai-text-light hover:bg-gray-100"
                              )}
                              title={apiKey.isActive ? "Deactivate" : "Activate"}
                            >
                              {apiKey.isActive ? (
                                <ToggleRight className="h-4 w-4" />
                              ) : (
                                <ToggleLeft className="h-4 w-4" />
                              )}
                            </button>
                            <button
                              onClick={() => setDeleteKeyTarget(apiKey)}
                              className="p-1.5 text-rbai-text-light hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                              title="Delete key"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ================= WEBSITE REQUESTS TAB ================= */}
        {activeTab === "websites" && (
          <div className="bg-rbai-surface rounded-xl border border-rbai-border">
            <div className="flex items-center justify-between px-5 py-4 border-b border-rbai-border">
              <div>
                <h3 className="font-semibold text-rbai-text">
                  Website Creation Requests
                </h3>
                <p className="text-xs text-rbai-text-light mt-0.5">
                  Businesses without a website applied from Settings →
                  Websites. The IT Team builds these as a separate service —
                  nothing here touches subscriptions or billing.{" "}
                  {websiteRequests.filter((r) => r.status === "new").length}{" "}
                  new · {websiteRequests.length} total
                </p>
              </div>
            </div>

            {requestError && (
              <div className="mx-5 mt-4 flex items-center gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                {requestError}
              </div>
            )}

            {loadingRequests ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-rbai-text-light" />
              </div>
            ) : websiteRequests.length === 0 ? (
              <div className="px-5 py-12 text-center">
                <Hammer className="h-10 w-10 mx-auto mb-3 text-rbai-text-light opacity-40" />
                <p className="text-sm font-medium text-rbai-text-light">
                  No website requests yet
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-rbai-border">
                      <th className="text-left text-xs font-medium text-rbai-text-light px-5 py-3">
                        Business
                      </th>
                      <th className="text-left text-xs font-medium text-rbai-text-light px-5 py-3">
                        Contact
                      </th>
                      <th className="text-left text-xs font-medium text-rbai-text-light px-5 py-3">
                        Type
                      </th>
                      <th className="text-left text-xs font-medium text-rbai-text-light px-5 py-3">
                        Notes
                      </th>
                      <th className="text-left text-xs font-medium text-rbai-text-light px-5 py-3">
                        Applied
                      </th>
                      <th className="text-left text-xs font-medium text-rbai-text-light px-5 py-3">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {websiteRequests.map((req) => (
                      <tr
                        key={req.id}
                        className="border-b border-rbai-border last:border-0 align-top"
                      >
                        <td className="px-5 py-3 text-sm font-medium text-rbai-text">
                          {req.businessName}
                        </td>
                        <td className="px-5 py-3 text-sm text-rbai-text-light">
                          {req.contactName}
                          <div className="text-xs">{req.contactPhone}</div>
                        </td>
                        <td className="px-5 py-3 text-sm text-rbai-text-light">
                          {req.siteType}
                        </td>
                        <td className="px-5 py-3 text-sm text-rbai-text-light max-w-xs">
                          {req.notes || "—"}
                        </td>
                        <td className="px-5 py-3 text-sm text-rbai-text-light whitespace-nowrap">
                          {formatDate(req.createdAt)}
                        </td>
                        <td className="px-5 py-3">
                          <select
                            value={req.status}
                            disabled={requestBusy === req.id}
                            onChange={(e) => setRequestStatus(req, e.target.value)}
                            className="rounded-lg border border-rbai-border bg-rbai-bg px-2.5 py-1.5 text-xs font-semibold text-rbai-text focus:outline-none focus:ring-2 focus:ring-rbai-primary disabled:opacity-50"
                          >
                            {WEBSITE_REQUEST_STATUSES.map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </select>
                          {req.statusHistory.length > 0 && (
                            <div className="mt-1 text-[11px] text-rbai-text-light">
                              last:{" "}
                              {req.statusHistory[req.statusHistory.length - 1].by}{" "}
                              ·{" "}
                              {formatDate(
                                req.statusHistory[req.statusHistory.length - 1].at
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ================= USER MODAL ================= */}
      {showUserModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setShowUserModal(false)}
          />
          <div className="relative bg-rbai-surface rounded-xl shadow-xl border border-rbai-border w-full max-w-md mx-4">
            <div className="flex items-center justify-between px-5 py-4 border-b border-rbai-border">
              <h3 className="font-semibold text-rbai-text">
                {editingUser ? "Edit User" : "Add User"}
              </h3>
              <button
                onClick={() => setShowUserModal(false)}
                className="p-1 text-rbai-text-light hover:text-rbai-text rounded transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              {userError && (
                <div className="flex items-center gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                  {userError}
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-rbai-text mb-1.5">
                  Name
                </label>
                <input
                  type="text"
                  value={userForm.name}
                  onChange={(e) => setUserForm({ ...userForm, name: e.target.value })}
                  placeholder="Full name"
                  className="w-full px-3 py-2 text-sm border border-rbai-border rounded-lg focus:outline-none focus:ring-2 focus:ring-rbai-primary/30 focus:border-rbai-primary bg-rbai-surface text-rbai-text"
                />
              </div>

              {!editingUser && (
                <div>
                  <label className="block text-xs font-medium text-rbai-text mb-1.5">
                    Username
                  </label>
                  <input
                    type="text"
                    value={userForm.username}
                    onChange={(e) =>
                      setUserForm({ ...userForm, username: e.target.value })
                    }
                    placeholder="Username for login"
                    className="w-full px-3 py-2 text-sm border border-rbai-border rounded-lg focus:outline-none focus:ring-2 focus:ring-rbai-primary/30 focus:border-rbai-primary bg-rbai-surface text-rbai-text"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-rbai-text mb-1.5">
                  {editingUser ? "New Password (leave blank to keep current)" : "Password"}
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={userForm.password}
                    onChange={(e) =>
                      setUserForm({ ...userForm, password: e.target.value })
                    }
                    placeholder={editingUser ? "Leave blank to keep current" : "Minimum 6 characters"}
                    className="w-full px-3 py-2 pr-10 text-sm border border-rbai-border rounded-lg focus:outline-none focus:ring-2 focus:ring-rbai-primary/30 focus:border-rbai-primary bg-rbai-surface text-rbai-text"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-rbai-text-light hover:text-rbai-text rounded transition-colors"
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-rbai-text mb-1.5">
                  Role
                </label>
                <select
                  value={userForm.role}
                  onChange={(e) => setUserForm({ ...userForm, role: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-rbai-border rounded-lg focus:outline-none focus:ring-2 focus:ring-rbai-primary/30 focus:border-rbai-primary bg-rbai-surface text-rbai-text"
                >
                  <option value="admin">Admin - Full access</option>
                  <option value="editor">Editor - Can edit content</option>
                  <option value="viewer">Viewer - Read-only access</option>
                </select>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-rbai-border">
              <button
                onClick={() => setShowUserModal(false)}
                className="px-4 py-2 text-sm font-medium text-rbai-text-light hover:text-rbai-text rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={saveUser}
                disabled={savingUser}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-rbai-primary hover:bg-rbai-primary-dark disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
              >
                {savingUser && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {editingUser ? "Save Changes" : "Create User"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= DELETE USER CONFIRMATION ================= */}
      {deleteUserTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setDeleteUserTarget(null)}
          />
          <div className="relative bg-rbai-surface rounded-xl shadow-xl border border-rbai-border w-full max-w-sm mx-4">
            <div className="p-5">
              <div className="flex items-center gap-3 mb-3">
                <div className="p-2 rounded-full bg-red-50">
                  <AlertTriangle className="h-5 w-5 text-red-600" />
                </div>
                <h3 className="font-semibold text-rbai-text">Delete User</h3>
              </div>
              <p className="text-sm text-rbai-text-light">
                Are you sure you want to delete{" "}
                <span className="font-medium text-rbai-text">
                  {deleteUserTarget.name}
                </span>
                ? This action cannot be undone.
              </p>
              {deleteUserError && (
                <div className="mt-3 flex items-center gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                  {deleteUserError}
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-rbai-border">
              <button
                onClick={() => setDeleteUserTarget(null)}
                className="px-4 py-2 text-sm font-medium text-rbai-text-light hover:text-rbai-text rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={deleteUser}
                disabled={deletingUser}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded-lg transition-colors"
              >
                {deletingUser && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= CREATE KEY MODAL ================= */}
      {showKeyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setShowKeyModal(false)}
          />
          <div className="relative bg-rbai-surface rounded-xl shadow-xl border border-rbai-border w-full max-w-md mx-4">
            <div className="flex items-center justify-between px-5 py-4 border-b border-rbai-border">
              <h3 className="font-semibold text-rbai-text">Generate New API Key</h3>
              <button
                onClick={() => setShowKeyModal(false)}
                className="p-1 text-rbai-text-light hover:text-rbai-text rounded transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              {keyError && (
                <div className="flex items-center gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                  {keyError}
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-rbai-text mb-1.5">
                  Key Name
                </label>
                <input
                  type="text"
                  value={keyForm.name}
                  onChange={(e) => setKeyForm({ name: e.target.value })}
                  placeholder="e.g. Production API, Webhook Integration"
                  className="w-full px-3 py-2 text-sm border border-rbai-border rounded-lg focus:outline-none focus:ring-2 focus:ring-rbai-primary/30 focus:border-rbai-primary bg-rbai-surface text-rbai-text"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-rbai-border">
              <button
                onClick={() => setShowKeyModal(false)}
                className="px-4 py-2 text-sm font-medium text-rbai-text-light hover:text-rbai-text rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={createKey}
                disabled={savingKey}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-rbai-primary hover:bg-rbai-primary-dark disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
              >
                {savingKey && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Generate Key
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= NEW KEY DISPLAY DIALOG ================= */}
      {newKeyValue && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
          <div className="relative bg-rbai-surface rounded-xl shadow-xl border border-rbai-border w-full max-w-lg mx-4">
            <div className="flex items-center justify-between px-5 py-4 border-b border-rbai-border">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-full bg-green-50">
                  <Check className="h-4 w-4 text-green-600" />
                </div>
                <h3 className="font-semibold text-rbai-text">API Key Generated</h3>
              </div>
            </div>

            <div className="p-5 space-y-4">
              <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
                <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                This key will not be shown again. Copy it now and store it securely.
              </div>

              <div className="relative">
                <code className="block w-full px-3 py-3 bg-rbai-bg border border-rbai-border rounded-lg text-sm font-mono text-rbai-text break-all select-all">
                  {newKeyValue}
                </code>
                <button
                  onClick={copyKeyToClipboard}
                  className="absolute top-2 right-2 p-1.5 rounded-md bg-rbai-surface border border-rbai-border text-rbai-text-light hover:text-rbai-text hover:bg-rbai-bg transition-colors"
                  title="Copy to clipboard"
                >
                  {keyCopied ? (
                    <Check className="h-4 w-4 text-green-600" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-end px-5 py-4 border-t border-rbai-border">
              <button
                onClick={() => setNewKeyValue("")}
                className="px-4 py-2 text-sm font-medium text-white bg-rbai-primary hover:bg-rbai-primary-dark rounded-lg transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= DELETE KEY CONFIRMATION ================= */}
      {deleteKeyTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setDeleteKeyTarget(null)}
          />
          <div className="relative bg-rbai-surface rounded-xl shadow-xl border border-rbai-border w-full max-w-sm mx-4">
            <div className="p-5">
              <div className="flex items-center gap-3 mb-3">
                <div className="p-2 rounded-full bg-red-50">
                  <AlertTriangle className="h-5 w-5 text-red-600" />
                </div>
                <h3 className="font-semibold text-rbai-text">Delete API Key</h3>
              </div>
              <p className="text-sm text-rbai-text-light">
                Are you sure you want to delete the key{" "}
                <span className="font-medium text-rbai-text">
                  {deleteKeyTarget.name}
                </span>
                ? Any integrations using this key will stop working immediately.
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-rbai-border">
              <button
                onClick={() => setDeleteKeyTarget(null)}
                className="px-4 py-2 text-sm font-medium text-rbai-text-light hover:text-rbai-text rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={deleteKey}
                disabled={deletingKey}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded-lg transition-colors"
              >
                {deletingKey && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
