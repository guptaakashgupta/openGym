/* Pending proposals die with the assignment they were sent under: a trainer who is reassigned,
   removed or leaves cannot have a plan accepted later, and a new trainer sends their own. Called
   inside the transaction that ends the assignment or membership (assignments.js, memberships.js),
   after the assignment rows, as the lock order there says. Imports nothing, to stay out of the
   module cycle between memberships, access and proposals. */
export async function invalidatePendingFor(client, { memberMembershipId, trainerMembershipId }) {
  await client.query(
    `UPDATE plan_proposal_versions SET status = 'invalidated', decided_at = now()
      WHERE status = 'pending' AND recipient_membership_id = $1 AND trainer_membership_id = $2`,
    [memberMembershipId, trainerMembershipId]);
}

export async function invalidatePendingOfMembership(client, membershipId) {
  await client.query(
    `UPDATE plan_proposal_versions SET status = 'invalidated', decided_at = now()
      WHERE status = 'pending' AND (recipient_membership_id = $1 OR trainer_membership_id = $1)`,
    [membershipId]);
}
