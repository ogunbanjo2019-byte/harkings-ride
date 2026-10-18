// src/modules/admin/chat.js
// Office chat: 10 department channels + DMs + attachments + reports.
// MVP uses polling. SSE broadcast can layer on later.

import { db, id, timestamp, findUser } from '../../database/store.js';

const MAX_MESSAGE_LENGTH = 4000;
const MAX_ATTACHMENT_BYTES = 1024 * 1024; // 1 MB

// ---------- Departments ----------

export const CHANNELS = [
  { id: 'announcements', name: 'announcements', description: 'Company-wide updates', department: 'Company', isPrivate: false },
  { id: 'general',       name: 'general',       description: 'Team chit-chat',       department: 'Company', isPrivate: false },
  { id: 'management',    name: 'management',    description: 'Leads only',           department: 'Company', isPrivate: true },

  { id: 'operations',    name: 'operations',    description: 'Dispatch, fleet, daily ops', department: 'Operations', isPrivate: false },
  { id: 'safety',        name: 'safety',        description: 'SOS, incidents, escalation', department: 'Operations', isPrivate: false },

  { id: 'finance',       name: 'finance',       description: 'Payouts, wallets, subscriptions', department: 'Finance', isPrivate: false },
  { id: 'support',       name: 'support',       description: 'Complaints, tickets',              department: 'Finance', isPrivate: false },

  { id: 'drivers',       name: 'drivers',       description: 'Driver ops, verification', department: 'Field', isPrivate: false },
  { id: 'riders',        name: 'riders',        description: 'Rider ops, safety',        department: 'Field', isPrivate: false },
  { id: 'cng',           name: 'cng',           description: 'CNG stations, rebates',    department: 'Field', isPrivate: false },
];

export const findChatChannel = (channelId) =>
  CHANNELS.find((c) => c.id === channelId);

// ---------- DMs ----------

const dmKey = (a, b) => `dm:${[a, b].sort().join(':')}`;

export function getOrCreateDmChannel(userId, otherUserId) {
  if (!userId || !otherUserId) return null;
  if (userId === otherUserId) return null;

  const other = findUser({ id: otherUserId });
  if (!other) return null;

  const key = dmKey(userId, otherUserId);
  let channel = (db.dmChannels || []).find((c) => c.id === key);
  if (!channel) {
    channel = {
      id: key,
      participants: [userId, otherUserId].sort(),
      createdAt: timestamp(),
      lastMessageAt: null,
    };
    db.dmChannels.push(channel);
  }
  return channel;
}

function listDmsForUser(userId) {
  return (db.dmChannels || [])
    .filter((c) => c.participants.includes(userId))
    .map((c) => {
      const otherId = c.participants.find((p) => p !== userId);
      const other = findUser({ id: otherId });
      return {
        id: c.id,
        name: other?.name ?? 'Admin',
        description: 'Direct message',
        department: 'Direct',
        isPrivate: true,
        isDm: true,
        otherUserId: otherId,
        unread: getChannelUnreadCount(c.id, userId),
        lastMessageAt: c.lastMessageAt ?? null,
      };
    });
}

// ---------- Channels for user ----------

export function getChannelsForUser(userId) {
  const dept = CHANNELS.map((c) => {
    // management is private — only visible if the user is the CEO/lead
    // For MVP: everyone sees it; tighten later with role checks
    return {
      ...c,
      unread: getChannelUnreadCount(c.id, userId),
      lastMessageAt: getLastMessageAt(c.id),
    };
  });
  return [...dept, ...listDmsForUser(userId)];
}

// ---------- Messages ----------

export function listMessages(channelId, { since, limit = 100 } = {}) {
  let rows = db.chatMessages.filter((m) => m.channelId === channelId);
  if (since) rows = rows.filter((m) => m.createdAt > since);
  rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return rows.slice(-limit);
}

function getLastMessageAt(channelId) {
  const msgs = db.chatMessages.filter((m) => m.channelId === channelId);
  return msgs.length > 0 ? msgs[msgs.length - 1].createdAt : null;
}

export function getChannelUnreadCount(channelId, userId) {
  const read = (db.notificationReads || []).find(
    (r) => r.userId === userId && r.notificationId === `chat:${channelId}`,
  );
  const lastReadAt = read?.readAt ?? '1970-01-01T00:00:00.000Z';
  return db.chatMessages.filter(
    (m) => m.channelId === channelId && m.createdAt > lastReadAt && m.authorId !== userId,
  ).length;
}

export function markChannelRead(channelId, userId) {
  if (!db.notificationReads) db.notificationReads = [];
  const key = `chat:${channelId}`;
  const existing = db.notificationReads.find(
    (r) => r.userId === userId && r.notificationId === key,
  );
  if (existing) {
    existing.readAt = timestamp();
    return existing;
  }
  const entry = { id: id(), userId, notificationId: key, readAt: timestamp() };
  db.notificationReads.push(entry);
  return entry;
}

export function validateMessageBody(body) {
  if (typeof body !== 'string') return { ok: false, error: 'Message body must be a string' };
  const trimmed = body.trim();
  if (!trimmed) return { ok: false, error: 'Message cannot be empty' };
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, error: `Message exceeds ${MAX_MESSAGE_LENGTH} characters` };
  }
  return { ok: true, value: trimmed };
}

export function validateAttachment(att) {
  if (!att) return { ok: true, value: null };
  if (typeof att !== 'object') return { ok: false, error: 'Attachment must be an object' };
  const { name, size, type, data } = att;
  if (!name || typeof name !== 'string') return { ok: false, error: 'Attachment name required' };
  if (typeof size !== 'number' || size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes` };
  }
  if (!['image', 'file'].includes(type)) {
    return { ok: false, error: 'Attachment type must be image or file' };
  }
  if (!data || typeof data !== 'string') {
    return { ok: false, error: 'Attachment data (base64) required' };
  }
  return { ok: true, value: { name, size, type, data } };
}

export function createChatMessage({ channelId, author, body, attachment = null, reportPayload = null }) {
  const name = author?.name || 'Admin';
  const message = {
    id: id(),
    channelId,
    authorId: author?.id ?? null,
    authorName: name,
    authorInitials: initials(name),
    body,
    attachment,
    reportPayload,
    createdAt: timestamp(),
  };
  db.chatMessages.push(message);

  // Update DM metadata if it's a DM channel
  const dm = (db.dmChannels || []).find((c) => c.id === channelId);
  if (dm) dm.lastMessageAt = message.createdAt;

  return message;
}

function initials(name) {
  if (!name) return 'A';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0].toUpperCase())
    .join('') || 'A';
}

// ---------- Reports ----------

export function generateReport(kind) {
  const now = timestamp();
  if (kind === 'daily-ops') {
    return {
      kind: 'daily-ops',
      title: 'Daily Operations Summary',
      generatedAt: now,
      data: {
        users: db.users.length,
        riders: db.riders.length,
        drivers: db.drivers.length,
        rides: db.rides.length,
        activeDrivers: db.drivers.filter((d) => d.onlineStatus && d.status === 'active').length,
        openSos: db.sosEvents.filter((s) => ['open', 'acknowledged', 'dispatched'].includes(s.status)).length,
      },
    };
  }
  if (kind === 'finance-snapshot') {
    const successful = db.payments.filter((p) => p.status === 'successful');
    return {
      kind: 'finance-snapshot',
      title: 'Finance Snapshot',
      generatedAt: now,
      data: {
        totalRevenue: successful.reduce((s, p) => s + Number(p.amount || 0), 0),
        pendingWithdrawals: db.withdrawals.filter((w) => w.status === 'pending').length,
        activeSubscriptions: db.subscriptions.filter(
          (s) => s.status === 'active' && new Date(s.expiresAt) > new Date(),
        ).length,
      },
    };
  }
  return {
    kind: 'generic',
    title: 'Generic Report',
    generatedAt: now,
    data: { note: 'Unknown report kind' },
  };
}