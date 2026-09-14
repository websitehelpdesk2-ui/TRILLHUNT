import { route } from './registry.ts';
import { all, get, run, tx, cfg } from '../lib/db.ts';
import { requireUser, requireWrite } from '../lib/auth.ts';
import { rateLimit } from '../lib/guard.ts';
import { id, now, readJson, str, oneOf, bad, forbid, notFound, token } from '../lib/util.ts';
import { publicUser } from '../lib/view.ts';
import { moderateText, openCase, recordStrike } from '../services/moderation.ts';
import { has, requireEntitlement } from '../services/entitlements.ts';
import { signMediaUrl } from '../services/storage.ts';
import { notify } from '../services/notifications.ts';
import { awardXp, checkBadges } from '../services/xp.ts';

// ---------------------------------------------------------------- helpers
function membership(chatId: string, userId: string) {
  return get<any>('SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?', [chatId, userId]);
}

function assertChatAccess(chatId: string, userId: string, forWrite = false) {
  const chat = get<any>('SELECT * FROM chats WHERE id = ?', [chatId]);
  if (!chat) throw notFound('Chat not found.');
  const m = membership(chatId, userId);
  if (chat.kind === 'location') {
    // Location chats are open to any signed-in adult; joining is implicit.
    if (!m && forWrite) {
      run('INSERT INTO chat_members (chat_id, user_id, state, joined_at) VALUES (?,?,?,?)', [chatId, userId, 'active', now()]);
    }
    return chat;
  }
  if (!m || m.state === 'left') throw forbid('You are not a member of this conversation.', 'not_a_member');
  if (chat.kind === 'dm' && m.state === 'requested' && forWrite) {
    throw forbid('Accept this message request before replying.', 'request_pending');
  }
  return chat;
}

function blockedBetween(a: string, b: string) {
  return !!get('SELECT 1 FROM user_blocks WHERE kind = ? AND ((user_id = ? AND target_id = ?) OR (user_id = ? AND target_id = ?))',
    ['block', a, b, b, a]);
}

function serializeMessages(chatId: string, viewerId: string, before?: string | null, limit = 50) {
  const rows = all<any>(
    `SELECT m.*, p.username, p.avatar_emoji FROM messages m JOIN profiles p ON p.user_id = m.user_id
      WHERE m.chat_id = ? AND m.deleted_at IS NULL AND m.moderation_status != 'blocked'
        ${before ? 'AND m.created_at < ?' : ''}
        AND m.user_id NOT IN (SELECT target_id FROM user_blocks WHERE user_id = ?)
      ORDER BY m.created_at DESC LIMIT ?`,
    before ? [chatId, before, viewerId, limit] : [chatId, viewerId, limit]);

  const muted = new Set(all<any>('SELECT target_id FROM user_blocks WHERE user_id = ? AND kind = ?', [viewerId, 'mute']).map((r) => r.target_id));

  return rows.reverse().map((m) => {
    const attachments = all<any>(
      `SELECT ma.media_id, a.moderation_status, a.width, a.height, a.mime
         FROM message_attachments ma JOIN media_assets a ON a.id = ma.media_id
        WHERE ma.message_id = ? AND a.deleted_at IS NULL ORDER BY ma.position`, [m.id])
      .filter((a) => a.moderation_status === 'approved' || (a.moderation_status === 'review' && m.user_id === viewerId))
      .map((a) => ({
        media_id: a.media_id, width: a.width, height: a.height, mime: a.mime,
        pending: a.moderation_status !== 'approved',
        url: signMediaUrl(a.media_id, viewerId),   // short-lived, viewer-bound
      }));
    return {
      id: m.id, user: { id: m.user_id, username: m.username, avatar_emoji: m.avatar_emoji },
      body: m.moderation_status === 'pending' && m.user_id !== viewerId ? null : m.body,
      pending: m.moderation_status === 'pending',
      muted: muted.has(m.user_id),
      reply_to_id: m.reply_to_id, created_at: m.created_at, edited_at: m.edited_at,
      attachments,
      reactions: all<any>('SELECT emoji, COUNT(*) c FROM message_reactions WHERE message_id = ? GROUP BY emoji', [m.id]),
      mine: m.user_id === viewerId,
    };
  });
}

// ------------------------------------------------------------------ chats
route('GET', '/api/chats', ({ ctx }) => {
  const u = requireUser(ctx);
  const rows = all<any>(
    `SELECT c.*, cm.state, cm.last_read_at, l.name AS location_name, l.slug AS location_slug, g.name AS group_name
       FROM chat_members cm JOIN chats c ON c.id = cm.chat_id
       LEFT JOIN locations l ON l.id = c.location_id
       LEFT JOIN groups g ON g.id = c.group_id
      WHERE cm.user_id = ? AND cm.state != 'left'`, [u.id]);
  return {
    chats: rows.map((c) => {
      const last = get<any>(`SELECT body, created_at, user_id FROM messages WHERE chat_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`, [c.id]);
      const unread = get<any>(`SELECT COUNT(*) n FROM messages WHERE chat_id = ? AND created_at > ?`, [c.id, c.last_read_at ?? '1970'])?.n ?? 0;
      let title = c.title ?? c.group_name ?? c.location_name;
      if (c.kind === 'dm') {
        const other = get<any>('SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?', [c.id, u.id]);
        title = other ? `@${get<any>('SELECT username FROM profiles WHERE user_id = ?', [other.user_id])?.username ?? 'hunter'}` : 'Direct message';
      }
      return {
        id: c.id, kind: c.kind, title, state: c.state,
        location_slug: c.location_slug, group_id: c.group_id,
        last_message: last ? { body: last.body, created_at: last.created_at } : null,
        unread,
      };
    }).sort((a, b) => String(b.last_message?.created_at ?? '').localeCompare(String(a.last_message?.created_at ?? ''))),
  };
});

route('GET', '/api/chats/:id/messages', ({ ctx, params, query }) => {
  const u = requireUser(ctx);
  assertChatAccess(params.id, u.id, false);
  return {
    messages: serializeMessages(params.id, u.id, query.get('before')),
    can_upload_images: has(u.id, 'image_upload'),   // display hint only; server re-checks on send
  };
});

route('POST', '/api/chats/:id/read', ({ ctx, params }) => {
  const u = requireUser(ctx);
  run('UPDATE chat_members SET last_read_at = ? WHERE chat_id = ? AND user_id = ?', [now(), params.id, u.id]);
  return { ok: true };
});

route('POST', '/api/chats/:id/messages', async ({ req, ctx, params }) => {
  const u = requireWrite(ctx);
  const limits: any = cfg('chat.limits');
  rateLimit(`msg:${u.id}`, limits.messages_per_minute, 60);
  const chat = assertChatAccess(params.id, u.id, true);
  const b = await readJson(req);
  const body = str(b.body, 'Message', { max: 2000, required: false });
  const mediaIds: string[] = Array.isArray(b.media_ids) ? b.media_ids.slice(0, 10) : [];
  if (!body && !mediaIds.length) throw bad('Write something first.');

  // ---- PAYWALL (§17/§19/§55) -------------------------------------------
  // Server-side entitlement check. There is no client flag that can bypass it.
  if (mediaIds.length) {
    requireEntitlement(u.id, 'image_upload');
    const max = (cfg('uploads.limits') as any).max_images_per_message;
    if (mediaIds.length > max) throw bad(`Up to ${max} images per message.`);
  }

  const verdict = body ? moderateText(body) : { verdict: 'approve' as const, provider: 'rules', labels: [], score: 0 };
  if (verdict.verdict === 'block') {
    const caseId = openCase({ subjectType: 'message', subjectId: `blocked:${id()}`, ownerUserId: u.id, origin: 'auto_moderation', severity: 'high', notes: verdict.labels.join(',') });
    recordStrike(u.id, 'high', 'Message violated Community Guidelines', caseId);
    throw forbid("This message couldn't be posted because it may violate THRILLHUNT's Community Guidelines.", 'content_blocked');
  }

  const mid = id('msg');
  tx(() => {
    run(`INSERT INTO messages (id, chat_id, user_id, body, reply_to_id, moderation_status, created_at) VALUES (?,?,?,?,?,?,?)`,
        [mid, params.id, u.id, body || null, b.reply_to_id ?? null, verdict.verdict === 'review' ? 'pending' : 'approved', now()]);
    let pos = 0;
    for (const mediaId of mediaIds) {
      const asset = get<any>('SELECT id, owner_user_id, moderation_status FROM media_assets WHERE id = ? AND deleted_at IS NULL', [mediaId]);
      if (!asset || asset.owner_user_id !== u.id) throw forbid('That image is not available.', 'invalid_media');
      if (asset.moderation_status === 'blocked') throw forbid("This image couldn't be posted because it may violate THRILLHUNT's Community Guidelines.", 'content_blocked');
      run('INSERT INTO message_attachments (message_id, media_id, position) VALUES (?,?,?)', [mid, mediaId, pos++]);
      run(`UPDATE media_assets SET attached_to = 'message' WHERE id = ?`, [mediaId]);
    }
  });
  if (verdict.verdict === 'review') {
    openCase({ subjectType: 'message', subjectId: mid, ownerUserId: u.id, origin: 'auto_moderation', severity: 'normal', notes: verdict.labels.join(',') });
  }

  // Mentions -> notifications, capped to prevent mention-spam.
  const mentions = (body.match(/@([a-zA-Z0-9_]{3,24})/g) ?? []).slice(0, limits.mentions_per_message);
  for (const m of mentions) {
    const target = get<any>('SELECT user_id FROM profiles WHERE lower(username) = lower(?)', [m.slice(1)]);
    if (target && target.user_id !== u.id && !blockedBetween(u.id, target.user_id)) {
      notify(target.user_id, 'mention', `@${u.username} mentioned you`, body.slice(0, 120), `/app#/chat/${params.id}`);
    }
  }
  return { message: serializeMessages(params.id, u.id).find((m) => m.id === mid), moderation: verdict.verdict };
}, 201);

route('POST', '/api/messages/:id/react', async ({ req, ctx, params }) => {
  const u = requireWrite(ctx);
  const b = await readJson(req);
  const emoji = str(b.emoji, 'Reaction', { max: 8 });
  const msg = get<any>('SELECT chat_id FROM messages WHERE id = ?', [params.id]);
  if (!msg) throw notFound();
  assertChatAccess(msg.chat_id, u.id, false);
  const existing = get('SELECT 1 FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [params.id, u.id, emoji]);
  if (existing) run('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [params.id, u.id, emoji]);
  else run('INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?,?,?,?)', [params.id, u.id, emoji, now()]);
  return { ok: true, added: !existing };
});

route('DELETE', '/api/messages/:id', ({ ctx, params }) => {
  const u = requireUser(ctx);
  const msg = get<any>('SELECT user_id FROM messages WHERE id = ?', [params.id]);
  if (!msg) throw notFound();
  if (msg.user_id !== u.id && !['admin', 'moderator'].includes(u.role)) throw forbid();
  run('UPDATE messages SET deleted_at = ? WHERE id = ?', [now(), params.id]);
  return { ok: true };
});

// ----------------------------------------------------------------- groups
route('POST', '/api/groups', async ({ req, ctx }) => {
  const u = requireWrite(ctx);
  rateLimit(`group:${u.id}`, 5, 3600);
  const b = await readJson(req);
  const name = str(b.name, 'Group name', { min: 3, max: 60 });
  const loc = b.location_slug ? get<any>('SELECT id, access_policy FROM locations WHERE slug = ?', [b.location_slug]) : null;
  if (b.location_slug && !loc) throw notFound('Location not found.');
  if (loc?.access_policy === 'private_closed') throw bad('Groups cannot be created for private or closed property.', 'restricted_location');
  const gid = id('grp');
  const cid = id('cht');
  tx(() => {
    run(`INSERT INTO groups (id, name, description, location_id, planned_date, visibility, max_members, invite_code, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [gid, name, str(b.description, 'Description', { max: 500, required: false }), loc?.id ?? null,
         b.planned_date ?? null, oneOf(b.visibility ?? 'private', 'Visibility', ['public', 'private']),
         Math.min(Number(b.max_members ?? 12), 50), token(6).toUpperCase().slice(0, 8), u.id, now()]);
    run('INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?,?,?,?)', [gid, u.id, 'owner', now()]);
    run('INSERT INTO chats (id, kind, group_id, title, created_at) VALUES (?,?,?,?,?)', [cid, 'group', gid, name, now()]);
    run('INSERT INTO chat_members (chat_id, user_id, state, joined_at) VALUES (?,?,?,?)', [cid, u.id, 'active', now()]);
  });
  awardXp(u.id, 'joined_group', undefined, `group:${gid}`);
  const g = get<any>('SELECT * FROM groups WHERE id = ?', [gid])!;
  return { group: { ...g, chat_id: cid, invite_link: `/app#/join/${g.invite_code}` } };
}, 201);

route('GET', '/api/groups', ({ ctx }) => {
  const u = requireUser(ctx);
  const rows = all<any>(
    `SELECT g.*, c.id AS chat_id, l.name AS location_name, l.slug AS location_slug,
            (SELECT COUNT(*) FROM group_members gm2 WHERE gm2.group_id = g.id AND gm2.left_at IS NULL) AS member_count
       FROM group_members gm JOIN groups g ON g.id = gm.group_id
       LEFT JOIN chats c ON c.group_id = g.id
       LEFT JOIN locations l ON l.id = g.location_id
      WHERE gm.user_id = ? AND gm.left_at IS NULL AND g.deleted_at IS NULL
      ORDER BY g.created_at DESC`, [u.id]);
  return { groups: rows.map((g) => ({ ...g, invite_link: `/app#/join/${g.invite_code}` })) };
});

route('GET', '/api/groups/:id', ({ ctx, params }) => {
  const u = requireUser(ctx);
  const g = get<any>('SELECT * FROM groups WHERE id = ? AND deleted_at IS NULL', [params.id]);
  if (!g) throw notFound();
  const mine = get<any>('SELECT * FROM group_members WHERE group_id = ? AND user_id = ? AND left_at IS NULL', [g.id, u.id]);
  if (!mine && g.visibility === 'private') throw forbid('This group is private.', 'private_group');
  const members = all<any>('SELECT user_id, role FROM group_members WHERE group_id = ? AND left_at IS NULL', [g.id]);
  const chat = get<any>('SELECT id FROM chats WHERE group_id = ?', [g.id]);
  return {
    group: { ...g, invite_link: `/app#/join/${g.invite_code}`, chat_id: chat?.id ?? null },
    members: members.map((m) => ({ ...publicUser(m.user_id, u.id), role: m.role })),
    is_member: !!mine,
  };
});

route('POST', '/api/groups/join/:code', ({ ctx, params }) => {
  const u = requireWrite(ctx);
  const g = get<any>('SELECT * FROM groups WHERE invite_code = ? AND deleted_at IS NULL', [params.code.toUpperCase()]);
  if (!g) throw notFound('That invite link is not valid.');
  const count = get<any>('SELECT COUNT(*) c FROM group_members WHERE group_id = ? AND left_at IS NULL', [g.id])?.c ?? 0;
  if (count >= g.max_members) throw bad('This group is full.');
  const chat = get<any>('SELECT id FROM chats WHERE group_id = ?', [g.id]);
  tx(() => {
    run(`INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?,?,?,?)
         ON CONFLICT(group_id, user_id) DO UPDATE SET left_at = NULL`, [g.id, u.id, 'member', now()]);
    if (chat) run(`INSERT INTO chat_members (chat_id, user_id, state, joined_at) VALUES (?,?,?,?)
                   ON CONFLICT(chat_id, user_id) DO UPDATE SET state = 'active'`, [chat.id, u.id, 'active', now()]);
  });
  awardXp(u.id, 'joined_group', undefined, `group:${g.id}`);
  notify(g.created_by, 'group', `@${u.username} joined ${g.name}`, undefined, `/app#/groups/${g.id}`);
  return { group_id: g.id, chat_id: chat?.id ?? null };
});

route('POST', '/api/groups/:id/leave', ({ ctx, params }) => {
  const u = requireUser(ctx);
  run('UPDATE group_members SET left_at = ? WHERE group_id = ? AND user_id = ?', [now(), params.id, u.id]);
  const chat = get<any>('SELECT id FROM chats WHERE group_id = ?', [params.id]);
  if (chat) run(`UPDATE chat_members SET state = 'left' WHERE chat_id = ? AND user_id = ?`, [chat.id, u.id]);
  return { ok: true };
});

// -------------------------------------------------------------------- DMs
route('POST', '/api/dm/:username', async ({ req, ctx, params }) => {
  const u = requireWrite(ctx);
  const limits: any = cfg('chat.limits');
  rateLimit(`dm:${u.id}`, limits.dm_requests_per_day, 86400);   // §16 anti mass-messaging
  const target = get<any>('SELECT user_id, dm_policy FROM profiles WHERE lower(username) = lower(?)', [params.username]);
  if (!target) throw notFound('No such hunter.');
  if (target.user_id === u.id) throw bad('You cannot message yourself.');
  if (blockedBetween(u.id, target.user_id)) throw forbid('You cannot message this person.', 'blocked');
  if (target.dm_policy === 'nobody') throw forbid('This hunter is not accepting messages.', 'dm_closed');
  if (target.dm_policy === 'groups_only') {
    const shared = get<any>(`SELECT 1 FROM group_members a JOIN group_members b ON a.group_id = b.group_id
                              WHERE a.user_id = ? AND b.user_id = ? AND a.left_at IS NULL AND b.left_at IS NULL`, [u.id, target.user_id]);
    if (!shared) throw forbid('This hunter only accepts messages from people in their groups.', 'dm_groups_only');
  }

  const existing = get<any>(
    `SELECT c.id FROM chats c
      JOIN chat_members a ON a.chat_id = c.id AND a.user_id = ?
      JOIN chat_members b ON b.chat_id = c.id AND b.user_id = ?
     WHERE c.kind = 'dm'`, [u.id, target.user_id]);
  if (existing) return { chat_id: existing.id, state: 'active' };

  const cid = id('cht');
  // Message requests: the recipient must accept before the thread opens (§16).
  const targetState = target.dm_policy === 'everyone' ? 'active' : 'requested';
  tx(() => {
    run('INSERT INTO chats (id, kind, title, created_at) VALUES (?,?,?,?)', [cid, 'dm', null, now()]);
    run('INSERT INTO chat_members (chat_id, user_id, state, joined_at) VALUES (?,?,?,?)', [cid, u.id, 'active', now()]);
    run('INSERT INTO chat_members (chat_id, user_id, state, joined_at) VALUES (?,?,?,?)', [cid, target.user_id, targetState, now()]);
  });
  notify(target.user_id, 'dm', targetState === 'requested' ? `@${u.username} sent a message request` : `@${u.username} started a conversation`, undefined, `/app#/chat/${cid}`);
  return { chat_id: cid, state: targetState };
}, 201);

route('POST', '/api/chats/:id/accept', ({ ctx, params }) => {
  const u = requireUser(ctx);
  run(`UPDATE chat_members SET state = 'active' WHERE chat_id = ? AND user_id = ? AND state = 'requested'`, [params.id, u.id]);
  return { ok: true };
});

// -------------------------------------------------------- block / mute
route('POST', '/api/users/:username/block', async ({ req, ctx, params }) => {
  const u = requireUser(ctx);
  const b = await readJson(req);
  const kind = oneOf(b.kind ?? 'block', 'Kind', ['block', 'mute']);
  const target = get<any>('SELECT user_id FROM profiles WHERE lower(username) = lower(?)', [params.username]);
  if (!target) throw notFound();
  if (target.user_id === u.id) throw bad('You cannot block yourself.');
  if (b.undo) { run('DELETE FROM user_blocks WHERE user_id = ? AND target_id = ? AND kind = ?', [u.id, target.user_id, kind]); return { ok: true, active: false }; }
  run('INSERT OR IGNORE INTO user_blocks (user_id, target_id, kind, created_at) VALUES (?,?,?,?)', [u.id, target.user_id, kind, now()]);
  return { ok: true, active: true, kind };
});

route('GET', '/api/blocks', ({ ctx }) => {
  const u = requireUser(ctx);
  return { blocks: all<any>('SELECT target_id, kind, created_at FROM user_blocks WHERE user_id = ?', [u.id])
    .map((b) => ({ ...b, user: publicUser(b.target_id, u.id) })) };
});
