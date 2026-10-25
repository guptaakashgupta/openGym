/* The gym routes (product mode). Kept out of server.js's route map: they carry path parameters
   and their own authorisation, but go through the same dispatcher, so body parsing, response
   helpers, the origin check and the session code are server.js's. Every handler resolves the
   caller (resolvePrincipal) before it looks anything up, and every lookup is scoped to the gym or
   assignment that principal holds. */
import { resolvePrincipal, requireGymRole, clientsOf, assignedClient } from './access.js';
import { assignTrainer, endAssignment } from './assignments.js';
import { endMembership, getMembership } from './memberships.js';
import { errorAnswer, notFound, badRequest } from './errors.js';
import { createInvitation, listInvitations, revokeInvitation, previewInvitation, redeemInvitation } from './invitations.js';
import { projectWorkouts } from './workout-projection.js';

const ID = '[A-Za-z0-9_-]{1,64}';
const TEMPLATES = [
  ['GET', '/api/platform/me'],
  ['GET', '/api/platform/gyms/{gymId}/members'],
  ['POST', '/api/platform/gyms/{gymId}/assignments'],
  ['DELETE', '/api/platform/gyms/{gymId}/assignments/{assignmentId}'],
  ['POST', '/api/platform/gyms/{gymId}/memberships/{membershipId}/end'],
  ['GET', '/api/platform/clients'],
  ['GET', '/api/platform/clients/{membershipId}/workouts'],
  ['GET', '/api/platform/gyms/{gymId}/invitations'],
  ['POST', '/api/platform/gyms/{gymId}/invitations'],
  ['DELETE', '/api/platform/gyms/{gymId}/invitations/{invitationId}'],
  ['POST', '/api/platform/invitations/preview'],
  ['POST', '/api/platform/invitations/redeem'],
];
const tokenOf = body => (typeof body.token === 'string' && body.token.length <= 200 ? body.token : '');
const compile = path => new RegExp('^' + path.replace(/\{(\w+)\}/g, (_, n) => `(?<${n}>${ID})`) + '$');

export function platformRoutes({ db, json, readBody, readSession, audit }) {
  const handlers = {
    'GET /api/platform/me': async ({ principal }) => ({
      roles: principal.memberships.map(m => ({ gymId: m.gymId, gymName: m.gymName, role: m.role, membershipId: m.id })),
    }),

    'GET /api/platform/gyms/{gymId}/members': async ({ principal, params }) => {
      requireGymRole(principal, params.gymId, 'owner');
      const { rows } = await db.query(
        `SELECT m.id, m.user_id, m.role, m.started_at, u.name, a.trainer_membership_id
           FROM gym_memberships m JOIN users u ON u.id = m.user_id
           LEFT JOIN trainer_assignments a ON a.member_membership_id = m.id AND a.ended_at IS NULL
          WHERE m.gym_id = $1 AND m.ended_at IS NULL
          ORDER BY m.role, u.name, m.id`, [params.gymId]);
      return { members: rows.map(r => ({ membershipId: r.id, userId: r.user_id, name: r.name, role: r.role, since: r.started_at, trainerMembershipId: r.trainer_membership_id || null })) };
    },

    'POST /api/platform/gyms/{gymId}/assignments': async ({ req, principal, params, body, user }) => {
      requireGymRole(principal, params.gymId, 'owner');
      const { memberMembershipId, trainerMembershipId } = body;
      if (typeof memberMembershipId !== 'string' || typeof trainerMembershipId !== 'string') throw badRequest('missing');
      const assignment = await assignTrainer(db, { gymId: params.gymId, memberMembershipId, trainerMembershipId });
      audit(req, 'gym.assign', { user, msg: `${params.gymId} ${memberMembershipId}→${trainerMembershipId}` });
      return { assignment };
    },

    'DELETE /api/platform/gyms/{gymId}/assignments/{assignmentId}': async ({ req, principal, params, user }) => {
      requireGymRole(principal, params.gymId, 'owner');
      await endAssignment(db, { gymId: params.gymId, assignmentId: params.assignmentId });
      audit(req, 'gym.unassign', { user, msg: `${params.gymId} ${params.assignmentId}` });
      return { ok: true };
    },

    'POST /api/platform/gyms/{gymId}/memberships/{membershipId}/end': async ({ req, principal, params, user }) => {
      requireGymRole(principal, params.gymId, 'owner');
      if (!(await getMembership(db, { gymId: params.gymId, membershipId: params.membershipId }))) throw notFound();
      const ended = await endMembership(db, { gymId: params.gymId, membershipId: params.membershipId });
      audit(req, 'gym.membership.end', { user, msg: `${params.gymId} ${ended.id} ${ended.role}` });
      return { ok: true };
    },

    'GET /api/platform/clients': async ({ principal }) => ({ clients: await clientsOf(db, principal.userId) }),

    // Online only: the answer is checked against the assignment as it is now, every time, and the
    // client keeps no copy (docs/plans design §5).
    'GET /api/platform/clients/{membershipId}/workouts': async ({ principal, params }) => {
      const client = await assignedClient(db, principal.userId, params.membershipId);
      const visible = await db.query('SELECT workout_id FROM workout_visibility WHERE user_id = $1 AND membership_id = $2',
        [client.memberUserId, client.memberMembershipId]);
      const doc = await db.query('SELECT document FROM member_states WHERE user_id = $1', [client.memberUserId]);
      return projectWorkouts(doc.rows[0]?.document || {}, new Set(visible.rows.map(r => r.workout_id)));
    },

    'GET /api/platform/gyms/{gymId}/invitations': async ({ principal, params }) => {
      requireGymRole(principal, params.gymId, 'owner');
      return { invitations: await listInvitations(db, params.gymId) };
    },

    // Trainers and members only: owners are provisioned by the platform operator.
    'POST /api/platform/gyms/{gymId}/invitations': async ({ req, principal, params, body, user }) => {
      requireGymRole(principal, params.gymId, 'owner');
      if (body.role !== 'trainer' && body.role !== 'member') throw badRequest('bad-role');
      const recipientUserId = typeof body.recipientUserId === 'string' && body.recipientUserId ? body.recipientUserId : null;
      if (recipientUserId && !(await db.query('SELECT 1 FROM users WHERE id = $1', [recipientUserId])).rows[0]) throw badRequest('recipient-unknown');
      const made = await createInvitation(db, { gymId: params.gymId, role: body.role, createdBy: user.id, recipientUserId });
      audit(req, 'gym.invite.create', { user, msg: `${params.gymId} ${made.invitation.id} ${body.role}` });
      return made;
    },

    'DELETE /api/platform/gyms/{gymId}/invitations/{invitationId}': async ({ req, principal, params, user }) => {
      requireGymRole(principal, params.gymId, 'owner');
      await revokeInvitation(db, { gymId: params.gymId, invitationId: params.invitationId });
      audit(req, 'gym.invite.revoke', { user, msg: `${params.gymId} ${params.invitationId}` });
      return { ok: true };
    },

    'POST /api/platform/invitations/preview': async ({ user, body }) => previewInvitation(db, tokenOf(body), user.id),

    'POST /api/platform/invitations/redeem': async ({ req, user, body }) => {
      const r = await redeemInvitation(db, { token: tokenOf(body), userId: user.id });
      if (!r.alreadyRedeemed) audit(req, 'gym.invite.redeem', { user, msg: `${r.gymId} ${r.role}` });
      return r;
    },
  };

  const table = TEMPLATES.map(([method, path]) => ({ method, path, re: compile(path), key: `${method} ${path}` }));

  return {
    // The template key and parameters for a request, or null when no gym route matches.
    match(method, pathname) {
      for (const r of table) {
        if (r.method !== method) continue;
        const m = r.re.exec(pathname);
        if (m) return { key: r.key, params: { ...m.groups } };
      }
      return null;
    },
    async handle(req, res, { key, params }) {
      const user = await readSession(req);
      if (!user) return json(res, 401, { error: 'not signed in' });
      const body = req.method === 'GET' ? {} : await readBody(req);
      try {
        const principal = await resolvePrincipal(db, user.id);
        json(res, 200, await handlers[key]({ req, user, principal, params, body }));
      } catch (e) {
        const answer = errorAnswer(e);
        if (!answer) throw e;
        json(res, answer.status, answer.body);
      }
    },
  };
}
