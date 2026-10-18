-- Multi-tenancy: Business model + businessId on all tenant tables.
-- Existing single-tenant deployments get one Business ('Ride Bangla')
-- and all existing rows are assigned to it. Admin.businessId stays
-- NULLABLE: NULL = Super Admin (sees every business).

CREATE TABLE "Business" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "siteKey" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Business_slug_key" UNIQUE ("slug"),
    CONSTRAINT "Business_siteKey_key" UNIQUE ("siteKey")
);

-- Seed the default business for existing deployments.
INSERT INTO "Business" ("id", "name", "slug", "siteKey", "isActive", "createdAt", "updatedAt")
VALUES ('rb-biz-ridebangla', 'Ride Bangla', 'ride-bangla',
        'rbsite-' || replace(gen_random_uuid()::text, '-', ''), true, NOW(), NOW());

ALTER TABLE "Settings" ADD COLUMN "businessId" TEXT;
ALTER TABLE "Category" ADD COLUMN "businessId" TEXT;
ALTER TABLE "KnowledgeEntry" ADD COLUMN "businessId" TEXT;
ALTER TABLE "Department" ADD COLUMN "businessId" TEXT;
ALTER TABLE "TeamMember" ADD COLUMN "businessId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "businessId" TEXT;
ALTER TABLE "Message" ADD COLUMN "businessId" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "businessId" TEXT;
ALTER TABLE "Tag" ADD COLUMN "businessId" TEXT;
ALTER TABLE "ConversationTag" ADD COLUMN "businessId" TEXT;
ALTER TABLE "CallLog" ADD COLUMN "businessId" TEXT;
ALTER TABLE "Channel" ADD COLUMN "businessId" TEXT;
ALTER TABLE "Webhook" ADD COLUMN "businessId" TEXT;
ALTER TABLE "WebhookDelivery" ADD COLUMN "businessId" TEXT;
ALTER TABLE "ActivityLog" ADD COLUMN "businessId" TEXT;
ALTER TABLE "SLARule" ADD COLUMN "businessId" TEXT;
ALTER TABLE "CannedResponse" ADD COLUMN "businessId" TEXT;
ALTER TABLE "Customer" ADD COLUMN "businessId" TEXT;
ALTER TABLE "CustomerNote" ADD COLUMN "businessId" TEXT;
ALTER TABLE "AutomationRule" ADD COLUMN "businessId" TEXT;
ALTER TABLE "BusinessHours" ADD COLUMN "businessId" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN "businessId" TEXT;
ALTER TABLE "InternalNote" ADD COLUMN "businessId" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "businessId" TEXT;
ALTER TABLE "Flow" ADD COLUMN "businessId" TEXT;
ALTER TABLE "Schedule" ADD COLUMN "businessId" TEXT;
ALTER TABLE "Admin" ADD COLUMN "businessId" TEXT;

-- Backfill: every existing row belongs to the default business.
UPDATE "Settings" SET "businessId" = 'rb-biz-ridebangla';
UPDATE "Category" SET "businessId" = 'rb-biz-ridebangla';
UPDATE "KnowledgeEntry" SET "businessId" = 'rb-biz-ridebangla';
UPDATE "Department" SET "businessId" = 'rb-biz-ridebangla';
UPDATE "TeamMember" SET "businessId" = 'rb-biz-ridebangla';
UPDATE "Conversation" SET "businessId" = 'rb-biz-ridebangla';
UPDATE "Message" SET "businessId" = 'rb-biz-ridebangla';
UPDATE "Ticket" SET "businessId" = 'rb-biz-ridebangla';
UPDATE "Tag" SET "businessId" = 'rb-biz-ridebangla';
UPDATE "ConversationTag" SET "businessId" = 'rb-biz-ridebangla';
UPDATE "CallLog" SET "businessId" = 'rb-biz-ridebangla';
UPDATE "Channel" SET "businessId" = 'rb-biz-ridebangla';
UPDATE "Webhook" SET "businessId" = 'rb-biz-ridebangla';
UPDATE "WebhookDelivery" SET "businessId" = 'rb-biz-ridebangla';
UPDATE "ActivityLog" SET "businessId" = 'rb-biz-ridebangla';
UPDATE "SLARule" SET "businessId" = 'rb-biz-ridebangla';
UPDATE "CannedResponse" SET "businessId" = 'rb-biz-ridebangla';
UPDATE "Customer" SET "businessId" = 'rb-biz-ridebangla';
UPDATE "CustomerNote" SET "businessId" = 'rb-biz-ridebangla';
UPDATE "AutomationRule" SET "businessId" = 'rb-biz-ridebangla';
UPDATE "BusinessHours" SET "businessId" = 'rb-biz-ridebangla';
UPDATE "ApiKey" SET "businessId" = 'rb-biz-ridebangla';
UPDATE "InternalNote" SET "businessId" = 'rb-biz-ridebangla';
UPDATE "Campaign" SET "businessId" = 'rb-biz-ridebangla';
UPDATE "Flow" SET "businessId" = 'rb-biz-ridebangla';
UPDATE "Schedule" SET "businessId" = 'rb-biz-ridebangla';
-- Existing admins become the Super Admin (NULL businessId = sees everything).
-- The operator can later create per-business admins via the dashboard.
UPDATE "Admin" SET "businessId" = NULL, "role" = 'super_admin' WHERE "businessId" IS NULL;

ALTER TABLE "Settings" ALTER COLUMN "businessId" SET NOT NULL;
ALTER TABLE "Category" ALTER COLUMN "businessId" SET NOT NULL;
ALTER TABLE "KnowledgeEntry" ALTER COLUMN "businessId" SET NOT NULL;
ALTER TABLE "Department" ALTER COLUMN "businessId" SET NOT NULL;
ALTER TABLE "TeamMember" ALTER COLUMN "businessId" SET NOT NULL;
ALTER TABLE "Conversation" ALTER COLUMN "businessId" SET NOT NULL;
ALTER TABLE "Message" ALTER COLUMN "businessId" SET NOT NULL;
ALTER TABLE "Ticket" ALTER COLUMN "businessId" SET NOT NULL;
ALTER TABLE "Tag" ALTER COLUMN "businessId" SET NOT NULL;
ALTER TABLE "ConversationTag" ALTER COLUMN "businessId" SET NOT NULL;
ALTER TABLE "CallLog" ALTER COLUMN "businessId" SET NOT NULL;
ALTER TABLE "Channel" ALTER COLUMN "businessId" SET NOT NULL;
ALTER TABLE "Webhook" ALTER COLUMN "businessId" SET NOT NULL;
ALTER TABLE "WebhookDelivery" ALTER COLUMN "businessId" SET NOT NULL;
ALTER TABLE "ActivityLog" ALTER COLUMN "businessId" SET NOT NULL;
ALTER TABLE "SLARule" ALTER COLUMN "businessId" SET NOT NULL;
ALTER TABLE "CannedResponse" ALTER COLUMN "businessId" SET NOT NULL;
ALTER TABLE "Customer" ALTER COLUMN "businessId" SET NOT NULL;
ALTER TABLE "CustomerNote" ALTER COLUMN "businessId" SET NOT NULL;
ALTER TABLE "AutomationRule" ALTER COLUMN "businessId" SET NOT NULL;
ALTER TABLE "BusinessHours" ALTER COLUMN "businessId" SET NOT NULL;
ALTER TABLE "ApiKey" ALTER COLUMN "businessId" SET NOT NULL;
ALTER TABLE "InternalNote" ALTER COLUMN "businessId" SET NOT NULL;
ALTER TABLE "Campaign" ALTER COLUMN "businessId" SET NOT NULL;
ALTER TABLE "Flow" ALTER COLUMN "businessId" SET NOT NULL;
ALTER TABLE "Schedule" ALTER COLUMN "businessId" SET NOT NULL;

CREATE TABLE "FollowUp" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "SocialAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "accountRef" TEXT NOT NULL DEFAULT '',
    "tokenEnc" TEXT NOT NULL DEFAULT '',
    "tokenIv" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SocialAccount_businessId_platform_accountRef_key" UNIQUE ("businessId","platform","accountRef")
);

CREATE TABLE "ScheduledPost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "postType" TEXT NOT NULL DEFAULT 'promo',
    "textContent" TEXT NOT NULL DEFAULT '',
    "topic" TEXT NOT NULL DEFAULT '',
    "imagePrompt" TEXT NOT NULL DEFAULT '',
    "imageUrl" TEXT NOT NULL DEFAULT '',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "resultRef" TEXT NOT NULL DEFAULT '',
    "error" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL DEFAULT 'admin',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "SocialInteraction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "parentRef" TEXT NOT NULL DEFAULT '',
    "customerRef" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL DEFAULT '',
    "likes" INTEGER NOT NULL DEFAULT 0,
    "replied" BOOLEAN NOT NULL DEFAULT false,
    "repliedAt" TIMESTAMP(3),
    "replyRef" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SocialInteraction_businessId_platform_externalId_key" UNIQUE ("businessId","platform","externalId")
);

CREATE TABLE "AudienceProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AudienceProfile_businessId_platform_key" UNIQUE ("businessId","platform")
);

CREATE TABLE "AgentCommand" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "result" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL DEFAULT 'admin',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "ProductCategory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductCategory_businessId_name_key" UNIQUE ("businessId","name")
);

CREATE TABLE "Product" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "categoryId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "price" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "imageUrl" TEXT NOT NULL DEFAULT '',
    "tags" TEXT NOT NULL DEFAULT '',
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Per-business uniqueness (was global).
ALTER TABLE "Settings" ADD CONSTRAINT "Settings_businessId_key" UNIQUE ("businessId");
ALTER TABLE "Channel" DROP CONSTRAINT "Channel_type_key";
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_businessId_type_key" UNIQUE ("businessId","type");
ALTER TABLE "Tag" DROP CONSTRAINT "Tag_name_key";
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_businessId_name_key" UNIQUE ("businessId","name");
ALTER TABLE "BusinessHours" ADD CONSTRAINT "BusinessHours_businessId_key" UNIQUE ("businessId");

ALTER TABLE "Settings" ADD CONSTRAINT "Settings_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Category" ADD CONSTRAINT "Category_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeEntry" ADD CONSTRAINT "KnowledgeEntry_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Department" ADD CONSTRAINT "Department_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationTag" ADD CONSTRAINT "ConversationTag_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallLog" ADD CONSTRAINT "CallLog_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SLARule" ADD CONSTRAINT "SLARule_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CannedResponse" ADD CONSTRAINT "CannedResponse_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BusinessHours" ADD CONSTRAINT "BusinessHours_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InternalNote" ADD CONSTRAINT "InternalNote_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Flow" ADD CONSTRAINT "Flow_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduledPost" ADD CONSTRAINT "ScheduledPost_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SocialInteraction" ADD CONSTRAINT "SocialInteraction_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AudienceProfile" ADD CONSTRAINT "AudienceProfile_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentCommand" ADD CONSTRAINT "AgentCommand_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Product" ADD CONSTRAINT "Product_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Admin" ADD CONSTRAINT "Admin_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Settings_businessId_idx" ON "Settings"("businessId");
CREATE INDEX "Category_businessId_idx" ON "Category"("businessId");
CREATE INDEX "KnowledgeEntry_businessId_idx" ON "KnowledgeEntry"("businessId");
CREATE INDEX "Department_businessId_idx" ON "Department"("businessId");
CREATE INDEX "TeamMember_businessId_idx" ON "TeamMember"("businessId");
CREATE INDEX "Conversation_businessId_idx" ON "Conversation"("businessId");
CREATE INDEX "Message_businessId_idx" ON "Message"("businessId");
CREATE INDEX "Ticket_businessId_idx" ON "Ticket"("businessId");
CREATE INDEX "Tag_businessId_idx" ON "Tag"("businessId");
CREATE INDEX "ConversationTag_businessId_idx" ON "ConversationTag"("businessId");
CREATE INDEX "CallLog_businessId_idx" ON "CallLog"("businessId");
CREATE INDEX "Channel_businessId_idx" ON "Channel"("businessId");
CREATE INDEX "Webhook_businessId_idx" ON "Webhook"("businessId");
CREATE INDEX "WebhookDelivery_businessId_idx" ON "WebhookDelivery"("businessId");
CREATE INDEX "ActivityLog_businessId_idx" ON "ActivityLog"("businessId");
CREATE INDEX "SLARule_businessId_idx" ON "SLARule"("businessId");
CREATE INDEX "CannedResponse_businessId_idx" ON "CannedResponse"("businessId");
CREATE INDEX "Customer_businessId_idx" ON "Customer"("businessId");
CREATE INDEX "CustomerNote_businessId_idx" ON "CustomerNote"("businessId");
CREATE INDEX "AutomationRule_businessId_idx" ON "AutomationRule"("businessId");
CREATE INDEX "BusinessHours_businessId_idx" ON "BusinessHours"("businessId");
CREATE INDEX "ApiKey_businessId_idx" ON "ApiKey"("businessId");
CREATE INDEX "InternalNote_businessId_idx" ON "InternalNote"("businessId");
CREATE INDEX "Campaign_businessId_idx" ON "Campaign"("businessId");
CREATE INDEX "Flow_businessId_idx" ON "Flow"("businessId");
CREATE INDEX "Schedule_businessId_idx" ON "Schedule"("businessId");
CREATE INDEX "FollowUp_businessId_idx" ON "FollowUp"("businessId");
CREATE INDEX "SocialAccount_businessId_idx" ON "SocialAccount"("businessId");
CREATE INDEX "ScheduledPost_businessId_idx" ON "ScheduledPost"("businessId");
CREATE INDEX "SocialInteraction_businessId_idx" ON "SocialInteraction"("businessId");
CREATE INDEX "AudienceProfile_businessId_idx" ON "AudienceProfile"("businessId");
CREATE INDEX "AgentCommand_businessId_idx" ON "AgentCommand"("businessId");
CREATE INDEX "ProductCategory_businessId_idx" ON "ProductCategory"("businessId");
CREATE INDEX "Product_businessId_idx" ON "Product"("businessId");
CREATE INDEX "Admin_businessId_idx" ON "Admin"("businessId");
CREATE INDEX "FollowUp_status_dueAt_idx" ON "FollowUp"("status","dueAt");
CREATE INDEX "ScheduledPost_status_scheduledAt_idx" ON "ScheduledPost"("status","scheduledAt");
CREATE INDEX "SocialInteraction_replied_idx" ON "SocialInteraction"("replied");
CREATE INDEX "AgentCommand_status_idx" ON "AgentCommand"("status");