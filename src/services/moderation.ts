/**
 * MODERATION (§21–§25, §28)
 *
 * Pipeline: provider verdict -> APPROVE | REVIEW | BLOCK.
 *   APPROVE — visible immediately.
 *   REVIEW  — hidden from other users, queued for a human.
 *   BLOCK   — never stored as visible content; case opened; strike recorded.
 *
 * No custom moderation model is trained here (§21). `mock` is a deterministic
 * local stand-in so the pipeline is testable offline; the real adapters call an
 * established provider. §28: adventure imagery (costumes, fake blood, haunted
 * attractions, heights, camping) is explicitly NOT penalised.
 */
import { config } from '../config.ts';
import { all, get, run, cfg } from '../lib/db.ts';
import { id, now, plusHours } from '../lib/util.ts';
import { notify } from './notifications.ts';

export type Verdict = 'approve' | 'review' | 'block';
export interface ModResult { verdict: Verdict; provider: string; labels: string[]; score: number }

export interface ImageModerator { name: string; check(buf: Buffer, meta: { mime: string; sha256: string; filename: string }): Promise<ModResult> }

/**
 * Deterministic local moderator. Real deployments swap this out; the contract
 * is identical so no calling code changes.
 */
const mockImage: ImageModerator = {
  name: 'mock',
  async check(buf, meta) {
    const name = meta.filename.toLowerCase();
    // Test hooks so the pipeline's three branches are exercisable in dev/CI.
    if (/(^|[-_.])block([-_.]|$)|nsfw|gore|explicit/.test(name)) {
      return { verdict: 'block', provider: 'mock', labels: ['prohibited_content'], score: 0.97 };
    }
    if (/(^|[-_.])review([-_.]|$)|borderline/.test(name)) {
      return { verdict: 'review', provider: 'mock', labels: ['borderline'], score: 0.55 };
    }
    // A tiny denylist of known-bad hashes stands in for a real hash-matching service.
    const deny: string[] = (cfg('moderation.hash_denylist') as string[]) ?? [];
    if (deny.includes(meta.sha256)) return { verdict: 'block', provider: 'mock', labels: ['hash_match'], score: 1 };
    return { verdict: 'approve', provider: 'mock', labels: ['adventure_ok'], score: 0.02 };
  },
};

/**
 * Example real adapter shape. Not wired to credentials in this build; enabling
 * it requires IMAGE_MODERATION_PROVIDER + cloud credentials (see README).
 */
const rekognition: ImageModerator = {
  name: 'rekognition',
  async check() {
    throw new Error('Rekognition adapter requires AWS credentials; set IMAGE_MODERATION_PROVIDER=mock for local dev.');
  },
};

export const imageModerator: ImageModerator =
  config.providers.imageModeration === 'rekognition' ? rekognition : mockImage;

// ------------------------------------------------------------------- text
const SLUR_OR_THREAT = /\b(kill yourself|kys)\b/i;
// §3/§44 — we do not host how-to content for getting into places illegally.
const ILLEGAL_HOWTO = /\b(cut the (?:lock|fence)|bypass the (?:alarm|security|gate)|how to break in|pick the lock|ignore the no.?trespass)/i;
const SPAM = /(https?:\/\/\S+){4,}|\b(free crypto|onlyfans|telegram\s*@)/i;

export function moderateText(body: string): ModResult {
  if (SLUR_OR_THREAT.test(body)) return { verdict: 'block', provider: 'rules', labels: ['harassment_threat'], score: 0.95 };
  if (ILLEGAL_HOWTO.test(body)) return { verdict: 'review', provider: 'rules', labels: ['illegal_access_instructions'], score: 0.7 };
  if (SPAM.test(body)) return { verdict: 'review', provider: 'rules', labels: ['spam'], score: 0.6 };
  return { verdict: 'approve', provider: 'rules', labels: [], score: 0 };
}

// ------------------------------------------------------------------ cases
export function openCase(o: {
  subjectType: string; subjectId: string; ownerUserId?: string | null;
  origin: 'user_report' | 'auto_moderation' | 'admin' | 'appeal';
  severity?: 'low' | 'normal' | 'high' | 'critical'; notes?: string;
}) {
  const existing = get<any>(
    `SELECT id FROM moderation_cases WHERE subject_type = ? AND subject_id = ? AND status IN ('open','in_review')`,
    [o.subjectType, o.subjectId],
  );
  if (existing) {
    run('UPDATE moderation_cases SET report_count = report_count + 1, updated_at = ? WHERE id = ?', [now(), existing.id]);
    return existing.id as string;
  }
  const cid = id('case');
  run(
    `INSERT INTO moderation_cases (id, subject_type, subject_id, owner_user_id, origin, severity, status, report_count, notes, created_at, updated_at)
     VALUES (?,?,?,?,?,?, 'open', 1, ?,?,?)`,
    [cid, o.subjectType, o.subjectId, o.ownerUserId ?? null, o.origin, o.severity ?? 'normal', o.notes ?? null, now(), now()],
  );
  return cid;
}

export function logAction(caseId: string | null, actorId: string | null, action: string, targetUser?: string | null, reason?: string, meta?: unknown) {
  run(
    `INSERT INTO moderation_actions (id, case_id, actor_id, action, target_user, reason, meta_json, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [id('act'), caseId, actorId, action, targetUser ?? null, reason ?? null, meta ? JSON.stringify(meta) : null, now()],
  );
}

/**
 * §25 — configurable enforcement ladder. Thresholds live in app_config so an
 * administrator can tune them without a deploy.
 */
export function recordStrike(userId: string, severity: 'low' | 'normal' | 'high' | 'critical', reason: string, caseId?: string) {
  const rules: any = cfg('moderation.enforcement');
  run('UPDATE users SET violation_count = violation_count + 1, updated_at = ? WHERE id = ?', [now(), userId]);
  const u = get<any>('SELECT violation_count FROM users WHERE id = ?', [userId]);
  const n = u?.violation_count ?? 1;

  let applied = 'warn';
  if (severity === 'critical' && rules.critical_immediate_suspend) applied = 'suspend';
  else if (n >= rules.ban_at) applied = 'ban';
  else if (n >= rules.suspend_at) applied = 'suspend';
  else if (n >= rules.restrict_at) applied = 'restrict';

  if (applied === 'restrict') {
    run('UPDATE users SET status = ?, restricted_until = ?, status_reason = ?, updated_at = ? WHERE id = ?',
        ['restricted', plusHours(rules.restrict_hours), reason, now(), userId]);
  } else if (applied === 'suspend') {
    run('UPDATE users SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?', ['suspended', reason, now(), userId]);
  } else if (applied === 'ban') {
    run('UPDATE users SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?', ['banned', reason, now(), userId]);
  }

  logAction(caseId ?? null, null, applied, userId, reason, { violation_count: n, severity });
  notify(userId, 'moderation', 'Community Guidelines notice',
    applied === 'warn'
      ? 'Content was removed for violating the Community Guidelines. You can appeal from Settings.'
      : `Your account has been ${applied === 'restrict' ? 'temporarily restricted' : applied === 'suspend' ? 'suspended' : 'banned'}. You can appeal from Settings.`,
    '/app#/settings/appeals');
  return applied;
}

export function queueStats() {
  return {
    open_cases: get<any>(`SELECT COUNT(*) c FROM moderation_cases WHERE status IN ('open','in_review')`)?.c ?? 0,
    pending_images: get<any>(`SELECT COUNT(*) c FROM media_assets WHERE moderation_status = 'review'`)?.c ?? 0,
    blocked_images: get<any>(`SELECT COUNT(*) c FROM media_assets WHERE moderation_status = 'blocked'`)?.c ?? 0,
    approved_images: get<any>(`SELECT COUNT(*) c FROM media_assets WHERE moderation_status = 'approved'`)?.c ?? 0,
    open_safety: get<any>(`SELECT COUNT(*) c FROM safety_reports WHERE status = 'open'`)?.c ?? 0,
    open_appeals: get<any>(`SELECT COUNT(*) c FROM appeals WHERE status = 'open'`)?.c ?? 0,
    suspended_users: get<any>(`SELECT COUNT(*) c FROM users WHERE status IN ('suspended','banned')`)?.c ?? 0,
    repeat_offenders: get<any>(`SELECT COUNT(*) c FROM users WHERE violation_count >= 2`)?.c ?? 0,
  };
}
