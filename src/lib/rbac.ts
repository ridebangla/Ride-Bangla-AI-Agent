/**
 * Role-Based Access Control (RBAC) System
 *
 * Roles: admin > supervisor > agent > viewer
 * Each role inherits all permissions of the roles below it.
 */

export const ROLES = ["viewer", "agent", "supervisor", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = {
  // Conversations
  "conversations:read": ["viewer", "agent", "supervisor", "admin"],
  "conversations:create": ["agent", "supervisor", "admin"],
  "conversations:update": ["agent", "supervisor", "admin"],
  "conversations:delete": ["supervisor", "admin"],
  "conversations:assign": ["supervisor", "admin"],
  "conversations:transfer": ["agent", "supervisor", "admin"],
  // Required by the takeover revert-expired sweep (non-cron path).
  // Staff-only, like delete/assign: a bulk revert is not an agent action.
  "conversations:takeover": ["supervisor", "admin"],

  // Messages
  "messages:read": ["viewer", "agent", "supervisor", "admin"],
  "messages:create": ["agent", "supervisor", "admin"],

  // Tickets
  "tickets:read": ["viewer", "agent", "supervisor", "admin"],
  "tickets:create": ["agent", "supervisor", "admin"],
  "tickets:update": ["agent", "supervisor", "admin"],
  "tickets:delete": ["supervisor", "admin"],

  // Bookings (Leg A: separate record type from orders — own permissions,
  // own screens, own API routes. bookings:update is the HUMAN confirm /
  // propose / return / cancel path; no agent tool holds it.)
  "bookings:read": ["viewer", "agent", "supervisor", "admin"],
  "bookings:write": ["supervisor", "admin"],
  "bookings:update": ["agent", "supervisor", "admin"],

  // Lead Engine (Harvey outbound)
  "leads:read": ["viewer", "agent", "supervisor", "admin"],
  "leads:write": ["supervisor", "admin"],

  // Inbound leads (customers of THIS business showing buying/booking
  // interest) — a separate pipeline from the outbound Lead Engine above.
  // Read: everyone on the team. Write: agents and up. Assign: supervisors
  // and admins only (assignment decides who works a lead). Export:
  // supervisors and admins only (same bar as customers:export).
  "inbound-leads:read": ["viewer", "agent", "supervisor", "admin"],
  "inbound-leads:write": ["agent", "supervisor", "admin"],
  "inbound-leads:assign": ["supervisor", "admin"],
  "inbound-leads:export": ["supervisor", "admin"],

  // Customers
  "customers:read": ["viewer", "agent", "supervisor", "admin"],
  "customers:create": ["agent", "supervisor", "admin"],
  "customers:update": ["agent", "supervisor", "admin"],
  "customers:delete": ["admin"],
  "customers:export": ["supervisor", "admin"],

  // Knowledge Base
  "knowledge:read": ["viewer", "agent", "supervisor", "admin"],
  "knowledge:create": ["supervisor", "admin"],
  "knowledge:update": ["supervisor", "admin"],
  "knowledge:delete": ["admin"],

  // Team Management
  "team:read": ["viewer", "agent", "supervisor", "admin"],
  "team:create": ["admin"],
  "team:update": ["admin"],
  "team:delete": ["admin"],

  // Automation
  "automation:read": ["viewer", "agent", "supervisor", "admin"],
  "automation:create": ["supervisor", "admin"],
  "automation:update": ["supervisor", "admin"],
  "automation:delete": ["admin"],

  // Webhooks
  "webhooks:read": ["supervisor", "admin"],
  "webhooks:create": ["admin"],
  "webhooks:update": ["admin"],
  "webhooks:delete": ["admin"],
  "webhooks:test": ["supervisor", "admin"],

  // Settings
  "settings:read": ["admin"],
  "settings:update": ["admin"],

  // Business rules (LEG G, supplementary profile prompts)
  "business-rules:read": ["viewer", "agent", "supervisor", "admin"],
  "business-rules:update": ["admin"],
  // Agent Desk (LEG G: plain-language rules, preview-before-live, rollback)
  "agent-desk:read": ["viewer", "agent", "supervisor", "admin"],
  "agent-desk:write": ["supervisor", "admin"],
  "agent-desk:publish": ["admin"],
  "agent-desk:rollback": ["admin"],

  // Admin (users, API keys)
  "admin:read": ["admin"],
  "admin:create": ["admin"],
  "admin:update": ["admin"],
  "admin:delete": ["admin"],

  // Analytics
  "analytics:read": ["viewer", "agent", "supervisor", "admin"],
  "analytics:export": ["supervisor", "admin"],

  // Activity Log
  "activity:read": ["supervisor", "admin"],

  // Channels
  "channels:read": ["supervisor", "admin"],
  "channels:update": ["admin"],

  // Test chat (sandbox leg): staff test sessions. Read = viewer and
  // up (test data only, no customer data); write = supervisor and
  // admin (a test turn spends provider tokens). Going live uses
  // the EXISTING settings:update permission via the Settings PUT —
  // no new permission is invented for it.
  "test-chat:read": ["viewer", "agent", "supervisor", "admin"],
  "test-chat:write": ["supervisor", "admin"],
  // Integrations Hub (display only; same roles as channels:read)
  "integrations:read": ["supervisor", "admin"],

  // SLA
  "sla:read": ["viewer", "agent", "supervisor", "admin"],
  "sla:create": ["admin"],
  "sla:update": ["admin"],
  "sla:delete": ["admin"],

  // Business Hours
  "business-hours:read": ["viewer", "agent", "supervisor", "admin"],
  "business-hours:update": ["admin"],

  // Canned Responses
  "canned:read": ["agent", "supervisor", "admin"],
  "canned:create": ["supervisor", "admin"],
  "canned:update": ["supervisor", "admin"],
  "canned:delete": ["admin"],

  // Owner controls (LEG D: Desk pause/resume + status templates)
  "agent-desk:pause": ["admin"],
  "agent-desk:resume": ["admin"],
  "order-status-templates:read": ["viewer", "agent", "supervisor", "admin"],
  "order-status-templates:write": ["supervisor", "admin"],

  // Export
  "export:read": ["supervisor", "admin"],

  // Reply approvals (Leg D video round 2): review drafts before they
  // send. Read = viewer and up; manage (send-now / reject / edit /
  // per-chat pause / sweep trigger) = agent and up. Viewers never act.
  "reply-approvals:read": ["viewer", "agent", "supervisor", "admin"],
  "reply-approvals:manage": ["agent", "supervisor", "admin"],
  // Inventory alerts (Leg E, staged)
  "inventory:read": ["viewer", "agent", "supervisor", "admin"],
  // Advance payments (manual transaction-ID check — Leg C)
  "payments:read": ["viewer", "agent", "supervisor", "admin"],
  "payments:write": ["supervisor", "admin"],
} as const;

export type Permission = keyof typeof PERMISSIONS;

/**
 * Check if a role has a specific permission.
 */
export function hasPermission(role: string, permission: Permission): boolean {
  // The single Super Admin (role "super_admin", businessId null) is above
  // the role hierarchy: unrestricted by design (user's standing rule —
  // exactly ONE Super Admin).
  if (role === "super_admin") return true;
  const allowed = PERMISSIONS[permission];
  if (!allowed) return false;
  return (allowed as readonly string[]).includes(role);
}

/**
 * Check if a role meets the minimum required role level.
 */
export function hasMinRole(role: string, minRole: Role): boolean {
  const roleIndex = ROLES.indexOf(role as Role);
  const minIndex = ROLES.indexOf(minRole);
  if (roleIndex === -1 || minIndex === -1) return false;
  return roleIndex >= minIndex;
}

/**
 * Get all permissions for a role.
 */
export function getPermissionsForRole(role: string): Permission[] {
  return (Object.entries(PERMISSIONS) as [Permission, readonly string[]][])
    .filter(([, roles]) => roles.includes(role))
    .map(([perm]) => perm);
}
